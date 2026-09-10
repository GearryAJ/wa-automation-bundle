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
const fs = require('fs');
const path = require('path');
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const nodemailer = require('nodemailer');
const pino = require('pino');
const chatLog = require('./lib/chat-log');
const apiServer = require('./lib/server');

// ---------- Konfigurasi Auth & Auto Clean ----------
const AUTH_DIR = path.join(__dirname, 'auth_info');
const DELETE_AUTH_ON_EXIT = (process.env.DELETE_AUTH_ON_EXIT || 'false').toLowerCase() === 'true';

function cleanAuthFolder(reason = '') {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      if (currentSock) {
        try {
          currentSock.ev.removeAllListeners();
          currentSock.end?.();
        } catch (_) {}
      }
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          console.log(`[AUTH] Folder auth_info berhasil dihapus otomatis (${reason || 'clean'}).`);
          break;
        } catch (err) {
          if (attempt === 3) {
            console.error(`[AUTH] Gagal menghapus folder auth_info: ${err.message}`);
          } else {
            const waitTill = Date.now() + 300;
            while (Date.now() < waitTill) {}
          }
        }
      }
    }
  } catch (err) {
    console.error(`[AUTH] Error saat membersihkan auth_info: ${err.message}`);
  }
}

// ---------- Konfigurasi perekaman transkrip ----------
// Merekam SEMUA pesan tanpa filter keyword, dua arah, per chat.
const CHAT_LOG_ENABLED = (process.env.CHAT_LOG_ENABLED || 'true').toLowerCase() === 'true';
const CHAT_LOG_EXCLUDE_GROUPS = (process.env.CHAT_LOG_EXCLUDE_GROUPS || 'false').toLowerCase() === 'true';
const OPERATOR_LABEL = process.env.OPERATOR_LABEL || 'ITSM NAC BNI';

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
  'Kamu adalah Helpdesk IT Jaringan & NAC di Bank Negara Indonesia (BNI) yang ramah dan interaktif. Tugasmu membantu pegawai BNI yang terkendala akses Intranet. Kumpulkan data format: Name & NPP, Hostname, MAC Address, IP Address, Divisi, Department, Lokasi, Lantai, Kendala. Jika form sudah diisi, sampaikan bahwa data sudah diterima dan sedang dilakukan pengecekan oleh tim teknis.';

// Cooldown sederhana per nomor, biar nggak boros biaya API kalau ada yang spam trigger
const AI_COOLDOWN_MS = Number(process.env.AI_COOLDOWN_SECONDS || 10) * 1000;
const lastAiReplyAt = new Map();

// Jumlah pesan terakhir yang dikirim ke AI sebagai konteks percakapan
const AI_HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT || 20);

/**
 * Baca history chat dari file JSONL log, konversi jadi format messages Kimi.
 * Hanya ambil N pesan terakhir (AI_HISTORY_LIMIT) untuk hemat token.
 */
function loadChatHistory(jid) {
  try {
    const logFile = path.join(chatLog.LOG_DIR, chatLog.jidToFilename(jid));
    if (!fs.existsSync(logFile)) return [];
    const allMessages = chatLog.readMessages(logFile);
    // Ambil hanya pesan terakhir sesuai limit
    const recent = allMessages.slice(-AI_HISTORY_LIMIT);
    return recent.map((m) => ({
      role: m.from_me ? 'assistant' : 'user',
      content: m.text || '[non-text]',
    }));
  } catch (err) {
    console.error('[AI] Gagal baca history chat:', err.message);
    return [];
  }
}

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

// Kirim data intake langsung ke Apps Script via POST
async function postNacIntakeData({ jid, name, text }) {
  if (!GAS_WEBHOOK_URL) throw new Error('GAS_WEBHOOK_URL belum diset');
  const response = await fetch(GAS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'intake',
      secret: GAS_SHARED_SECRET,
      jid,
      name,
      text,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  if (!data.success) throw new Error(data.error || 'Unknown error');
  return data;
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
// Untuk keperluan transkrip, pesan media TANPA caption pun tetap dicatat
// sebagai penanda (misal "[Gambar]"), supaya alur percakapan tidak bolong.
function extractText(message) {
  if (!message) return null;
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  if (message.imageMessage) return message.imageMessage.caption
    ? `[Gambar] ${message.imageMessage.caption}` : '[Gambar]';
  if (message.videoMessage) return message.videoMessage.caption
    ? `[Video] ${message.videoMessage.caption}` : '[Video]';
  if (message.documentMessage) {
    const nama = message.documentMessage.fileName || 'dokumen';
    return message.documentMessage.caption
      ? `[Dokumen: ${nama}] ${message.documentMessage.caption}` : `[Dokumen: ${nama}]`;
  }
  if (message.audioMessage) {
    return message.audioMessage.ptt ? '[Pesan suara]' : '[Audio]';
  }
  if (message.stickerMessage) return '[Stiker]';
  if (message.contactMessage) {
    return `[Kontak: ${message.contactMessage.displayName || '-'}]`;
  }
  if (message.locationMessage) return '[Lokasi]';
  if (message.reactionMessage) {
    return `[Reaksi: ${message.reactionMessage.text || ''}]`;
  }
  if (message.buttonsResponseMessage?.selectedDisplayText)
    return message.buttonsResponseMessage.selectedDisplayText;
  if (message.listResponseMessage?.title) return message.listResponseMessage.title;
  return null;
}

// Tentukan jenis pesan untuk metadata log
function detectType(message) {
  if (!message) return 'unknown';
  if (message.conversation || message.extendedTextMessage) return 'text';
  if (message.imageMessage) return 'image';
  if (message.videoMessage) return 'video';
  if (message.documentMessage) return 'document';
  if (message.audioMessage) return message.audioMessage.ptt ? 'voice' : 'audio';
  if (message.stickerMessage) return 'sticker';
  if (message.contactMessage) return 'contact';
  if (message.locationMessage) return 'location';
  if (message.reactionMessage) return 'reaction';
  return 'other';
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

  // Jika keyword berisi '*', balas SEMUA pesan tanpa filter keyword
  if (AI_TRIGGER_KEYWORDS.includes('*')) return true;

  // Wajib ada keyword trigger yang diset — biar nggak auto-reply ke semua orang tanpa sengaja
  if (AI_TRIGGER_KEYWORDS.length === 0) return false;
  const lower = (text || '').toLowerCase();
  return AI_TRIGGER_KEYWORDS.some((kw) => lower.includes(kw));
}

// ---------- Panggil Kimi API buat generate balasan ----------
// Retry dengan exponential backoff untuk 429 (rate limit / engine overload).
// Kimi menghitung kuota dari (token request + max_tokens), jadi max_tokens
// sengaja dijaga kecil supaya tidak boros kuota di tier rendah.
const KIMI_MAX_RETRY = Number(process.env.KIMI_MAX_RETRY || 3);

async function askKimi(chatMessages, attempt = 0) {
  let res;
  try {
    res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KIMI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: KIMI_MODEL,
        messages: chatMessages,
        max_tokens: Number(process.env.KIMI_MAX_TOKENS || 500),
      }),
    });
  } catch (netErr) {
    if (attempt < KIMI_MAX_RETRY) {
      const waitMs = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
      console.log(`[AI] Gagal koneksi (${netErr.message}), coba lagi dalam ${Math.round(waitMs / 1000)}s (${attempt + 1}/${KIMI_MAX_RETRY})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      return askKimi(chatMessages, attempt + 1);
    }
    throw new Error(`Koneksi ke Kimi API gagal: ${netErr.cause?.message || netErr.message}`);
  }

  if (res.status === 429 && attempt < KIMI_MAX_RETRY) {
    // Hormati Retry-After kalau ada; kalau tidak, backoff 2^attempt detik + jitter
    const retryAfter = Number(res.headers.get('retry-after'));
    const waitMs = retryAfter
      ? retryAfter * 1000
      : Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 500);
    console.log(`[AI] Kena rate limit, tunggu ${Math.round(waitMs / 1000)}s lalu coba lagi (${attempt + 1}/${KIMI_MAX_RETRY})`);
    await new Promise((r) => setTimeout(r, waitMs));
    return askKimi(chatMessages, attempt + 1);
  }

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
let currentSock = null;
let pollingStarted = false;

async function pollOutboxOnce() {
  if (!currentSock) return;
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
      await currentSock.sendMessage(item.jid, { text: item.message });
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

function startConfirmationPolling() {
  if (pollingStarted) return; // biar nggak dobel saat reconnect
  if (!NAC_ENABLED || !GAS_WEBHOOK_URL || !GAS_SHARED_SECRET) return;
  pollingStarted = true;
  console.log(`[NAC] Polling outbox aktif tiap ${POLL_INTERVAL_MS / 1000} detik`);
  setInterval(() => {
    pollOutboxOnce().catch((err) =>
      console.error('[NAC] Error polling:', err.message)
    );
  }, POLL_INTERVAL_MS);
}

// ---------- Main ----------
let isReconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;

async function start() {
  if (currentSock?.ev) {
    try {
      currentSock.ev.removeAllListeners();
    } catch (_) {}
  }

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // ganti 'debug' kalau mau lihat log detail
  });

  currentSock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR ini dengan WhatsApp > Perangkat Tertaut:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      apiServer.emitStatusUpdate({ status: 'disconnected' });
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMsg = lastDisconnect?.error?.message || '';
      console.log(`[WA] Koneksi terputus (status: ${statusCode || 'unknown'}${errorMsg ? ', ' + errorMsg : ''}).`);

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log('[WA] Sesi telah logout / di-putus (cut manual) dari WhatsApp.');
        cleanAuthFolder('Sesi logout / di-cut manual');
        console.log('[WA] Folder auth_info telah otomatis dibersihkan. Silakan jalankan ulang untuk scan QR.');
        process.exit(0);
      }
      if (statusCode === DisconnectReason.connectionReplaced) {
        console.log('[WA] Sesi dibuka di tempat/perangkat lain (connectionReplaced). Reconnect dihentikan agar tidak terjadi loop.');
        return;
      }
      if (statusCode === DisconnectReason.badSession) {
        console.log('[WA] Sesi auth corrupt / tidak valid (badSession).');
        cleanAuthFolder('badSession');
        console.log('[WA] Folder auth_info telah otomatis dibersihkan. Silakan jalankan ulang untuk scan QR.');
        process.exit(0);
      }

      if (isReconnecting) return;
      isReconnecting = true;

      reconnectAttempts++;
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        console.error(`[WA] Gagal reconnect setelah ${MAX_RECONNECT_ATTEMPTS} kali percobaan. Berhenti untuk mencegah loop.`);
        process.exit(1);
      }

      const delayMs = Math.min(3000 * Math.pow(1.5, reconnectAttempts - 1), 20000);
      console.log(`[WA] Menunggu ${(delayMs / 1000).toFixed(1)} detik sebelum mencoba reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(() => {
        isReconnecting = false;
        start().catch((err) => console.error('[FATAL]', err));
      }, delayMs);
    } else if (connection === 'open') {
      apiServer.emitStatusUpdate({ status: 'connected' });
      reconnectAttempts = 0;
      isReconnecting = false;
      console.log('[WA] Terhubung. Menunggu pesan masuk...');
      startConfirmationPolling();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const remoteJid = msg.key.remoteJid || '';
      const isGroup = remoteJid.endsWith('@g.us');
      const fromMe = !!msg.key.fromMe;
      const senderNumber = fromMe
        ? (sock.user?.id || '').split(':')[0].split('@')[0]
        : (msg.key.participant || remoteJid).split('@')[0];
      const text = extractText(msg.message);

      if (!text) continue; // tipe pesan yang benar-benar tidak bisa direpresentasikan

      const chatName = fromMe
        ? (remoteJid.split('@')[0])
        : (msg.pushName || senderNumber);

      // ===== PEREKAMAN TRANSKRIP =====
      // Merekam SEMUA pesan tanpa filter keyword, dua arah (user & operator),
      // supaya transkrip percakapan utuh untuk dianalisa tools lain.
      if (CHAT_LOG_ENABLED) {
        if (!(CHAT_LOG_EXCLUDE_GROUPS && isGroup)) {
          try {
            const entry = {
              jid: remoteJid,
              chatName: fromMe ? null : (msg.pushName || null),
              sender: senderNumber,
              senderName: fromMe ? OPERATOR_LABEL : (msg.pushName || null),
              fromMe,
              text,
              type: detectType(msg.message),
              timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
            };
            
            if (entry.type === 'image' || entry.type === 'document') {
              try {
                // Gunakan downloadContentFromMessage sebagai fallback yang lebih low-level
                const msgType = entry.type === 'image' ? 'image' : 'document';
                const mediaMessage = msg.message.imageMessage || msg.message.documentMessage;
                
                if (mediaMessage) {
                  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                  const stream = await downloadContentFromMessage(mediaMessage, msgType);
                  let buffer = Buffer.from([]);
                  for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                  }
                  
                  const PUBLIC_MEDIA = path.join(__dirname, 'public', 'media');
                  if (!fs.existsSync(PUBLIC_MEDIA)) {
                    fs.mkdirSync(PUBLIC_MEDIA, { recursive: true });
                  }
                  const ext = entry.type === 'image' ? 'jpg' : (mediaMessage.fileName?.split('.').pop() || 'bin');
                  const filename = `${entry.timestamp}_${senderNumber}_${Date.now()}.${ext}`;
                  const filepath = path.join(PUBLIC_MEDIA, filename);
                  fs.writeFileSync(filepath, buffer);
                  entry.mediaUrl = `/media/${filename}`;
                }
              } catch (mediaErr) {
                console.error('[LOG] Gagal download media:', mediaErr.message);
                console.error(mediaErr.stack);
              }
            }
            chatLog.appendMessage(entry);
            apiServer.emitMessageReceived(entry);
          } catch (err) {
            console.error('[LOG] Gagal menulis transkrip:', err.message);
          }
        }
      }

      // Fitur di bawah ini hanya berlaku untuk pesan MASUK
      if (fromMe) continue;

      if (matchesFilter({ text, senderNumber, isGroup })) {
        console.log(`[MATCH] ${chatName}: ${text}`);
        await sendToGmail({
          from: senderNumber,
          chatName,
          text,
          timestamp: msg.messageTimestamp,
        });
      }

      // Deteksi format NAC/ClearPass -> POST langsung ke Apps Script v2
      // Apps Script akan mem-parse, buat tiket, dan langsung return response.
      if (NAC_ENABLED && looksLikeNacIntake(text)) {
        try {
          const result = await postNacIntakeData({
            jid: remoteJid,
            name: chatName,
            text,
          });
          console.log(`[NAC] Berhasil POST intake dari ${chatName}, Tiket: ${result.ticket || '-'}`);

          if (NAC_CONFIRM_REPLY && result.confirm_text) {
            await sock.sendMessage(remoteJid, { text: result.confirm_text }, { quoted: msg });
            
            if (CHAT_LOG_ENABLED) {
              try {
                chatLog.appendMessage({
                  jid: remoteJid,
                  chatName: msg.pushName || null,
                  sender: (sock.user?.id || '').split(':')[0].split('@')[0],
                  senderName: OPERATOR_LABEL,
                  fromMe: true,
                  text: result.confirm_text,
                  type: 'text',
                  timestamp: Math.floor(Date.now() / 1000),
                });
              } catch (logErr) {
                console.error('[LOG] Gagal catat balasan NAC:', logErr.message);
              }
            }
          }
        } catch (err) {
          console.error('[NAC] Gagal POST intake:', err.message);
          // Fallback balasan error jika gagal POST
          if (NAC_CONFIRM_REPLY) {
            await sock.sendMessage(remoteJid, { text: 'Mohon maaf, sistem pembuatan tiket sedang sibuk. Mohon ulangi beberapa saat lagi atau hubungi tim support.' }, { quoted: msg });
          }
        }
        continue; // Skip AI processing kalau sudah masuk flow NAC intake
      }

      if (matchesAiTrigger({ text, senderNumber, isGroup })) {
        const now = Date.now();
        const last = lastAiReplyAt.get(senderNumber) || 0;
        if (now - last < AI_COOLDOWN_MS) {
          console.log(`[AI] Skip (cooldown) dari ${chatName}`);
        } else {
          lastAiReplyAt.set(senderNumber, now);
          try {
            // Baca history percakapan dari log, lalu tambahkan pesan terbaru
            const history = loadChatHistory(remoteJid);
            const chatMessages = [
              { role: 'system', content: AI_SYSTEM_PROMPT },
              ...history,
              { role: 'user', content: text },
            ];
            // Deduplikasi: jika pesan terakhir di history sama dengan pesan terbaru, hapus duplikat
            if (history.length > 0 && history[history.length - 1].role === 'user' && history[history.length - 1].content === text) {
              chatMessages.splice(chatMessages.length - 1, 1);
            }
            const aiReply = await askKimi(chatMessages);
            if (aiReply) {
              // Balas dengan quoting pesan asal agar selalu terhubung di chat thread WA (termasuk LID)
              await sock.sendMessage(remoteJid, { text: aiReply }, { quoted: msg });
              console.log(`[AI] Balas ke ${chatName}: ${aiReply.slice(0, 80)}${aiReply.length > 80 ? '...' : ''}`);

              // Catat balasan AI ke file transkrip log
              if (CHAT_LOG_ENABLED) {
                try {
                  chatLog.appendMessage({
                    jid: remoteJid,
                    chatName: msg.pushName || null,
                    sender: (sock.user?.id || '').split(':')[0].split('@')[0],
                    senderName: OPERATOR_LABEL,
                    fromMe: true,
                    text: aiReply,
                    type: 'text',
                    timestamp: Math.floor(Date.now() / 1000),
                  });
                } catch (logErr) {
                  console.error('[LOG] Gagal catat balasan AI:', logErr.message);
                }
              }
            }
          } catch (err) {
            console.error('[AI] Gagal dapat balasan:', err.message);
          }
        }
      }
    }
  });
}

apiServer.initServer(process.env.DASHBOARD_API_PORT || 3001, async (jid, msg) => {
  if (currentSock) {
    return await currentSock.sendMessage(jid, msg);
  }
  throw new Error('WhatsApp not connected');
});

start().catch((err) => console.error('[FATAL]', err));

// Listener input terminal untuk cut manual secara interaktif (ketik 'cut', 'logout', atau 'clean' lalu Enter)
if (process.stdin.isTTY) {
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (data) => {
    const input = data.toString().trim().toLowerCase();
    if (input === 'cut' || input === 'logout' || input === 'clean') {
      console.log('\n[AUTH] Menerima perintah cut manual dari console...');
      cleanAuthFolder('Perintah cut/logout console');
      console.log('[WA] Selesai. Folder auth_info telah dibersihkan.');
      process.exit(0);
    }
  });
}

// Sinyal terminasi (Ctrl + C)
process.on('SIGINT', () => {
  console.log('\n[WA] Sinyal berhenti (Ctrl+C) diterima.');
  if (DELETE_AUTH_ON_EXIT) {
    cleanAuthFolder('Cut manual (SIGINT / Exit)');
  }
  process.exit(0);
});
