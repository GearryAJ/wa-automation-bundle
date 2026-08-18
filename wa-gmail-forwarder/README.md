# wa-gmail-forwarder

Forward pesan WhatsApp (akun sendiri) ke Gmail berdasarkan kriteria filter,
plus opsi AI auto-reply pakai Kimi (Moonshot AI) — pakai
[Baileys](https://github.com/WhiskeySockets/Baileys) (protokol WhatsApp Web) + Nodemailer.

⚠️ **Hanya untuk akun WhatsApp milik/kontrol sendiri.** Baileys tidak resmi
dari Meta — jangan dipakai untuk memantau akun orang lain tanpa izin atau
untuk pesan massal/spam (berisiko akun WhatsApp lo di-banned).

## Cara pakai

### 1. Install dependencies
```bash
npm install
```

### 2. Siapkan Gmail App Password
1. Aktifkan 2-Step Verification di akun Gmail: https://myaccount.google.com/security
2. Buat App Password: https://myaccount.google.com/apppasswords
3. Simpan 16 digit kode yang muncul.

### 3. Buat file `.env`
Copy dari contoh lalu isi:
```bash
cp .env.example .env
```
Edit `.env`:
- `GMAIL_USER` — email pengirim
- `GMAIL_APP_PASSWORD` — App Password dari langkah 2
- `MAIL_TO` — email tujuan
- `FILTER_KEYWORDS` — kata kunci yang mau ditangkap (kosongkan = semua pesan)
- `FILTER_SENDERS` — nomor tertentu saja (format `62xxxxxxxxxx`, kosongkan = semua nomor)
- `EXCLUDE_GROUPS` — `true` untuk skip pesan grup

### 4. Jalankan
```bash
npm start
```
Scan QR yang muncul di terminal pakai WhatsApp di HP:
**WhatsApp > Setelan > Perangkat Tertaut > Tautkan Perangkat**.

Setelah terhubung, sesi login tersimpan di folder `auth_info/` — jadi run
berikutnya nggak perlu scan ulang (kecuali logout / auth_info dihapus).

## Jalan terus-menerus (opsional)

Supaya tetap jalan di background / restart otomatis kalau crash, pakai
[pm2](https://pm2.keymetrics.io/):
```bash
npm install -g pm2
pm2 start index.js --name wa-gmail-forwarder
pm2 save
```

Atau kalau mau jalan di Android lewat **Termux**:
```bash
pkg install nodejs git
git clone <repo-lo>
cd wa-gmail-forwarder
npm install
npm start
```
Termux perlu wake-lock (`termux-wake-lock`) dan pengecualian battery
optimization biar service-nya nggak dimatikan sistem.

## AI Auto-Reply (Kimi)

Fitur opsional: kalau pesan masuk mengandung salah satu `AI_TRIGGER_KEYWORDS`,
bot akan kirim isi pesan itu ke Kimi API dan balas otomatis ke pengirim yang
sama.

1. Buat API key di https://platform.moonshot.ai (top-up minimal $1, billing
   pay-as-you-go per token).
2. Di `.env`, set `AI_AUTO_REPLY_ENABLED=true`, isi `KIMI_API_KEY`, dan isi
   `AI_TRIGGER_KEYWORDS` dengan kata kunci yang mau memicu balasan AI (misal
   `tanya,help,info`). **Field ini wajib diisi** — kalau kosong, AI auto-reply
   nggak akan aktif sama sekali, supaya nggak ada yang kebalas AI tanpa
   sengaja.
3. Restart `node index.js`. Kirim pesan test ke akun WA lo sendiri dari nomor
   lain, mengandung salah satu trigger keyword — AI akan otomatis membalas.

Ada cooldown per nomor (`AI_COOLDOWN_SECONDS`, default 10 detik) supaya biaya
API nggak membengkak kalau ada yang berulang kali kirim trigger dalam waktu
singkat. Nggak ada dependency baru yang perlu di-install — panggilan ke Kimi
API pakai `fetch` bawaan Node.js (v18+).

Biaya per balasan tergantung panjang pesan & model — model `kimi-k2.6` jauh
lebih murah daripada `kimi-k3`, cukup buat auto-reply chat sehari-hari.

## NAC/ClearPass Ticket Intake (parsing di Apps Script)

Alur: bot mendeteksi chat format NAC → forward isi chat MENTAH ke Gmail
(dengan JID pengirim disematkan) → Apps Script mem-parse email itu tiap 1
menit, menulis tiket ke sheet "Activity Lists", dan menaruh antrian
konfirmasi → bot polling antrian itu lalu membalas nomor tiket ke pengirim WA.

Parsing/validasi TIDAK lagi dilakukan di bot — semua logika field ada di
Apps Script (`gas-nac-ticket-intake/Code.gs`), jadi bisa diedit dari browser
tanpa menyentuh Termux.

**Catatan penting soal "real-time":** Apps Script tidak punya trigger email
seketika — interval trigger minimum 1 menit. Jadi konfirmasi ke user memakan
waktu ~1-2 menit (1 menit trigger + interval polling bot). Ini batas
platform Google, bukan bug.

**Setup Apps Script:** buka Sheet tujuan → Extensions → Apps Script → buat
dua file: `Code.gs` (paste isi Code.gs) dan `Index.html` (File > New > HTML
file, beri nama `Index`, paste isi Index.html) → set Script Property
`SHARED_SECRET` → jalankan fungsi `setup()` sekali (bikin sheet Recipients &
Outbox, label Gmail, trigger 1 menit) → Deploy as Web App (Execute as: Me,
Access: Anyone) → copy URL `.../exec`.

URL yang sama dipakai dua arah: **buka di browser = dashboard**, dan dipasang
di `.env` bot sebagai `GAS_WEBHOOK_URL` untuk polling antrian.

## Dashboard (Apps Script Web App)

Buka URL `.../exec` di browser. Isinya:

- **Statistik**: total tiket, open, closed, tiket hari ini, dan jumlah
  antrian pesan yang belum terkirim.
- **CRUD nomor penerima forward** (maks 5): tambah, edit nama/nomor,
  aktif/nonaktifkan tanpa menghapus, dan hapus. Nomor otomatis dinormalisasi
  (08xx / +62 / 62xx semuanya jadi 62xxx), dicek duplikat, dan tombol tambah
  otomatis nonaktif saat sudah 5 penerima.
- **Tabel 10 tiket terbaru** beserta statusnya.

## Forward tiket ke beberapa nomor

WhatsApp Business hanya bisa login 4 device, jadi forwarding dilakukan lewat
bot (bukan device tambahan). Setiap tiket baru, Apps Script merakit ringkasan
tiket dan mengantrikannya untuk tiap penerima berstatus aktif. Bot menarik
antrian itu lalu mengirim satu per satu dengan jeda 1,5 detik antar pesan
agar tidak terdeteksi spam.

Nomor penerima diubah lewat dashboard — tidak perlu menyentuh kode atau
restart bot; perubahan langsung berlaku untuk tiket berikutnya.

### Forward ke grup WhatsApp

Selain nomor personal, penerima bisa berupa **grup WhatsApp** — satu pesan
untuk semua engineer, dan mereka bisa langsung berdiskusi di thread yang sama.
Satu grup hanya menghabiskan 1 dari 5 slot penerima.

Syarat: akun bot harus sudah menjadi **anggota grup** tersebut.

Group ID tidak terlihat di aplikasi WhatsApp, jadi ambil dengan:
```
node list-groups.js
```
Script menampilkan semua grup beserta ID-nya (berakhiran `@g.us`). Salin ID
itu ke kolom nomor di dashboard — sistem otomatis mengenalinya sebagai grup
dan menandainya dengan badge "Grup".

Catatan: `EXCLUDE_GROUPS=true` di `.env` hanya mengatur pesan **masuk** (agar
chat grup tidak diproses sebagai tiket). Itu tidak menghalangi pengiriman
**keluar** ke grup.

**Setup bot** (`.env`):
```
NAC_TICKET_ENABLED=true
GAS_WEBHOOK_URL=<url .../exec>
GAS_SHARED_SECRET=<sama persis dengan Script Property>
NAC_INTAKE_EMAIL=<akun Gmail pemilik Apps Script; kosongkan = sama dgn GMAIL_USER>
```

Syarat minimal tiket dibuat: ada Name/NPP + (MAC atau IP). Field lain yang
kosong ditandai `(belum diisi)` di Sheets, dan bot memberi tahu user field
mana yang belum lengkap. Kalau minimal belum terpenuhi, bot minta user
melengkapi identitas perangkat dulu.

## Menambah kriteria filter

Logika filter ada di fungsi `matchesFilter()` dalam `index.js` — saat ini
support filter by keyword dan by nomor pengirim. Gampang ditambah, misalnya:
- Filter by tipe pesan (cuma teks, cuma yang ada dokumen, dll)
- Filter by jam tertentu
- Regex pattern (ganti `.includes()` dengan `RegExp.test()`)

## Keamanan

- Folder `auth_info/` adalah sesi login WhatsApp — perlakukan seperti password.
  Sudah otomatis di-gitignore.
- Jangan commit `.env` ke git publik (sudah di-gitignore juga).
- App Password Gmail cuma bisa dipakai buat SMTP, bukan login penuh ke akun —
  tapi tetap jangan disebar.
