# Bot WA Spam Promosi Grup

Bot WhatsApp otomatis yang berjalan di nomor sendiri untuk melakukan broadcast promosi (Spam) secara terjadwal ke banyak grup sekaligus tanpa mengganggu grup yang di-blacklist. Fitur delay antar pengiriman mencegah akun terkena pemblokiran dari pihak WhatsApp.

## Fitur
- Auto Broadcast ke grup
- Setup Jadwal perulangan siklus
- Setup Jeda waktu tiap pengiriman ke masing-masing grup (Anti-Ban)
- Fitur Blacklist Grup (Mengecualikan grup tertentu)
- Scan QR 1x Login
- Command via Chat (Ke diri sendiri)

## Cara Instalasi
1. Clone repositori ini.
2. Jalankan \`npm install\`
3. Jalankan \`npm start\`
4. Scan QR code yang muncul di terminal menggunakan WhatsApp (Tautkan Perangkat).

## Daftar Perintah
Kirimkan chat ini ke kontak Anda sendiri (Message Yourself):
- \`.menu\` : Melihat daftar fitur lengkap.
- \`.setpesan\` : (Reply pesan) Menyimpan pesan untuk dijadikan promosi.
- \`.setwaktu 30 menit\` : Set waktu perulangan.
- \`.setjeda 1 menit\` : Set jeda antar pengiriman per grup.
- \`.blacklist <id_grup>\` : Memasukkan grup ke blacklist.
- \`.startspam\` : Memulai eksekusi.
- \`.stopspam\` : Menghentikan eksekusi.
