/**
 * NAC Ticket Intake + Dashboard — Google Apps Script
 * ---------------------------------------------------
 * FUNGSI:
 *  1. Baca email intake dari bot WA (tiap 1 menit), parse field NAC,
 *     tulis tiket ke sheet "Activity Lists".
 *  2. Antrikan pesan keluar (Outbox): konfirmasi ke pengirim + forward
 *     tiket ke beberapa nomor WA engineer (maks 5, diatur di dashboard).
 *  3. Sediakan Web App: dashboard HTML (GET) untuk monitoring & CRUD
 *     nomor penerima, dan endpoint JSON (POST) untuk bot polling.
 *
 * ======================= SETUP =======================
 * 1. Sheet tujuan > Extensions > Apps Script. Paste Code.gs + Index.html.
 * 2. Project Settings > Script Properties:
 *      SHARED_SECRET = <string rahasia bebas>
 * 3. Run fungsi setup() sekali (bikin sheet Recipients & Outbox,
 *    label Gmail, trigger 1 menit). Terima permintaan izin.
 * 4. Deploy > New deployment > Web app
 *      Execute as: Me | Who has access: Anyone
 *    URL /exec dipakai: (a) buka di browser = dashboard,
 *                       (b) di .env bot sebagai GAS_WEBHOOK_URL.
 * 5. Tiap edit kode: Deploy > Manage deployments > edit > New version.
 *
 * CATATAN: interval trigger minimum Apps Script = 1 menit, jadi tiket &
 * forward sampai ~1-2 menit setelah user chat. Itu batas platform.
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
  if (!GmailApp.getUserLabelByName(PROCESSED_LABEL)) {
    GmailApp.createLabel(PROCESSED_LABEL);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processInbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processInbox').timeBased().everyMinutes(1).create();
  return 'Setup selesai.';
}

// ============ TRIGGER: baca & parse email ============
function processInbox() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    const label = GmailApp.getUserLabelByName(PROCESSED_LABEL)
      || GmailApp.createLabel(PROCESSED_LABEL);
    const threads = GmailApp.search(
      'subject:"' + SUBJECT_TAG + '" -label:' + PROCESSED_LABEL, 0, 20);

    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (msg) {
        const body = msg.getPlainBody();
        const meta = extractMeta(body);
        const fields = parseNacFields(body);

        if (!fields.requester || (!fields.mac && !fields.ip)) {
          if (meta.jid) {
            enqueue('CONFIRM', meta.jid, '',
              'Mohon lengkapi minimal *Name & NPP* dan *MAC Address* atau '
              + '*IP Address* agar tiket dapat kami proses.');
          }
          return;
        }

        const result = writeTicket(fields);
        const missing = Object.keys(fields).filter(function (k) { return !fields[k]; });

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
  const jid = (body.match(/JID\s*:\s*(\S+)/i) || [])[1] || null;
  const name = (body.match(/NAME\s*:\s*(.+)/i) || [])[1] || null;
  return { jid: jid, name: name ? name.trim() : null };
}

function parseNacFields(text) {
  const fields = {};
  Object.keys(NAC_FIELD_PATTERNS).forEach(function (key) {
    const m = text.match(NAC_FIELD_PATTERNS[key]);
    fields[key] = m ? m[1].trim() : null;
  });
  return fields;
}

function buildConfirmText(ticket, missing) {
  var t = 'Tiket Anda telah dibuat.\nNomor Tiket: ' + ticket + '\n';
  if (missing.length > 0) {
    const labels = missing.map(function (k) {
      return '- ' + (FIELD_LABELS[k] || k);
    }).join('\n');
    t += '\nData berikut belum lengkap, mohon dilengkapi agar penanganan '
      + 'lebih cepat:\n' + labels + '\n';
  }
  t += '\nTerima kasih, tim kami akan segera menindaklanjuti.';
  return t;
}

function writeTicket(fields) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Sheet "' + SHEET_NAME + '" tidak ditemukan');

  const EMPTY = '(belum diisi)';
  const f = function (v) { return (v && String(v).trim()) ? String(v).trim() : EMPTY; };

  const now = new Date();
  const nomor = Math.max(sheet.getLastRow() - 1, 0) + 1;
  const ticket = Utilities.formatDate(now, 'GMT+7', 'yyMMddHHmmss');
  const taskStarted = Utilities.formatDate(now, 'GMT+7', 'yyyy-MM-dd HH:mm');

  const problemIssue = f(fields.hostname) + ' dari Department ' + f(fields.department)
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(OUTBOX_SHEET) || ss.insertSheet(OUTBOX_SHEET);
  sh.appendRow([Utilities.getUuid(), new Date(), type, jid, ticket, message, 'PENDING']);
}

function enqueueForwards(result, fields, meta, missing) {
  const recipients = getActiveRecipients();
  if (recipients.length === 0) return;

  const g = function (k) { return fields[k] || '(belum diisi)'; };
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
  // Grup: dipakai apa adanya (format 1203...@g.us atau 62xxx-123456@g.us)
  if (isGroupId(tujuan)) return String(tujuan).trim();
  // Personal: normalisasi ke 62xxx@s.whatsapp.net
  var n = String(tujuan).replace(/[^0-9]/g, '');
  if (n.indexOf('0') === 0) n = '62' + n.slice(1);
  return n + '@s.whatsapp.net';
}

// ============ RECIPIENTS: CRUD ============
function getRecipientsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(RECIPIENTS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(RECIPIENTS_SHEET);
    sh.appendRow(['ID', 'Nama', 'Nomor', 'Aktif', 'Ditambahkan']);
  }
  return sh;
}

function getRecipients() {
  const sh = getRecipientsSheet();
  if (sh.getLastRow() < 2) return [];
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues();
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

// Normalisasi tujuan: grup dibiarkan apa adanya, nomor personal jadi 62xxx
function normalizeNomor(nomor) {
  var raw = String(nomor).trim();
  if (isGroupId(raw)) return raw;
  var n = raw.replace(/[^0-9]/g, '');
  if (n.indexOf('0') === 0) n = '62' + n.slice(1);
  if (n.indexOf('62') !== 0) n = '62' + n;
  return n;
}

function addRecipient(nama, nomor) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const list = getRecipients();
    if (list.length >= MAX_RECIPIENTS) {
      return { success: false, error: 'Maksimum ' + MAX_RECIPIENTS + ' penerima. Hapus salah satu dulu.' };
    }
    if (!nama || !String(nama).trim()) return { success: false, error: 'Nama wajib diisi' };
    const n = normalizeNomor(nomor);
    if (isGroupId(n)) {
      if (!/^[0-9A-Za-z\-]+@g\.us$/.test(n)) {
        return { success: false, error: 'ID grup tidak valid (harus berakhiran @g.us)' };
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getRecipientsSheet();
    const data = sh.getDataRange().getValues();
    const n = normalizeNomor(nomor);
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
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getRecipientsSheet();
    const data = sh.getDataRange().getValues();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  var stats = { total: 0, open: 0, closed: 0, today: 0 };
  var recent = [];

  if (sh && sh.getLastRow() > 1) {
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 17).getValues();
    const todayStr = Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd');
    stats.total = rows.length;
    rows.forEach(function (r) {
      const status = String(r[11] || '').toUpperCase();
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

  const ob = ss.getSheetByName(OUTBOX_SHEET);
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
    .setTitle('NAC Ticket Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ success: false, error: 'Payload bukan JSON valid' });
  }

  const secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  if (!secret || body.secret !== secret) {
    return json({ success: false, error: 'Unauthorized' });
  }

  if (body.action === 'pending') return json(getPendingOutbox());
  if (body.action === 'ack') return json(ackOutbox(body.id));
  return json({ success: false, error: 'Action tidak dikenal' });
}

function getPendingOutbox() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OUTBOX_SHEET);
  if (!sh || sh.getLastRow() < 2) return { success: true, items: [] };
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  const items = [];
  data.forEach(function (r) {
    if (String(r[6]) === 'PENDING') {
      items.push({ id: r[0], type: r[2], jid: r[3], ticket: r[4], message: r[5] });
    }
  });
  return { success: true, items: items };
}

function ackOutbox(id) {
  if (!id) return { success: false, error: 'ID kosong' };
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(OUTBOX_SHEET);
  const data = sh.getDataRange().getValues();
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
