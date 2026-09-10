/**
 * ticket-extractor.js — Ekstrak tiket terstruktur dari chat log JSONL
 * -------------------------------------------------------------------
 * Membaca semua file .jsonl di folder logs/, mengelompokkan pesan per user
 * (per JID), lalu mengidentifikasi setiap "sesi tiket" berdasarkan pola
 * pesan yang mengandung "Name & NPP:".
 *
 * Output: satu file JSON per user di folder tickets/ yang berisi array
 * tiket dengan field: requester, npp, hostname, mac_address, ip_address,
 * divisi, department, lokasi, lantai, kendala, solusi, timestamp, dll.
 *
 * Bisa dijalankan standalone:
 *   node lib/ticket-extractor.js
 *
 * Atau diimport sebagai modul:
 *   const { extractAllTickets, extractTicketsFromLog } = require('./lib/ticket-extractor');
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env.CHAT_LOG_DIR || 'logs';
const TICKET_DIR = process.env.TICKET_DIR || 'tickets';

// Regex patterns untuk parsing field dari form yang dikirim user
const FIELD_PATTERNS = {
  requester:  /Name\s*&\s*NPP\s*:\s*(.+)/i,
  hostname:   /Hostname\s*:\s*(.+)/i,
  mac_address:/MAC\s*Address\s*:\s*(.+)/i,
  ip_address: /IP\s*Address\s*:\s*(.+)/i,
  divisi:     /Divisi\s*:\s*(.+)/i,
  department: /Department\s*:\s*(.+)/i,
  lokasi:     /Lokasi\s*:\s*(.+)/i,
  lantai:     /Lantai\s*:\s*(.+)/i,
  kendala:    /Kendala\s*:\s*(.+)/i,
};

/**
 * Deteksi apakah sebuah pesan berisi form intake (ada "Name & NPP:")
 */
function isFormMessage(text) {
  return /Name\s*&\s*NPP\s*:/i.test(text || '');
}

/**
 * Parse field dari teks form yang dikirim user
 */
function parseFormFields(text) {
  const fields = {};
  for (const [key, pattern] of Object.entries(FIELD_PATTERNS)) {
    const m = (text || '').match(pattern);
    fields[key] = m ? m[1].trim() : null;
  }

  // Pisahkan nama dan NPP dari field requester
  if (fields.requester) {
    const parts = fields.requester.match(/^(.+?)\s+(\d{4,})$/);
    if (parts) {
      fields.nama = parts[1].trim();
      fields.npp = parts[2].trim();
    } else {
      fields.nama = fields.requester;
      fields.npp = null;
    }
  }

  return fields;
}

/**
 * Kumpulkan keluhan-keluhan user (pesan non-form yang mengandung konteks masalah)
 * dari pesan-pesan sebelum form submission dalam satu sesi
 */
function collectComplaints(messages, formIndex) {
  const complaints = [];
  // Lihat ke belakang dari form submission, cari pesan user yang bukan sapaan pendek
  const lookbackStart = Math.max(0, formIndex - 10); // maks 10 pesan ke belakang
  for (let i = lookbackStart; i < formIndex; i++) {
    const msg = messages[i];
    if (msg.from_me) continue;
    const text = (msg.text || '').trim();
    // Skip sapaan pendek / test messages
    if (text.length < 10) continue;
    if (/^(tes|test|p|halo|help|min|mas|mba|kak|gan)\s*$/i.test(text)) continue;
    complaints.push({
      timestamp: msg.iso,
      text: text,
    });
  }
  return complaints;
}

/**
 * Kumpulkan follow-up dari user setelah form submission & solusi bot
 * (misal: "clearpassnya not known")
 */
function collectFollowUps(messages, startIndex) {
  const followUps = [];
  for (let i = startIndex; i < messages.length; i++) {
    const msg = messages[i];
    // Berhenti kalau ketemu form baru
    if (!msg.from_me && isFormMessage(msg.text)) break;
    if (msg.from_me) continue;
    const text = (msg.text || '').trim();
    if (text.length < 5) continue;
    if (/^(tes|test|p|ok)\s*$/i.test(text)) continue;
    followUps.push({
      timestamp: msg.iso,
      text: text,
    });
  }
  return followUps;
}

/**
 * Cari respons bot (solusi) setelah form submission
 */
function findBotResponse(messages, formIndex) {
  // Cari pesan from_me=true terdekat setelah form
  for (let i = formIndex + 1; i < Math.min(formIndex + 5, messages.length); i++) {
    if (messages[i].from_me && messages[i].type === 'text') {
      return {
        timestamp: messages[i].iso,
        text: messages[i].text,
      };
    }
  }
  return null;
}

/**
 * Ekstrak semua tiket dari satu file JSONL log
 * @param {string} filePath - path ke file .jsonl
 * @returns {object} - { jid, chat_name, tickets: [...] }
 */
function extractTicketsFromLog(filePath) {
  if (!fs.existsSync(filePath)) return null;

  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  const messages = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);

  if (messages.length === 0) return null;

  // Metadata chat
  const firstUserMsg = messages.find((m) => !m.from_me);
  const jid = messages[0].jid;
  const chatName = firstUserMsg?.chat_name || firstUserMsg?.sender_name || jid;

  // Cari semua form submissions
  const tickets = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.from_me) continue;
    if (!isFormMessage(msg.text)) continue;

    const fields = parseFormFields(msg.text);
    const botResponse = findBotResponse(messages, i);
    const complaints = collectComplaints(messages, i);

    // Follow-ups dimulai setelah bot response (atau setelah form jika tidak ada response)
    const followUpStart = botResponse
      ? messages.indexOf(messages.find((m, idx) => idx > i && m.from_me)) + 1
      : i + 1;
    const followUps = collectFollowUps(messages, followUpStart);

    tickets.push({
      ticket_index: tickets.length + 1,
      timestamp: msg.iso,
      unix_ts: msg.ts,
      // Data dari form
      nama: fields.nama || null,
      npp: fields.npp || null,
      requester_raw: fields.requester || null,
      hostname: fields.hostname || null,
      mac_address: fields.mac_address || null,
      ip_address: fields.ip_address || null,
      divisi: fields.divisi || null,
      department: fields.department || null,
      lokasi: fields.lokasi || null,
      lantai: fields.lantai || null,
      kendala: fields.kendala || null,
      // Keluhan tambahan dari percakapan sebelum form
      keluhan_tambahan: complaints,
      // Solusi/respons dari bot
      solusi: botResponse ? botResponse.text : null,
      solusi_timestamp: botResponse ? botResponse.timestamp : null,
      // Follow-up setelah solusi
      follow_up: followUps,
      // Raw form message
      raw_form: msg.text,
    });
  }

  return {
    jid,
    chat_name: chatName,
    total_messages: messages.length,
    total_tickets: tickets.length,
    first_contact: messages[0].iso,
    last_contact: messages[messages.length - 1].iso,
    tickets,
  };
}

/**
 * Proses semua file log dan generate file JSON per user di folder tickets/
 * @returns {Array} - array of { file, jid, tickets_count }
 */
function extractAllTickets() {
  if (!fs.existsSync(LOG_DIR)) {
    console.log(`[TICKET] Folder log "${LOG_DIR}" tidak ditemukan.`);
    return [];
  }
  if (!fs.existsSync(TICKET_DIR)) {
    fs.mkdirSync(TICKET_DIR, { recursive: true });
  }

  const logFiles = fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl'));
  const results = [];

  for (const file of logFiles) {
    const filePath = path.join(LOG_DIR, file);
    const data = extractTicketsFromLog(filePath);
    if (!data || data.total_tickets === 0) {
      console.log(`[TICKET] ${file}: tidak ada form tiket ditemukan, skip.`);
      continue;
    }

    const outName = file.replace('.jsonl', '_tickets.json');
    const outPath = path.join(TICKET_DIR, outName);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[TICKET] ${file} → ${outName} (${data.total_tickets} tiket)`);
    results.push({
      file: outName,
      path: outPath,
      jid: data.jid,
      chat_name: data.chat_name,
      tickets_count: data.total_tickets,
    });
  }

  return results;
}

// Jalankan langsung kalau dipanggil sebagai script
if (require.main === module) {
  console.log('=== Ticket Extractor ===');
  console.log(`Log dir: ${path.resolve(LOG_DIR)}`);
  console.log(`Output dir: ${path.resolve(TICKET_DIR)}`);
  console.log('');
  const results = extractAllTickets();
  console.log('');
  if (results.length === 0) {
    console.log('Tidak ada tiket ditemukan di log manapun.');
  } else {
    console.log(`Total: ${results.length} file, ${results.reduce((s, r) => s + r.tickets_count, 0)} tiket.`);
  }
}

module.exports = {
  extractAllTickets,
  extractTicketsFromLog,
  parseFormFields,
  isFormMessage,
};
