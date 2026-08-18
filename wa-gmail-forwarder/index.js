/**
 * wa-gmail-forwarder
 * ------------------
 * Menghubungkan akun WhatsApp milik sendiri (via linked-device / QR, sama
 * seperti WhatsApp Web) menggunakan Baileys, lalu meneruskan pesan yang
 * cocok dengan kriteria filter ke Gmail lewat SMTP.
 *
 * PENTING:
 * - Ini pakai protokol tidak resmi (Baileys), bukan WhatsApp Business API.
 *   Hanya untuk akun yang lo miliki/kontrol sendiri. Jangan dipakai untuk
 *   memantau akun orang lain tanpa izin, dan jangan dipakai untuk spam.
 * - Simpan folder auth_info/ baik-baik — isinya adalah sesi login WhatsApp.
 *   Jangan pernah commit ke git publik.
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const nodemailer = require('nodemailer');
const pino = require('pino');

// ---------- Konfigurasi filter (dari .env) ----------
// Jalur forward-ke-Gmail generik. Ini TERPISAH dari jalur intake tiket NAC —
// form tiket sudah otomatis dikirim ke Gmail lewat NAC_TICKET_ENABLED.
// Set false kalau hanya ingin form tiket yang masuk email (menghindari dobel).
const GMAIL_FORWARD_ENABLED = (process.env.GMAIL_FORWARD_ENABLED || 'true').toLowerCase() === 'true';

const KEYWORDS = (process.env.FILTER_KEYWORDS || '')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);

const SENDERS = (process.env.FILTER_SENDERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const EXCLUDE_GROUPS = (process.env.EXCLUDE_GROUPS || 'true').toLowerCase() === 'true';

// ---------- Konfigurasi AI auto-reply (Kimi) ----------
const AI_ENABLED = (process.env.AI_AUTO_REPLY_ENABLED || 'false').toLowerCase() === 'true';
const AI_TRIGGER_KEYWORDS = (process.env.AI_TRIGGER_KEYWORDS || '')
  .split(',')
  .map((k) => k.trim().toLowerCase())
  .filter(Boolean);
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const AI_SYSTEM_PROMPT =
  process.env.AI_SYSTEM_PROMPT ||
  'Kamu adalah asisten yang membalas pesan WhatsApp dengan ramah, singkat, dan membantu. Jawab dalam Bahasa Indonesia kecuali ditanya dalam bahasa lain.';

// Cooldown sederhana per nomor, biar nggak boros biaya API kalau ada yang spam trigger
const AI_COOLDOWN_MS = Number(process.env.AI_COOLDOWN_SECONDS || 10) * 1000;
const lastAiReplyAt = new Map();

// ---------- Konfigurasi NAC ticket intake (parsing dilakukan di Apps Script) ----------
// Bot hanya: (1) deteksi format & forward chat mentah ke Gmail,
//            (2) polling antrian konfirmasi lalu balas ke pengirim WA.
const NAC_ENABLED = (process.env.NAC_TICKET_ENABLED || 'false').toLowerCase() === 'true';
const GAS_WEBHOOK_URL = process.env.GAS_WEBHOOK_URL;
const GAS_SHARED_SECRET = process.env.GAS_SHARED_SECRET;
const NAC_CONFIRM_REPLY = (process.env.NAC_CONFIRM_REPLY || 'true').toLowerCase() === 'true';
const NAC_INTAKE_EMAIL = process.env.NAC_INTAKE_EMAIL || process.env.GMAIL_USER;
const NAC_SUBJECT_TAG = process.env.NAC_SUBJECT_TAG || '[NAC-INTAKE]';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_SECONDS || 20) * 1000;

// Cukup deteksi penanda format (bukan parsing) buat mutusin apakah di-forward
function looksLikeNacIntake(text) {
  return /Name\s*&\s*NPP\s*:/i.test(text);
}

// Kirim email intake berisi META (JID pengirim) + isi chat MENTAH.
// Apps Script yang akan mem-parse isinya.
async function forwardNacRawEmail({ jid, name, text, timestamp }) {
  const uniqueId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const subject = `${NAC_SUBJECT_TAG} ${uniqueId}`;
  const body =
    `===WA-META===\n` +
    `JID: ${jid}\n` +
    `NAME: ${name || '-'}\n` +
    `TS: ${timestamp}\n` +
    `===MESSAGE===\n` +
    `${text}\n`;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: NAC_INTAKE_EMAIL,
    subject,
    text: body,
  });
}

// ---------- Setup Gmail transporter ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

async function sendToGmail({ from, chatName, text, timestamp }) {
  const subject = `WA: ${chatName || from}`;
  const body = [
    `Dari: ${from}`,
    `Chat: ${chatName || '-'}`,
    `Waktu: ${new Date(timestamp * 1000).toLocaleString('id-ID')}`,
    '',
    text,
  ].join('\n');

  try {
    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: process.env.MAIL_TO,
      subject,
      text: body,
    });
    console.log(`[MAIL] Terkirim: "${subject}"`);
  } catch (err) {
    console.error('[MAIL] Gagal kirim:', err.message);
  }
}

// ---------- Ekstrak teks dari berbagai tipe pesan WhatsApp ----------
function extractText(message) {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage?.caption) return `[Gambar] ${message.imageMessage.caption}`;
  if (message.videoMessage?.caption) return `[Video] ${message.videoMessage.caption}`;
  if (message.documentMessage?.caption) return `[Dokumen] ${message.documentMessage.caption}`;
  if (message.buttonsResponseMessage?.selectedDisplayText)
    return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  return null;
}

// ---------- Cek apakah pesan lolos kriteria filter (untuk forward ke Gmail) ----------
function matchesFilter({ text, senderNumber, isGroup }) {
  if (!GMAIL_FORWARD_ENABLED) return false;
  if (EXCLUDE_GROUPS && isGroup) return false;

  if (SENDERS.length > 0 && !SENDERS.some((s) => senderNumber.includes(s))) {
    return false;
  }

  if (KEYWORDS.length > 0) {
    const lower = (text || '').toLowerCase();
    if (!KEYWORDS.some((kw) => lower.includes(kw))) return false;
  }

  return true;
}

// ---------- Cek apakah pesan memicu AI auto-reply ----------
function matchesAiTrigger({ text, senderNumber, isGroup }) {
  if (!AI_ENABLED) return false;
  if (EXCLUDE_GROUPS && isGroup) return false;
  if (SENDERS.length > 0 && !SENDERS.some((s) => senderNumber.includes(s))) return false;

  // Wajib ada keyword trigger yang diset — biar nggak auto-reply ke semua orang tanpa sengaja
  if (AI_TRIGGER_KEYWORDS.length === 0) return false;
  const lower = (text || '').toLowerCase();
  return AI_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------- Panggil Kimi API buat generate balasan ----------
async function askKimi(userText) {
  const res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIMI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages: [
        { role: 'system', content: AI_SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Kimi API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

// ---------- Polling Outbox dari Apps Script ----------
// Apps Script menaruh antrian {id, type, jid, ticket, message} di sheet Outbox.
// type CONFIRM = balasan ke pengirim, type FORWARD = teruskan ke engineer.
// Isi pesan sudah dirakit di Apps Script, bot tinggal mengirim.
let pollingStarted = false;

async function pollOutboxOnce(sock) {
  const res = await fetch(GAS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pending', secret: GAS_SHARED_SECRET }),
  });
  const data = await res.json();
  if (!data.success || !Array.isArray(data.items)) return;

  for (const item of data.items) {
    if (!item.jid || !item.message) continue;
    // Kalau konfirmasi ke pengirim dimatikan, lewati yang tipe CONFIRM
    if (item.type === 'CONFIRM' && !NAC_CONFIRM_REPLY) continue;

    try {
      await sock.sendMessage(item.jid, { text: item.message });
      await fetch(GAS_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ack', id: item.id, secret: GAS_SHARED_SECRET }),
      });
      console.log(`[NAC] ${item.type} terkirim ke ${item.jid.split('@')[0]} (tiket ${item.ticket || '-'})`);
      // Jeda kecil antar pesan biar nggak dianggap spam oleh WhatsApp
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      console.error('[NAC] Gagal kirim pesan antrian:', err.message);
    }
  }
}

function startConfirmationPolling(sock) {
  if (pollingStarted) return; // biar nggak dobel saat reconnect
  if (!NAC_ENABLED || !GAS_WEBHOOK_URL || !GAS_SHARED_SECRET) return;
  pollingStarted = true;
  console.log(`[NAC] Polling outbox aktif tiap ${POLL_INTERVAL_MS / 1000} detik`);
  setInterval(() => {
    pollOutboxOnce(sock).catch((err) =>
      console.error('[NAC] Error polling:', err.message)
    );
  }, POLL_INTERVAL_MS);
}

// ---------- Main ----------
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // ganti 'debug' kalau mau lihat log detail
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR ini dengan WhatsApp > Perangkat Tertaut:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      console.log('[WA] Koneksi terputus.', loggedOut ? 'Logged out — hapus folder auth_info lalu scan ulang.' : 'Mencoba reconnect...');
      if (!loggedOut) start();
    } else if (connection === 'open') {
      console.log('[WA] Terhubung. Menunggu pesan masuk...');
      startConfirmationPolling(sock);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue; // skip pesan yang lo kirim sendiri

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const senderNumber = (msg.key.participant || remoteJid).split('@')[0];
      const text = extractText(msg.message);

      if (!text) continue; // skip tipe pesan yang belum di-handle (stiker, voice note, dll)

      const chatName = msg.pushName || senderNumber;

      if (matchesFilter({ text, senderNumber, isGroup })) {
        console.log(`[MATCH] ${chatName}: ${text}`);
        await sendToGmail({
          from: senderNumber,
          chatName,
          text,
          timestamp: msg.messageTimestamp,
        });
      }

      // Deteksi format NAC/ClearPass -> forward chat MENTAH ke Gmail.
      // Parsing & pembuatan tiket dilakukan di Apps Script (bukan di sini).
      // Balasan ke user dikirim belakangan lewat loop polling (lihat bawah).
      if (NAC_ENABLED && looksLikeNacIntake(text)) {
        try {
          await forwardNacRawEmail({
            jid: remoteJid,
            name: chatName,
            text,
            timestamp: msg.messageTimestamp,
          });
          console.log(`[NAC] Chat dari ${chatName} diforward ke Gmail untuk diproses Apps Script`);
        } catch (err) {
          console.error('[NAC] Gagal forward email:', err.message);
        }
      }

      if (matchesAiTrigger({ text, senderNumber, isGroup })) {
        const now = Date.now();
        const last = lastAiReplyAt.get(senderNumber) || 0;
        if (now - last < AI_COOLDOWN_MS) {
          console.log(`[AI] Skip (cooldown) dari ${chatName}`);
        } else {
          lastAiReplyAt.set(senderNumber, now);
          try {
            const aiReply = await askKimi(text);
            if (aiReply) {
              await sock.sendMessage(remoteJid, { text: aiReply });
              console.log(`[AI] Balas ke ${chatName}: ${aiReply.slice(0, 80)}${aiReply.length > 80 ? '...' : ''}`);
            }
          } catch (err) {
            console.error('[AI] Gagal dapat balasan:', err.message);
          }
        }
      }
    }
  });
}

start().catch((err) => console.error('[FATAL]', err));
