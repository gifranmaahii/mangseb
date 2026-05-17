// PM2 ecosystem config — pakai ini di RDP agar bot auto-restart kalau crash.
// Cara pakai di RDP:
//   1. npm install -g pm2
//   2. npm install
//   3. pm2 start ecosystem.config.js
//   4. pm2 save
//   5. pm2 startup   (ikuti instruksinya supaya bot otomatis hidup setelah RDP restart)
//
// Perintah berguna:
//   pm2 logs mangseb        -> lihat log realtime
//   pm2 monit               -> dashboard CPU/RAM
//   pm2 restart mangseb     -> restart bot
//   pm2 stop mangseb        -> stop bot
//   pm2 flush               -> bersihkan log lama

module.exports = {
    apps: [
        {
            name: 'mangseb',
            script: 'index.js',
            // Batas memori 1 GB & expose-gc agar GC bisa dipanggil terprogram (kurangi lag)
            node_args: '--max-old-space-size=1024 --expose-gc',

            // Auto restart jika RAM lebih dari 1 GB (paksa fresh state agar WA tidak ngelag)
            max_memory_restart: '1G',

            // Restart bila crash, tapi jangan terus-menerus (proteksi loop)
            autorestart: true,
            max_restarts: 10,
            min_uptime: '60s',
            restart_delay: 5000,

            // Single instance — multi-instance bot WA satu nomor akan konflik
            instances: 1,
            exec_mode: 'fork',

            // Watch matikan: kita tidak mau PM2 restart tiap config.json berubah
            watch: false,

            // Log
            error_file: './logs/error.log',
            out_file: './logs/out.log',
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            env: {
                NODE_ENV: 'production',
                TZ: 'Asia/Jakarta'
            }
        }
    ]
};
