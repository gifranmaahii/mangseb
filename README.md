# Mangseb Bot — Bot Promosi WA Otomatis

Bot WhatsApp untuk broadcast promosi terjadwal ke banyak grup. Login pakai nomor pribadi via QR atau Pairing Code, lalu kontrol bot lewat chat ke diri sendiri.

## Fitur Utama
- **Auto Broadcast** ke semua grup terjadwal (cron) atau manual.
- **Anti-Banned**: jeda antar grup, jam tidur, blacklist grup, filter kata nama grup.
- **Multi pesan rotasi** + prioritas pesan utama (probabilistik).
- **Bypass bot penjaga** via Edit Mode + Zero-Width Space pada link.
- **Auto SWGC** (Story WA Grup) untuk posting status ke semua grup sekaligus.
- **Kotak Link Interaktif** (CTA URL button) opsional.
- **Push Kontak** (japri massal dari daftar nomor).
- **Link Scraper** (pemantau link grup yang masuk ke grup yang di-monitor).

## Daftar Cepat Perintah
Kirimkan ke **diri sendiri** (Message Yourself):
- `.menu` — daftar lengkap perintah
- `.setpesan` — set pesan promosi (reply pesan / forward)
- `.startspam` / `.stopspam` — mulai / hentikan promosi
- `.spamsekarang 30` — kirim langsung dengan jeda 30 detik per grup
- `.setwaktu 30 menit` — atur jadwal siklus
- `.setjeda 1 menit` — jeda antar grup
- `.cekconfig` — lihat semua status & konfigurasi
- `.listgrup` / `.cekgrup <kata>` — daftar / cari grup
- `.blacklist` — blacklist grup (via Poll)

## Instalasi (Lokal)
1. Clone repo.
2. `npm install`
3. Salin `config.example.json` → `config.json` (sekali saja, nanti bot yang menulis ulang otomatis).
4. `npm start`
5. Pilih login via QR atau Pairing Code di terminal, lalu tautkan perangkat di WhatsApp.

## Deploy di RDP / VPS Windows (Recommended)
PM2 mengatur auto-restart, log, batas memori. Sangat penting agar bot stabil 24/7.

```cmd
:: 1. Install Node.js v18+ (LTS) dari nodejs.org

:: 2. Install PM2 secara global
npm install -g pm2 pm2-windows-startup

:: 3. Install dependencies bot
npm install

:: 4. Salin contoh config (sekali saja)
copy config.example.json config.json

:: 5. Sekali login lewat npm start untuk scan QR / pairing
npm start
:: setelah berhasil terkoneksi, tekan Ctrl+C untuk stop

:: 6. Jalankan via PM2
pm2 start ecosystem.config.js
pm2 save

:: 7. Auto-start saat RDP nyala (Windows)
pm2-startup install

:: Cek log realtime
pm2 logs mangseb

:: Stop / restart
pm2 restart mangseb
pm2 stop mangseb
```

### Deploy di VPS Linux
```bash
sudo apt update && sudo apt install -y nodejs npm
sudo npm install -g pm2
npm install
cp config.example.json config.json
node index.js              # login pertama (QR/pairing) lalu Ctrl+C
pm2 start ecosystem.config.js
pm2 save
pm2 startup                # ikuti perintah yang muncul
```

## Tips Anti-Lag WhatsApp
WA terasa ngelag biasanya karena:
1. **Folder `auth_info` membengkak** (file Signal key terus bertumpuk). Bot ini sudah punya cleanup otomatis 1 hari, plus cache Signal key di RAM.
2. **Chat dengan diri sendiri penuh laporan**. Notifikasi siklus sekarang di-throttle 30 menit.
3. **Hidetag massal** memicu push notif di tiap anggota grup. Pakai seperlunya saja.
4. **Auto-Clear Chat** dijalankan tiap kirim (operasi mahal). Matikan kalau tidak penting.
5. **`autoswgc` jadwal terlalu rapat**. Default 30 menit sudah cukup.

Saran setting aman:
- `.setwaktu 30 menit` (siklus 30 menit)
- `.setjeda 1 menit` (jeda antar grup 1 menit)
- `.setsleep 23 6` (tidur jam 23.00–06.00)
- `.setautodelete off` (kalau pesan kamu legitimate)
- `.sethidetag off` (kecuali memang perlu)

## Multi-Bot (Jadibot)
Tambah bot baru di nomor lain via PM2 — tinggal kirim ke diri sendiri:
- `.addbotjaseb qr` (QR Code)
- `.addbotjaseb pairing 628xxx` (Pairing 8 digit)

PM2 akan menjalankan instance baru otomatis di background.

## Disclaimer
Bot ini untuk tujuan promosi legitimate. Penggunaan untuk spam abusive berisiko nomor di-banned WhatsApp. Gunakan dengan bijak.
