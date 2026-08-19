/**
 * export-logs.js — Export transkrip percakapan
 * ----------------------------------------------
 * Mengubah log JSONL jadi transkrip siap-analisa.
 *
 * PEMAKAIAN:
 *   node export-logs.js                       daftar semua chat yang punya log
 *   node export-logs.js --all                 export semua chat ke exports/
 *   node export-logs.js --jid 62895...        export satu chat
 *   node export-logs.js --all --format json   export sebagai JSON terstruktur
 *   node export-logs.js --all --since 2026-08-01 --until 2026-08-18
 *   node export-logs.js --all --merge         gabung semua chat jadi 1 file
 *
 * FORMAT:
 *   txt  (default) — gaya export WhatsApp: [13.29, 11/8/2026] Nama: pesan
 *   json           — terstruktur, lebih mudah dikonsumsi tools AI
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { listChats, readMessages } = require('./lib/chat-log');

const OPERATOR_LABEL = process.env.OPERATOR_LABEL || 'ITSM NAC BNI';
const EXPORT_DIR = process.env.EXPORT_DIR || 'exports';

// ---------- Parsing argumen ----------
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}
const opt = {
  all: args.includes('--all'),
  merge: args.includes('--merge'),
  jid: argVal('--jid'),
  format: argVal('--format') || 'txt',
  since: argVal('--since'),
  until: argVal('--until'),
};

// ---------- Format tanggal gaya WhatsApp Indonesia ----------
// Contoh: [13.29, 11/8/2026]
// Timezone dikunci lewat TZ_OFFSET_HOURS (default 7 = WIB) supaya hasilnya
// konsisten walau script dijalankan di server dengan timezone berbeda.
const TZ_OFFSET_HOURS = Number(process.env.TZ_OFFSET_HOURS || 7);

function lokal(ts) {
  return new Date((ts + TZ_OFFSET_HOURS * 3600) * 1000);
}

function waTimestamp(ts) {
  const d = lokal(ts);
  const jam = String(d.getUTCHours()).padStart(2, '0');
  const menit = String(d.getUTCMinutes()).padStart(2, '0');
  return `[${jam}.${menit}, ${d.getUTCDate()}/${d.getUTCMonth() + 1}/${d.getUTCFullYear()}]`;
}

/** Nomor jadi format tampilan: 628953459940991 -> +62 895-3459-40991 */
function formatNomor(n) {
  const s = String(n).replace(/[^0-9]/g, '');
  if (!s.startsWith('62')) return '+' + s;
  const sisa = s.slice(2);
  if (sisa.length < 9) return '+62 ' + sisa;
  return `+62 ${sisa.slice(0, 3)}-${sisa.slice(3, 7)}-${sisa.slice(7)}`;
}

function labelPengirim(m) {
  if (m.from_me) return OPERATOR_LABEL;
  if (m.sender_name) return m.sender_name;
  return formatNomor(m.sender);
}

function dalamRentang(m) {
  const d = lokal(m.ts);
  const tanggal = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  if (opt.since && tanggal < opt.since) return false;
  if (opt.until && tanggal > opt.until) return false;
  return true;
}

function keTeks(messages) {
  return messages.map((m) => {
    // Pesan multi-baris: baris lanjutan tanpa prefix, meniru export WhatsApp asli
    const isi = String(m.text).replace(/\n/g, '\n');
    return `${waTimestamp(m.ts)} ${labelPengirim(m)}: ${isi}`;
  }).join('\n');
}

function keJson(chat, messages) {
  return JSON.stringify({
    chat: {
      jid: chat.jid,
      nama: chat.name,
      nomor: chat.jid.includes('@g.us') ? null : formatNomor(chat.jid.split('@')[0]),
      tipe: chat.jid.includes('@g.us') ? 'grup' : 'personal',
      jumlah_pesan: messages.length,
      mulai: messages.length ? new Date(messages[0].ts * 1000).toISOString() : null,
      terakhir: messages.length ? new Date(messages[messages.length - 1].ts * 1000).toISOString() : null,
    },
    pesan: messages.map((m) => ({
      waktu: new Date(m.ts * 1000).toISOString(),
      dari: labelPengirim(m),
      peran: m.from_me ? 'operator' : 'user',
      tipe: m.type,
      isi: m.text,
    })),
  }, null, 2);
}

function namaFile(chat) {
  const base = chat.jid.replace('@s.whatsapp.net', '').replace('@g.us', '-grup');
  const nama = chat.name ? '-' + chat.name.replace(/[^0-9a-zA-Z]/g, '_').slice(0, 30) : '';
  return `${base}${nama}`;
}

// ---------- Main ----------
const chats = listChats();

if (chats.length === 0) {
  console.log('Belum ada log percakapan. Pastikan CHAT_LOG_ENABLED=true dan bot sudah menerima pesan.');
  process.exit(0);
}

// Mode daftar (tanpa argumen)
if (!opt.all && !opt.jid) {
  console.log('\nDaftar chat yang terekam:\n');
  chats.forEach((c, i) => {
    const terakhir = c.lastTs ? waTimestamp(c.lastTs).replace(/[\[\]]/g, '') : '-';
    const label = c.name || (c.jid.includes('@g.us') ? '(grup)' : formatNomor(c.jid.split('@')[0]));
    console.log(`${String(i + 1).padStart(2)}. ${label}`);
    console.log(`    JID: ${c.jid}`);
    console.log(`    ${c.count} pesan, terakhir ${terakhir}\n`);
  });
  console.log('Export: node export-logs.js --all');
  console.log('        node export-logs.js --jid <JID>');
  console.log('        node export-logs.js --all --format json --merge\n');
  process.exit(0);
}

if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

const target = opt.jid
  ? chats.filter((c) => c.jid.includes(opt.jid.replace(/[^0-9a-zA-Z]/g, '')))
  : chats;

if (target.length === 0) {
  console.log(`Tidak ada log untuk JID: ${opt.jid}`);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 10);
var totalPesan = 0;
const gabungan = [];

target.forEach((chat) => {
  const messages = readMessages(chat.path).filter(dalamRentang);
  if (messages.length === 0) return;
  totalPesan += messages.length;

  if (opt.merge) {
    gabungan.push({ chat, messages });
    return;
  }

  const ext = opt.format === 'json' ? 'json' : 'txt';
  const isi = opt.format === 'json' ? keJson(chat, messages) : keTeks(messages);
  const out = path.join(EXPORT_DIR, `${namaFile(chat)}-${stamp}.${ext}`);
  fs.writeFileSync(out, isi, 'utf8');
  console.log(`${out}  (${messages.length} pesan)`);
});

if (opt.merge && gabungan.length > 0) {
  const ext = opt.format === 'json' ? 'json' : 'txt';
  const out = path.join(EXPORT_DIR, `semua-chat-${stamp}.${ext}`);
  var isi;
  if (opt.format === 'json') {
    isi = JSON.stringify({
      diekspor: new Date().toISOString(),
      jumlah_chat: gabungan.length,
      jumlah_pesan: totalPesan,
      chats: gabungan.map((g) => JSON.parse(keJson(g.chat, g.messages))),
    }, null, 2);
  } else {
    isi = gabungan.map((g) => {
      const label = g.chat.name || formatNomor(g.chat.jid.split('@')[0]);
      return `===== ${label} (${g.chat.jid}) =====\n${keTeks(g.messages)}`;
    }).join('\n\n');
  }
  fs.writeFileSync(out, isi, 'utf8');
  console.log(`${out}  (${gabungan.length} chat, ${totalPesan} pesan)`);
}

console.log(`\nSelesai. Total ${totalPesan} pesan diekspor ke folder ${EXPORT_DIR}/`);
