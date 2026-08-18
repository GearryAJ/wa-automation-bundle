# Setup Termux — Langkah Detail

Panduan rinci Bagian C dari DEPLOYMENT.md. Tiap langkah ada **cara verifikasi**
supaya ketahuan lebih awal kalau ada yang gagal, bukan baru sadar di ujung.

**Prasyarat:** Bagian A & B di DEPLOYMENT.md sudah selesai. Siapkan dulu:
- Alamat Gmail + App Password (16 digit)
- URL Web App Apps Script (berakhiran `/exec`)
- Nilai `SHARED_SECRET`

Simpan ketiganya di Notes/Keep dulu — nanti tinggal copy-paste, karena ngetik
di keyboard HP rawan typo.

---

## C1 — Install Termux (versi yang benar)

Versi Play Store **sudah deprecated** dan tidak dapat update. Harus dari
F-Droid atau GitHub.

1. Buka https://f-droid.org/packages/com.termux/ lewat browser HP
2. Download & install APK-nya (izinkan "Install unknown apps" kalau diminta)
3. Kalau sebelumnya sudah punya Termux dari Play Store: **uninstall dulu**,
   karena signature-nya beda dan akan bentrok

**Verifikasi:** buka Termux, muncul prompt hijau `~ $`.

---

## C2 — Izin storage & update paket

```
termux-setup-storage
```
Akan muncul dialog izin Android — pilih **Allow**. Ini yang bikin folder
`~/storage/downloads` bisa diakses (dipakai untuk ambil file zip nanti).

```
pkg update && pkg upgrade -y
```

**Verifikasi:** `ls ~/storage/downloads` menampilkan isi folder Download HP.

### Kalau muncul error mirror

Gejalanya: `Failed to fetch ... File has unexpected size` atau
`Mirror sync in progress`.

```
termux-change-repo
```
Navigasi dialog: **Space** = pilih, **Enter** = OK, panah/geser = pindah baris.

1. Layar 1: pilih **Single mirror** → OK
2. Layar 2: pilih **default (Cached by Cloudflare)** → OK

Lalu:
```
apt clean
pkg update && pkg upgrade -y
```

Kalau saat upgrade muncul pertanyaan config file (`openssl.cnf` dsb) dengan
opsi `[Y/I/N/O/D/Z]`, ketik **`Y`** lalu Enter. Ini normal — artinya pakai
versi config bawaan paket yang baru.

**Verifikasi:** `pkg update` selesai tanpa baris berawalan `E:`.

---

## C3 — Install Node.js dan tools

```
pkg install nodejs-lts git unzip nano -y
```

**Verifikasi:**
```
node -v
npm -v
```
Keduanya harus mengeluarkan nomor versi. `node -v` minimal **v18** (kode ini
pakai `fetch` bawaan yang baru ada sejak v18).

---

## C4 — Ambil file project

Pastikan `wa-automation-bundle.zip` sudah ter-download ke HP.

```
cd ~
cp ~/storage/downloads/wa-automation-bundle.zip ~/
unzip -o wa-automation-bundle.zip
cd wa-automation-bundle/wa-gmail-forwarder
```

**Verifikasi:**
```
ls
```
Harus terlihat: `index.js`, `package.json`, `.env.example`, `README.md`.

> `ls` tidak menampilkan file berawalan titik. Pakai `ls -a` untuk melihat
> `.env.example` dan `.gitignore`.

**Kalau file tidak ketemu:** cek nama file zip-nya persis
(`ls ~/storage/downloads | grep zip`), atau file mungkin tersimpan di
`~/storage/shared/Download`.

---

## C5 — Install package Node

```
npm install @whiskeysockets/baileys@latest qrcode-terminal nodemailer dotenv pino
```

Proses ini **3-10 menit** di HP. Jangan tutup Termux, jangan biarkan layar
mati (aktifkan `termux-wake-lock` dulu kalau perlu).

**Verifikasi:**
```
ls node_modules/@whiskeysockets
```
Harus muncul folder `baileys`.

### Kalau gagal

| Error | Solusi |
|---|---|
| `node-gyp` / `python` / `make not found` | `pkg install python clang make -y` lalu ulangi |
| `ETARGET no matching version` | Pastikan pakai `@latest`, bukan versi hardcoded |
| `ENOSPC` / no space left | Kosongkan storage HP, minimal 1 GB bebas |
| Berhenti di tengah / timeout | `npm cache clean --force` lalu ulangi |

---

## C6 — Isi konfigurasi .env

```
cp .env.example .env
nano .env
```

### Cara pakai nano di HP
- Geser layar / panah bawah untuk navigasi
- Ketik langsung untuk edit
- **Ctrl+O** lalu **Enter** = simpan
- **Ctrl+X** = keluar
- Tombol Ctrl ada di baris tombol ekstra Termux (di atas keyboard)

### Yang wajib diisi

```
GMAIL_USER=email_anda@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
MAIL_TO=email_anda@gmail.com

NAC_TICKET_ENABLED=true
GAS_WEBHOOK_URL=https://script.google.com/macros/s/AKfy.../exec
GAS_SHARED_SECRET=nilai-sama-persis-dengan-script-property
NAC_INTAKE_EMAIL=email_anda@gmail.com
NAC_CONFIRM_REPLY=true
POLL_INTERVAL_SECONDS=20
```

### Kesalahan yang sering terjadi

- **App Password ditulis dengan spasi.** Google menampilkannya sebagai
  `abcd efgh ijkl mnop` — hapus semua spasi jadi `abcdefghijklmnop`.
- **Nilai dikutip.** Jangan pakai tanda kutip: tulis `GMAIL_USER=a@b.com`,
  bukan `GMAIL_USER="a@b.com"`.
- **Ada spasi sebelum/sesudah `=`.** Harus rapat: `KEY=value`.
- **URL Apps Script salah salin.** Harus berakhiran `/exec`, bukan `/dev`.
- **`GAS_SHARED_SECRET` beda** dengan Script Property → semua polling ditolak
  `Unauthorized`, dan tidak ada satu pun pesan terkirim.

**Verifikasi isi tanpa membuka nano:**
```
grep -c "^GAS_WEBHOOK_URL=https" .env
```
Harus keluar `1`.

---

## C7 — Jalankan pertama kali & scan QR

```
node index.js
```

QR code muncul di terminal. Scan dari HP lain (atau HP yang sama pakai
split screen):
**WhatsApp > Setelan > Perangkat Tertaut > Tautkan Perangkat**

### Kalau QR kepotong / tidak terbaca
- Putar HP ke **landscape**
- Kecilkan font Termux: geser dari tepi kiri layar → **Style** → perkecil
- Atau zoom out dengan gesture cubit dua jari

**Tanda berhasil:**
```
[WA] Terhubung. Menunggu pesan masuk...
[NAC] Polling outbox aktif tiap 20 detik
```

Kalau baris kedua tidak muncul, berarti `NAC_TICKET_ENABLED`,
`GAS_WEBHOOK_URL`, atau `GAS_SHARED_SECRET` belum terisi benar di `.env`.

**Verifikasi sesi tersimpan:** `ls auth_info` harus berisi beberapa file JSON.
Selama folder ini ada, run berikutnya tidak perlu scan ulang.

Hentikan sementara dengan **Ctrl+C** sebelum lanjut ke C8.

---

## C8 — Cegah proses dimatikan Android

Ini penyebab nomor satu bot "kadang jalan kadang mati". Kerjakan ketiganya.

### 1. Wake lock Termux
```
termux-wake-lock
```
Muncul notifikasi Termux permanen — itu tandanya aktif.

### 2. Battery optimization
Settings HP → **Apps** → **Termux** → **Battery** → pilih
**Unrestricted** / **No restrictions** / **Tidak dibatasi**.

### 3. Khusus ROM Xiaomi / Oppo / Vivo / Realme / Huawei
ROM ini punya lapisan battery manager sendiri di luar setting Android standar:

| Merek | Yang perlu dilakukan |
|---|---|
| Xiaomi (MIUI/HyperOS) | Security app → Permissions → **Autostart** → aktifkan Termux. Settings → Apps → Termux → **Battery saver** → No restrictions |
| Oppo / Realme (ColorOS) | Settings → Battery → **App Battery Management** → Termux → Allow background running |
| Vivo (FuntouchOS) | i Manager → App Manager → **Autostart** → aktifkan Termux |
| Huawei (EMUI) | Phone Manager → **App launch** → Termux → Manage manually → aktifkan semua |
| Samsung (OneUI) | Settings → Battery → Background usage limits → pastikan Termux **tidak** di "Sleeping apps" |

### 4. Kunci di Recent Apps
Buka Recent Apps, geser kartu Termux ke bawah / tekan ikon **gembok**.

---

## C9 — Jalankan di background

Supaya tetap jalan meski Termux ditutup:

```
nohup node index.js > log.txt 2>&1 &
disown
```

**Verifikasi jalan:**
```
ps aux | grep "node index.js" | grep -v grep
```
Harus keluar satu baris proses.

**Lihat log berjalan:**
```
tail -f log.txt
```
Keluar dari mode tail: **Ctrl+C** (ini tidak mematikan bot).

**Menghentikan bot:**
```
pkill -f "node index.js"
```

**Setelah HP restart:** proses mati dan harus dijalankan ulang manual:
```
cd ~/wa-automation-bundle/wa-gmail-forwarder
termux-wake-lock
nohup node index.js > log.txt 2>&1 &
disown
```

### Opsional: auto-start setelah reboot
Install **Termux:Boot** dari F-Droid (app terpisah), buka sekali, lalu:
```
mkdir -p ~/.termux/boot
nano ~/.termux/boot/start-bot.sh
```
Isi:
```
#!/data/data/com.termux/files/usr/bin/sh
termux-wake-lock
cd ~/wa-automation-bundle/wa-gmail-forwarder
node index.js >> log.txt 2>&1
```
Simpan, lalu:
```
chmod +x ~/.termux/boot/start-bot.sh
```

---

## Perintah harian yang sering dipakai

```
# masuk folder project
cd ~/wa-automation-bundle/wa-gmail-forwarder

# cek bot masih jalan?
ps aux | grep "node index.js" | grep -v grep

# lihat log terakhir
tail -30 log.txt

# lihat log real-time
tail -f log.txt

# restart bot
pkill -f "node index.js"
nohup node index.js > log.txt 2>&1 &
disown

# edit konfigurasi
nano .env
```

> Setelah mengubah `.env`, bot **harus di-restart** agar perubahan terbaca.

---

## Baris log dan artinya

| Log | Arti |
|---|---|
| `[WA] Terhubung` | Sesi WhatsApp aktif |
| `[NAC] Polling outbox aktif` | Koneksi ke Apps Script siap |
| `[NAC] Chat dari X diforward ke Gmail` | Format tiket terdeteksi, email terkirim |
| `[NAC] CONFIRM terkirim ke ...` | Balasan nomor tiket sampai ke pelapor |
| `[NAC] FORWARD terkirim ke ...` | Tiket diteruskan ke engineer |
| `[NAC] Error polling: Unauthorized` | `GAS_SHARED_SECRET` tidak cocok |
| `[NAC] Gagal forward email` | Masalah App Password / koneksi internet |
| `[WA] Koneksi terputus` | Jaringan putus — otomatis reconnect |
| `Logged out` | Perangkat tertaut dicabut dari HP — hapus `auth_info/`, scan ulang |
