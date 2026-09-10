/**
 * NAC Ticket Intake v2 — Google Apps Script (Direct POST)
 * -------------------------------------------------------
 * PERUBAHAN dari v1:
 *   - Bot mengirim data tiket langsung via HTTP POST (action: 'intake'),
 *     BUKAN lewat email SMTP lagi. Ini menghilangkan latensi 1-2 menit.
 *   - Response langsung dikembalikan ke bot berisi nomor tiket, sehingga
 *     bot bisa langsung balas ke user tanpa perlu Outbox untuk konfirmasi.
 *   - Outbox tetap dipakai untuk FORWARD ke engineer (multi-recipient async).
 *
 * FUNGSI:
 *  1. Terima POST dari bot WA (action: 'intake'), parse field, tulis tiket
 *     ke sheet "Activity Lists", return nomor tiket langsung.
 *  2. Antrikan forward tiket ke engineer di sheet "Outbox".
 *  3. Sediakan endpoint polling Outbox (action: 'pending'/'ack') untuk bot.
 *  4. Dashboard HTML (GET) untuk monitoring.
 *
 * ======================= SETUP =======================
 * 1. Sheet tujuan > Extensions > Apps Script. Paste Code_v2.gs + Index.html.
 * 2. Project Settings > Script Properties:
 *      SHARED_SECRET = <string rahasia bebas>
 * 3. Run fungsi setup() sekali.
 * 4. Deploy > New deployment > Web app
 *      Execute as: Me | Who has access: Anyone
 */

const SHEET_NAME = 'Activity Lists';
const RECIPIENTS_SHEET = 'Recipients';
const OUTBOX_SHEET = 'Outbox';
const PROCESSED_LABEL = 'nac-processed';
const SUBJECT_TAG = '[NAC-INTAKE]';
const MAX_RECIPIENTS = 5;

const MONTHS_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const NAC_FIELD_PATTERNS = {
  requester: /Name\s*&\s*NPP\s*:\s*(.+)/i,
  hostname: /Hostname\s*:\s*(.+)/i,
  mac: /MAC\s*Address\s*:\s*(.+)/i,
  ip: /IP\s*Address\s*:\s*(.+)/i,
  divisi: /Divisi\s*:\s*(.+)/i,
  department: /Department\s*:\s*(.+)/i,
  lokasi: /Lokasi\s*:\s*(.+)/i,
  lantai: /Lantai\s*:\s*(.+)/i,
  kendala: /Kendala\s*:\s*(.+)/i,
};

const FIELD_LABELS = {
  requester: 'Name & NPP', hostname: 'Hostname', mac: 'MAC Address',
  ip: 'IP Address', divisi: 'Divisi', department: 'Department',
  lokasi: 'Lokasi', lantai: 'Lantai', kendala: 'Kendala',
};

// ==================== SETUP ====================
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(RECIPIENTS_SHEET)) {
    const sh = ss.insertSheet(RECIPIENTS_SHEET);
    sh.appendRow(['ID', 'Nama', 'Nomor', 'Aktif', 'Ditambahkan']);
    sh.getRange(1, 1, 1, 5).setFontWeight('bold');
  }
  if (!ss.getSheetByName(OUTBOX_SHEET)) {
    const sh = ss.insertSheet(OUTBOX_SHEET);
    sh.appendRow(['ID', 'Timestamp', 'Tipe', 'JID', 'Ticket', 'Pesan', 'Status']);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  }
  // Label Gmail tetap dibuat untuk backward compatibility dengan v1
  if (!GmailApp.getUserLabelByName(PROCESSED_LABEL)) {
    GmailApp.createLabel(PROCESSED_LABEL);
  }

  // OPSIONAL: trigger processInbox untuk backward compat dengan v1 (email).
  // Di v2 jalur utama adalah direct POST, tapi kalau masih ada bot v1 yang
  // mengirim via email, trigger ini tetap memproses email tersebut.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(1).create();
  return 'Setup selesai (v2).';
}

// ============ INTAKE: langsung dari bot via POST ============
// Bot mengirim: { action: 'intake', secret: '...', jid: '...', name: '...', text: '...' }
// Return: { success: true, ticket: '...', missing: [...] }
function handleIntake(body) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return { success: false, error: 'Server busy, coba lagi.' };
  }

  try {
    var text = body.text || '';
    var jid = body.jid || null;
    var name = body.name || null;

    var fields = parseNacFields(text);

    // Validasi minimum: harus ada requester + (MAC atau IP)
    if (!fields.requester || (!fields.mac && !fields.ip)) {
      var missingRequired = [];
      if (!fields.requester) missingRequired.push('Name & NPP');
      if (!fields.mac && !fields.ip) missingRequired.push('MAC Address atau IP Address');
      return {
        success: false,
        error: 'Data tidak lengkap',
        missing: missingRequired,
        message: 'Mohon lengkapi minimal *Name & NPP* dan *MAC Address* atau '
          + '*IP Address* agar tiket dapat diproses.',
      };
    }

    var result = writeTicket(fields);
    var missing = Object.keys(fields).filter(function (k) { return !fields[k]; });

    // Antrikan forward ke engineer (tetap async via Outbox)
    enqueueForwards(result, fields, { jid: jid, name: name }, missing);

    return {
      success: true,
      ticket: result.ticket,
      nomor: result.nomor,
      missing: missing.map(function (k) { return FIELD_LABELS[k] || k; }),
      confirm_text: buildConfirmText(result.ticket, missing),
    };
  } finally {
    lock.releaseLock();
  }
}

// ============ BACKWARD COMPAT: baca & parse email (dari v1) ============
function processInbox() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var label = GmailApp.getUserLabelByName(PROCESSED_LABEL)
      || GmailApp.createLabel(PROCESSED_LABEL);
    var threads = GmailApp.search(
      'subject:"' + SUBJECT_TAG + '" -label:' + PROCESSED_LABEL, 0, 20);

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        var body = msg.getPlainBody();
        var meta = extractMeta(body);
        var fields = parseNacFields(body);

        if (!fields.requester || (!fields.mac && !fields.ip)) {
          if (meta.jid) {
            enqueue('CONFIRM', meta.jid, '',
              'Mohon lengkapi minimal *Name & NPP* dan *MAC Address* atau '
              + '*IP Address* agar tiket dapat kami proses.');
          }
          return;
        }

        var result = writeTicket(fields);
        var missing = Object.keys(fields).filter(function (k) { return !fields[k]; });

        if (meta.jid) {
          enqueue('CONFIRM', meta.jid, result.ticket,
            buildConfirmText(result.ticket, missing));
        }
        enqueueForwards(result, fields, meta, missing);
      });
      thread.addLabel(label);
      thread.markRead();
    });
  } finally {
    lock.releaseLock();
  }
}

function extractMeta(body) {
  var jid = (body.match(/JID\s*:\s*(\S+)/i) || [])[1] || null;
  var name = (body.match(/NAME\s*:\s*(.+)/i) || [])[1] || null;
  return { jid: jid, name: name ? name.trim() : null };
}

function parseNacFields(text) {
  var fields = {};
  Object.keys(NAC_FIELD_PATTERNS).forEach(function (key) {
    var m = text.match(NAC_FIELD_PATTERNS[key]);
    fields[key] = m ? m[1].trim() : null;
  });
  return fields;
}

function buildConfirmText(ticket, missing) {
  var t = 'Tiket Anda telah dibuat ✅\nNomor Tiket: *' + ticket + '*\n';
  if (missing.length > 0) {
    var labels = missing.map(function (k) {
      return '- ' + (FIELD_LABELS[k] || k);
    }).join('\n');
    t += '\nData berikut belum lengkap, mohon dilengkapi agar penanganan '
      + 'lebih cepat:\n' + labels + '\n';
  }
  t += '\nTerima kasih, tim kami akan segera menindaklanjuti. 🙏';
  return t;
}

function writeTicket(fields) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" tidak ditemukan');

  var EMPTY = '(belum diisi)';
  var f = function (v) { return (v && String(v).trim()) ? String(v).trim() : EMPTY; };

  var now = new Date();
  var nomor = Math.max(sheet.getLastRow() - 1, 0) + 1;
  var ticket = Utilities.formatDate(now, 'GMT+7', 'yyMMddHHmmss');
  var taskStarted = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd HH:mm');

  var problemIssue = f(fields.hostname) + ' dari Department ' + f(fields.department)
    + ' Divisi ' + f(fields.divisi) + ' MAC Address ' + f(fields.mac)
    + ' IP Address ' + f(fields.ip) + ' terkendala ' + f(fields.kendala);

  sheet.appendRow([
    nomor, 'WhatsApp', 'Problem', f(fields.requester), MONTHS_ID[now.getMonth()],
    now.getFullYear(), problemIssue, '', taskStarted, '', '', 'OPEN', '', '',
    ticket, f(fields.lokasi), f(fields.lantai),
  ]);

  return { ticket: ticket, nomor: nomor };
}

// ============ OUTBOX: antrian pesan keluar ============
function enqueue(type, jid, ticket, message) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(OUTBOX_SHEET) || ss.insertSheet(OUTBOX_SHEET);
  sh.appendRow([Utilities.getUuid(), new Date(), type, jid, ticket, message, 'PENDING']);
}

function enqueueForwards(result, fields, meta, missing) {
  var recipients = getActiveRecipients();
  if (recipients.length === 0) return;

  var g = function (k) { return fields[k] || '(belum diisi)'; };
  var text = '*TIKET BARU - NAC/ClearPass*\n'
    + 'No. Tiket: ' + result.ticket + '\n'
    + 'Requester: ' + g('requester') + '\n'
    + 'Hostname: ' + g('hostname') + '\n'
    + 'MAC: ' + g('mac') + '\n'
    + 'IP: ' + g('ip') + '\n'
    + 'Divisi: ' + g('divisi') + ' | Dept: ' + g('department') + '\n'
    + 'Lokasi: ' + g('lokasi') + ' Lt. ' + g('lantai') + '\n'
    + 'Kendala: ' + g('kendala') + '\n';
  if (meta.jid) text += 'Kontak WA: ' + String(meta.jid).split('@')[0] + '\n';
  if (missing.length > 0) {
    text += '\n_Belum lengkap: ' + missing.map(function (k) {
      return FIELD_LABELS[k] || k;
    }).join(', ') + '_';
  }

  recipients.forEach(function (r) {
    enqueue('FORWARD', toJid(r.nomor), result.ticket, text);
  });
}

// Deteksi apakah input berupa ID grup (bukan nomor personal)
function isGroupId(v) {
  return String(v).indexOf('@g.us') !== -1;
}

function toJid(tujuan) {
  if (isGroupId(tujuan)) return String(tujuan).trim();
  var n = String(tujuan).replace(/[^0-9]/g, '');
  if (n.indexOf('0') === 0) n = '62' + n.slice(1);
  return n + '@s.whatsapp.net';
}

// ============ RECIPIENTS: CRUD ============
function getRecipientsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(RECIPIENTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECIPIENTS_SHEET);
    sh.appendRow(['ID', 'Nama', 'Nomor', 'Aktif', 'Ditambahkan']);
  }
  return sh;
}

function getRecipients() {
  var sh = getRecipientsSheet();
  if (sh.getLastRow() < 2) return [];
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
  return data.map(function (r) {
    return {
      id: r[0], nama: r[1], nomor: String(r[2]),
      aktif: r[3] === true || String(r[3]).toUpperCase() === 'TRUE',
      ditambahkan: r[4] ? Utilities.formatDate(new Date(r[4]), 'GMT+7', 'yyyy-MM-dd HH:mm') : '',
    };
  });
}

function getActiveRecipients() {
  return getRecipients().filter(function (r) { return r.aktif; });
}

function normalizeNomor(nomor) {
  var raw = String(nomor).trim();
  if (isGroupId(raw)) return raw;
  var n = raw.replace(/[^0-9]/g, '');
  if (n.indexOf('0') === 0) n = '62' + n.slice(1);
  if (n.indexOf('62') !== 0) n = '62' + n;
  return n;
}

function addRecipient(nama, nomor) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var list = getRecipients();
    if (list.length >= MAX_RECIPIENTS) {
      return { success: false, error: 'Maksimum ' + MAX_RECIPIENTS + ' penerima.' };
    }
    if (!nama || !String(nama).trim()) return { success: false, error: 'Nama wajib diisi' };
    var n = normalizeNomor(nomor);
    if (isGroupId(n)) {
      if (!/^[0-9A-Za-z\-]+@g\.us$/.test(n)) {
        return { success: false, error: 'ID grup tidak valid' };
      }
    } else if (n.length < 10 || n.length > 15) {
      return { success: false, error: 'Nomor tidak valid' };
    }
    if (list.some(function (r) { return normalizeNomor(r.nomor) === n; })) {
      return { success: false, error: 'Nomor sudah terdaftar' };
    }
    getRecipientsSheet().appendRow([Utilities.getUuid(), String(nama).trim(), n, true, new Date()]);
    return { success: true, recipients: getRecipients() };
  } finally {
    lock.releaseLock();
  }
}

function updateRecipient(id, nama, nomor, aktif) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = getRecipientsSheet();
    var data = sh.getDataRange().getValues();
    var n = normalizeNomor(nomor);
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        for (var j = 1; j < data.length; j++) {
          if (j !== i && normalizeNomor(data[j][2]) === n) {
            return { success: false, error: 'Nomor sudah dipakai penerima lain' };
          }
        }
        sh.getRange(i + 1, 2).setValue(String(nama).trim());
        sh.getRange(i + 1, 3).setValue(n);
        sh.getRange(i + 1, 4).setValue(aktif === true);
        return { success: true, recipients: getRecipients() };
      }
    }
    return { success: false, error: 'Penerima tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

function deleteRecipient(id) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = getRecipientsSheet();
    var data = sh.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        sh.deleteRow(i + 1);
        return { success: true, recipients: getRecipients() };
      }
    }
    return { success: false, error: 'Penerima tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

// ============ DASHBOARD DATA ============
function getDashboardData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  var stats = { total: 0, open: 0, closed: 0, today: 0 };
  var recent = [];

  if (sh && sh.getLastRow() > 1) {
    var rows = sh.getRange(2, 1, sh.getLastRow() - 1, 17).getValues();
    var todayStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
    stats.total = rows.length;
    rows.forEach(function (r) {
      var status = String(r[11] || '').toUpperCase();
      if (status === 'CLOSED') stats.closed++; else stats.open++;
      if (String(r[8] || '').indexOf(todayStr) === 0) stats.today++;
    });
    recent = rows.slice(-10).reverse().map(function (r) {
      return {
        no: r[0], requester: r[3], problem: r[6], started: String(r[8] || ''),
        status: String(r[11] || 'OPEN'), ticket: r[14], site: r[15], floor: r[16],
      };
    });
  }

  var ob = ss.getSheetByName(OUTBOX_SHEET);
  var outbox = { pending: 0, sent: 0 };
  if (ob && ob.getLastRow() > 1) {
    ob.getRange(2, 7, ob.getLastRow() - 1, 1).getValues().forEach(function (r) {
      if (String(r[0]) === 'PENDING') outbox.pending++; else outbox.sent++;
    });
  }

  return {
    stats: stats, recent: recent, outbox: outbox,
    recipients: getRecipients(), maxRecipients: MAX_RECIPIENTS,
  };
}

// ============ WEB APP ============
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('NAC Ticket Dashboard v2')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ success: false, error: 'Payload bukan JSON valid' });
  }

  var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || body.secret !== secret) {
    return json({ success: false, error: 'Unauthorized' });
  }

  // === v2: action 'intake' — direct ticket creation ===
  if (body.action === 'intake') return json(handleIntake(body));

  // === existing actions ===
  if (body.action === 'pending') return json(getPendingOutbox());
  if (body.action === 'ack') return json(ackOutbox(body.id));
  return json({ success: false, error: 'Action tidak dikenal' });
}

function getPendingOutbox() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OUTBOX_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, items: [] };
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  var items = [];
  data.forEach(function (r) {
    if (String(r[6]) === 'PENDING') {
      items.push({ id: r[0], type: r[2], jid: r[3], ticket: r[4], message: r[5] });
    }
  });
  return { success: true, items: items };
}

function ackOutbox(id) {
  if (!id) return { success: false, error: 'ID kosong' };
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OUTBOX_SHEET);
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === id) {
      sh.getRange(i + 1, 7).setValue('SENT');
      return { success: true };
    }
  }
  return { success: false, error: 'ID tidak ditemukan' };
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
