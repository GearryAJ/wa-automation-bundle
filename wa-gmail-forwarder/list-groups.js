/**
 * list-groups.js — Menampilkan daftar grup WhatsApp beserta ID-nya
 * -----------------------------------------------------------------
 * Group ID (JID) tidak terlihat di aplikasi WhatsApp, jadi pakai script ini
 * untuk mengambilnya. ID inilah yang dimasukkan ke dashboard sebagai
 * penerima forward.
 *
 * CARA PAKAI:
 *   node list-groups.js
 *
 * Syarat: sudah pernah scan QR (folder auth_info/ ada), dan akun bot sudah
 * menjadi anggota grup yang dituju.
 *
 * Script berhenti sendiri setelah menampilkan daftar.
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    if (update.connection !== 'open') return;

    console.log('\nMengambil daftar grup...\n');
    try {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups);

      if (list.length === 0) {
        console.log('Tidak ada grup. Pastikan akun bot sudah menjadi anggota grup.');
      } else {
        list.forEach((g, i) => {
          console.log(`${i + 1}. ${g.subject}`);
          console.log(`   ID: ${g.id}`);
          console.log(`   Anggota: ${g.participants ? g.participants.length : '?'}\n`);
        });
        console.log('Salin baris "ID" (yang berakhiran @g.us) ke kolom Nomor di dashboard.\n');
      }
    } catch (err) {
      console.error('Gagal mengambil daftar grup:', err.message);
    }

    await sock.end();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
