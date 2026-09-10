/**
 * chat-log.js — Perekam percakapan WhatsApp per chat
 * ----------------------------------------------------
 * Menyimpan SETIAP pesan (masuk maupun keluar) ke file JSONL, satu file per
 * chat. Format JSONL dipilih karena:
 *   - append murah & aman (tidak perlu baca-tulis ulang seluruh file)
 *   - satu baris = satu pesan, gampang di-stream ke tools analisa AI
 *   - tahan crash: file rusak di tengah tidak merusak baris sebelumnya
 *
 * Struktur folder:
 *   logs/6281234567890.jsonl        (chat personal)
 *   logs/120363012345-g.jsonl       (grup)
 *
 * Untuk menghasilkan transkrip gaya export WhatsApp, pakai export-logs.js
 */

const fs = require('fs');
const path = require('path');
const ticketExtractor = require('./ticket-extractor');

const LOG_DIR = process.env.CHAT_LOG_DIR || 'logs';

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

/** Ubah JID jadi nama file yang aman */
function jidToFilename(jid) {
  return String(jid)
    .replace('@s.whatsapp.net', '')
    .replace('@g.us', '-g')
    .replace(/[^0-9a-zA-Z\-_]/g, '_') + '.jsonl';
}

/**
 * Catat satu pesan.
 * @param {object} entry
 * @param {string} entry.jid        JID chat (bukan pengirim)
 * @param {string} entry.chatName   Nama chat/kontak bila ada
 * @param {string} entry.sender     Nomor/ID pengirim
 * @param {string} entry.senderName Nama tampilan pengirim
 * @param {boolean} entry.fromMe    true kalau dikirim dari akun bot/operator
 * @param {string} entry.text       Isi pesan (sudah diekstrak)
 * @param {string} entry.type       Jenis pesan: text, image, document, dll
 * @param {number} entry.timestamp  Unix seconds
 */
function appendMessage(entry) {
  ensureDir();
  const file = path.join(LOG_DIR, jidToFilename(entry.jid));
  const record = {
    ts: entry.timestamp,
    iso: new Date(entry.timestamp * 1000).toISOString(),
    jid: entry.jid,
    chat_name: entry.chatName || null,
    sender: entry.sender,
    sender_name: entry.senderName || null,
    from_me: !!entry.fromMe,
    type: entry.type || 'text',
    text: entry.text,
    media_url: entry.mediaUrl || null,
  };
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');

  // Auto-update file JSON tiket tiap ada chat baru masuk/keluar dari nomor ini
  try {
    const data = ticketExtractor.extractTicketsFromLog(file);
    if (data && data.total_tickets > 0) {
      const TICKET_DIR = process.env.TICKET_DIR || 'tickets';
      if (!fs.existsSync(TICKET_DIR)) fs.mkdirSync(TICKET_DIR, { recursive: true });
      const outPath = path.join(TICKET_DIR, jidToFilename(entry.jid).replace('.jsonl', '_tickets.json'));
      fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    }
  } catch (err) {
    console.error('[LOG] Gagal auto-update JSON tiket:', err.message);
  }

  return file;
}

/** Daftar semua chat yang punya log */
function listChats() {
  ensureDir();
  return fs.readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const full = path.join(LOG_DIR, f);
      const lines = fs.readFileSync(full, 'utf8').trim().split('\n').filter(Boolean);
      var first = null, last = null;
      try { first = JSON.parse(lines[0]); } catch (e) {}
      try { last = JSON.parse(lines[lines.length - 1]); } catch (e) {}
      return {
        file: f,
        path: full,
        jid: last ? last.jid : f.replace('.jsonl', ''),
        name: (last && last.chat_name) || (first && first.chat_name) || null,
        count: lines.length,
        firstTs: first ? first.ts : null,
        lastTs: last ? last.ts : null,
      };
    })
    .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
}

/** Baca semua pesan dari satu file log */
function readMessages(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean);
}

module.exports = { appendMessage, listChats, readMessages, jidToFilename, LOG_DIR };
