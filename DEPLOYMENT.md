# Panduan Deployment — WA NAC Ticket Automation

Panduan lengkap dari nol sampai sistem jalan. Ikuti berurutan.

**Arsitektur singkat:**
```
Chat WA user
   -> Bot (Termux/Node.js) deteksi format, forward mentah ke Gmail
   -> Apps Script baca email tiap 1 menit, parse field
   -> Tulis tiket ke sheet "Activity Lists"
   -> Antrikan pesan keluar di sheet "Outbox"
   -> Bot polling Outbox tiap 20 detik
   -> Kirim konfirmasi ke pelapor + forward ke engineer (maks 5 nomor)
```

**Latensi normal:** ~1-2 menit dari user chat sampai dapat balasan. Ini batas
Apps Script (trigger minimum 1 menit), bukan bug.

---

# BAGIAN A — Persiapan Akun Google

## A1. Siapkan Google Sheet
1. Buat/buka Google Sheet yang akan jadi database.
2. Pastikan ada tab bernama persis **`Activity Lists`** (case-sensitive,
   spasi tunggal).
3. Baris 1 = header dengan urutan kolom:
   `No. | Source | Type | Requester | Period | Tahun | Problem/Issue | Action |
   Task Started | Task Finished | Resolution Time | Status | Engineer |
   Remarks | Ticket | Site | Floor`

> Urutan kolom ini dipakai kode saat menulis baris. Kalau urutannya diubah,
> data akan masuk ke kolom yang salah.

## A2. Buat Gmail App Password
1. Aktifkan 2-Step Verification: https://myaccount.google.com/security
2. Buka https://myaccount.google.com/apppasswords
3. Buat App Password baru, simpan 16 digit yang muncul.

> **Penting:** akun Gmail ini harus **sama** dengan akun pemilik Google Sheet
> di langkah A1. Apps Script akan membaca inbox akun tersebut — kalau beda
> akun, email intake tidak akan pernah terbaca.

---

# BAGIAN B — Deploy Apps Script

## B1. Buat project Apps Script
1. Dari Google Sheet: **Extensions > Apps Script**.
2. Hapus isi default `Code.gs`, paste seluruh isi file `Code.gs` dari bundle.
3. Buat file kedua: **File (+) > HTML**, beri nama persis **`Index`**
   (tanpa `.html` — Apps Script menambahkannya otomatis).
   Paste seluruh isi `Index.html` dari bundle.
4. Simpan (Ctrl+S).

> Kalau nama file HTML bukan `Index`, dashboard akan error saat dibuka.

## B2. Set Script Property
1. Klik ikon gerigi (**Project Settings**) di sidebar kiri.
2. Scroll ke **Script Properties** > **Add script property**:
   - Property: `SHARED_SECRET`
   - Value: string rahasia bebas (contoh: `nac-bni-2026-x7k2`)
3. **Save script properties**.

> Catat nilainya — harus diisi sama persis di `.env` bot nanti.

## B3. Jalankan setup()
1. Kembali ke editor, pilih fungsi **`setup`** di dropdown atas.
2. Klik **Run**.
3. Muncul permintaan izin: **Review permissions** > pilih akun >
   **Advanced** > **Go to (nama project) (unsafe)** > **Allow**.

> Peringatan "unsafe" ini normal untuk script pribadi yang belum
> diverifikasi Google. Yang lo izinkan adalah script buatan sendiri.

Setelah sukses, otomatis terbentuk:
- Sheet **`Recipients`** (daftar nomor penerima forward)
- Sheet **`Outbox`** (antrian pesan keluar)
- Label Gmail **`nac-processed`**
- Trigger `processInbox` tiap 1 menit

Verifikasi: cek tab sheet baru muncul, dan menu **Triggers** (ikon jam)
menampilkan satu trigger `processInbox`.

## B4. Deploy sebagai Web App
1. Klik **Deploy > New deployment**.
2. Klik ikon gerigi di samping "Select type" > pilih **Web app**.
3. Isi:
   - Description: bebas (misal `v1`)
   - Execute as: **Me**
   - Who has access: **Anyone**
4. **Deploy** > salin **Web app URL** (berakhiran `/exec`).

> **Catatan keamanan:** "Anyone" berarti siapa pun yang punya URL bisa membuka
> dashboard. URL-nya panjang dan acak, tapi bukan autentikasi. Untuk data
> internal, pertimbangkan langkah pengamanan di Bagian E.

## B5. Tes dashboard
Buka URL `/exec` di browser. Harusnya muncul dashboard dengan statistik
(masih 0) dan panel penerima kosong. Kalau muncul error, cek B1 langkah 3
(nama file HTML harus `Index`).

## B6. Tambah nomor penerima
Di dashboard, isi nama + nomor engineer, klik **Tambah**. Maksimum 5.
Format bebas (`08xx`, `+62 8xx`, `62xx`) — otomatis dinormalisasi.

---

# BAGIAN C — Setup Bot di Termux

## C1. Install Termux
1. Download Termux dari **F-Droid** atau GitHub releases resmi
   (versi Play Store sudah deprecated dan tidak dapat update).
2. Buka Termux, jalankan:
   ```
   termux-setup-storage
   pkg update && pkg upgrade -y
   ```
3. Kalau muncul error mirror ("Mirror sync in progress" / "unexpected size"):
   ```
   termux-change-repo
   ```
   Pilih **Single mirror** > pilih **default (Cloudflare)** > OK, lalu:
   ```
   apt clean && pkg update && pkg upgrade -y
   ```

## C2. Install dependencies sistem
```
pkg install nodejs-lts git unzip nano -y
```
Kalau nanti `npm install` gagal dengan error node-gyp/python:
```
pkg install python clang make -y
```

## C3. Extract project
```
cp ~/storage/downloads/wa-automation-bundle.zip ~/
cd ~ && unzip -o wa-automation-bundle.zip
cd wa-automation-bundle/wa-gmail-forwarder
```

## C4. Install package Node
```
npm install @whiskeysockets/baileys@latest qrcode-terminal nodemailer dotenv pino
```
Agak lama di HP — tunggu sampai selesai.

## C5. Konfigurasi .env
```
cp .env.example .env
nano .env
```
Isi minimal:
```
GMAIL_USER=akun_dari_A2@gmail.com
GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
MAIL_TO=akun_dari_A2@gmail.com

NAC_TICKET_ENABLED=true
GAS_WEBHOOK_URL=<URL /exec dari B4>
GAS_SHARED_SECRET=<sama persis dengan B2>
NAC_INTAKE_EMAIL=akun_dari_A2@gmail.com
NAC_CONFIRM_REPLY=true
POLL_INTERVAL_SECONDS=20
```
Simpan: `Ctrl+O`, Enter, `Ctrl+X`.

> `GAS_SHARED_SECRET` yang beda dengan Script Property = semua polling
> ditolak "Unauthorized" dan tidak ada pesan yang terkirim.

## C6. Jalankan & scan QR
```
node index.js
```
QR muncul di terminal. Scan dari **WhatsApp > Setelan > Perangkat Tertaut >
Tautkan Perangkat**.

Kalau QR kepotong: putar HP ke landscape, atau kecilkan font Termux
(swipe dari kiri > Style, atau Volume Down + Kurangi Font).

Setelah tersambung, sesi tersimpan di `auth_info/` — run berikutnya tidak
perlu scan ulang.

## C7. Cegah proses dimatikan Android
1. Di Termux: `termux-wake-lock`
2. Settings HP > Apps > Termux > Battery > **Unrestricted / No restrictions**
3. Xiaomi/Oppo/Vivo/Huawei: buka juga app "Security"/"Phone Manager", aktifkan
   **Autostart** untuk Termux, dan kunci Termux di Recent Apps (ikon gembok).

> Ini penyebab #1 bot "kadang jalan kadang mati". Jangan dilewat.

## C8. Jalankan di background
```
nohup node index.js > log.txt 2>&1 &
disown
```
Cek log: `tail -f log.txt` (keluar dengan Ctrl+C).

Kalau HP restart, proses berhenti dan perlu dijalankan ulang manual —
kecuali pasang **Termux:Boot** (app terpisah dari F-Droid) untuk auto-start.

---

# BAGIAN D — Tes End-to-End

Lakukan berurutan, jangan lompat:

**D1. Tes bot terima pesan.**
Dari nomor lain, kirim pesan biasa ke nomor bot. Cek `log.txt` — harusnya ada
aktivitas. Kalau tidak ada, bot belum tersambung (ulangi C6).

**D2. Tes format tiket.**
Kirim pesan dengan format:
```
Name & NPP: Budi 901234
Hostname: RDL-901234-NB
MAC Address: 14-AC-60-32-DA-45
IP Address: 10.54.145.16
Divisi: RDL-Maverick
Department: MPL
Lokasi: Jakarta
Lantai: 11
Kendala: Tidak bisa connect INTRANET
```
Log harus menampilkan: `[NAC] Chat dari ... diforward ke Gmail`.

**D3. Cek email masuk.**
Buka Gmail, cari subject berawalan `[NAC-INTAKE]`. Kalau tidak ada, cek
`GMAIL_APP_PASSWORD` dan folder Spam.

**D4. Tunggu 1-2 menit, cek Sheet.**
Baris baru harus muncul di `Activity Lists` dengan status OPEN dan nomor
tiket terisi. Kalau tidak muncul setelah 3 menit, buka Apps Script >
**Executions** (ikon list) untuk lihat error `processInbox`.

**D5. Cek balasan WA.**
Nomor pelapor harus terima konfirmasi nomor tiket, dan semua engineer aktif
terima ringkasan tiket.

**D6. Tes data tidak lengkap.**
Kirim ulang tanpa Lokasi dan Lantai. Tiket tetap dibuat, kolom Site/Floor
berisi `(belum diisi)`, dan balasan menyebut field yang kurang.

---

# BAGIAN E — Operasional & Catatan Penting

## Mengubah nomor penerima
Lewat dashboard saja — tidak perlu restart bot. Perubahan berlaku untuk tiket
berikutnya. Gunakan **Nonaktifkan** (bukan Hapus) untuk engineer yang cuti.

## Setiap kali mengubah kode Apps Script
**Deploy > Manage deployments > ikon pensil > Version: New version > Deploy.**
Menyimpan file saja TIDAK meng-update Web App yang live.

## Kuota Apps Script
Trigger 1 menit = 1440 eksekusi/hari. Akun **Google Workspace** kuotanya
besar dan aman. Akun **Gmail pribadi** dibatasi ~90 menit total runtime/hari —
kalau kena limit, naikkan interval: ganti `.everyMinutes(1)` jadi
`.everyMinutes(5)` di `setup()`, lalu jalankan `setup()` lagi.

## Maintenance sheet Outbox
Baris berstatus SENT menumpuk seiring waktu. Sebulan sekali, hapus baris lama
secara manual (sisakan header) agar polling tetap ringan.

## Keamanan dashboard
`Who has access: Anyone` = siapa pun dengan URL bisa membuka dashboard.
Untuk data internal, opsi pengamanan:
- Ganti ke **Anyone with Google account** dan tambahkan pengecekan email di
  `doGet` — tapi ini membuat bot tidak bisa polling di URL yang sama,
  sehingga perlu deployment terpisah untuk endpoint bot.
- Minimal: jangan sebar URL `/exec`, perlakukan seperti password.

## Batasan yang perlu diketahui
- **Baileys tidak resmi** dari Meta. Gunakan hanya untuk nomor yang lo
  kontrol sendiri. Ada risiko akun kena banned — jangan dipakai untuk
  pesan massal.
- Folder `auth_info/` = sesi login WhatsApp. Perlakukan seperti password,
  jangan commit ke git publik.
- Jeda 1,5 detik antar forward sengaja ada agar tidak terdeteksi spam.
  Jangan dihilangkan meski terasa lambat.

---

# Troubleshooting Cepat

| Gejala | Penyebab paling sering |
|---|---|
| Bot tidak terima pesan sama sekali | Sesi WA putus — cek `log.txt`, scan ulang QR |
| Email `[NAC-INTAKE]` tidak masuk | App Password salah, atau `NAC_INTAKE_EMAIL` beda akun |
| Email masuk tapi Sheet kosong | Trigger belum jalan — cek Apps Script > Executions |
| `Sheet "Activity Lists" tidak ditemukan` | Nama tab beda (spasi ganda / huruf besar-kecil) |
| Balasan WA tidak terkirim | `GAS_SHARED_SECRET` beda antara `.env` dan Script Property |
| Engineer tidak terima forward | Belum ada penerima aktif di dashboard |
| Dashboard error saat dibuka | File HTML bukan bernama `Index` |
| Bot mati sendiri saat layar mati | Battery optimization — ulangi langkah C7 |
| Perubahan kode Apps Script tidak berefek | Belum deploy **New version** |
