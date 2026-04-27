const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    getContentType
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');

const logger = pino({ level: 'silent' });

let savedMessage = null;
let spamJob = null;
let cronExpression = '0 * * * *'; // Default setiap jam
let isSpamming = false;
let blacklistedGroups = [];
let sendDelayMs = 60000; // Default 1 menit (60000 ms)

// Load saved message and config if exists
if (fs.existsSync('./config.json')) {
    try {
        const config = JSON.parse(fs.readFileSync('./config.json'));
        savedMessage = config.savedMessage || null;
        cronExpression = config.cronExpression || '0 * * * *';
        blacklistedGroups = config.blacklistedGroups || [];
        sendDelayMs = config.sendDelayMs || 60000;
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

function saveConfig() {
    fs.writeFileSync('./config.json', JSON.stringify({
        savedMessage,
        cronExpression,
        blacklistedGroups,
        sendDelayMs
    }, null, 2));
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('Bot logged out. Silakan hapus folder auth_info dan scan ulang.');
            }
        } else if (connection === 'open') {
            console.log('Bot berhasil terkoneksi!');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe === false) return; // HANYA PROSES PESAN DARI DIRI SENDIRI

        const jid = msg.key.remoteJid;
        const messageType = getContentType(msg.message);
        
        let text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message[messageType]?.text || 
                   msg.message[messageType]?.caption || 
                   "";

        if (text) {
            console.log(`[INFO] Pesan dari Anda: ${text}`);
        }

        const args = text.split(' ');
        const command = args[0].toLowerCase();

        if (command === '.listgrup') {
            const groupMetadata = await sock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata);
            let response = `*DAFTAR GRUP (${groups.length} Grup)*\n\n`;
            groups.forEach((group, i) => {
                const isBlacklisted = blacklistedGroups.includes(group.id);
                response += `${i + 1}. ${group.subject} ${isBlacklisted ? '(🚫 BLACKLIST)' : ''}\nID: ${group.id}\n\n`;
            });
            await sock.sendMessage(jid, { text: response });
        }

        if (command === '.blacklist') {
            const groupId = args[1];
            if (!groupId) {
                await sock.sendMessage(jid, { text: '❌ Silakan masukkan ID grup.\nContoh: .blacklist 120363xxxx@g.us\n(Lihat ID dari .listgrup)' });
                return;
            }
            if (!blacklistedGroups.includes(groupId)) {
                blacklistedGroups.push(groupId);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Grup ${groupId} berhasil dimasukkan ke daftar blacklist (tidak akan dikirim promosi).` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Grup ${groupId} sudah ada di blacklist.` });
            }
        }

        if (command === '.unblacklist') {
            const groupId = args[1];
            if (!groupId) return await sock.sendMessage(jid, { text: '❌ Silakan masukkan ID grup.\nContoh: .unblacklist 120363xxxx@g.us' });
            
            const index = blacklistedGroups.indexOf(groupId);
            if (index > -1) {
                blacklistedGroups.splice(index, 1);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Grup ${groupId} berhasil dihapus dari blacklist (akan dikirim promosi kembali).` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Grup ${groupId} tidak ada di blacklist.` });
            }
        }

        if (command === '.setjeda') {
            const jedaInput = parseInt(args[1]);
            const tipe = args[2] ? args[2].toLowerCase() : '';
            if (isNaN(jedaInput) || (tipe !== 'detik' && tipe !== 'menit')) {
                await sock.sendMessage(jid, { text: '❌ Format salah.\nContoh: .setjeda 30 detik\nContoh: .setjeda 2 menit' });
                return;
            }
            
            sendDelayMs = tipe === 'menit' ? jedaInput * 60000 : jedaInput * 1000;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Jeda kirim antar grup berhasil diatur menjadi ${jedaInput} ${tipe} (${sendDelayMs} ms).` });
        }

        if (command === '.setpesan') {
            // Cek apakah me-reply pesan
            const contextInfo = msg.message[messageType]?.contextInfo;
            if (contextInfo && contextInfo.quotedMessage) {
                // Simpan pesan yang di-reply
                savedMessage = {
                    key: {
                        remoteJid: jid,
                        fromMe: contextInfo.participant === sock.user.id,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    },
                    message: contextInfo.quotedMessage
                };
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ Pesan promosi berhasil disimpan! (Termasuk forward dari saluran)' });
            } else {
                await sock.sendMessage(jid, { text: '❌ Silakan reply pesan yang ingin dijadikan bahan promosi spam dengan mengetik .setpesan\n\nBisa berupa teks, gambar, atau pesan yang di-forward dari saluran.' });
            }
        }

        if (command === '.setwaktu') {
            const angka = parseInt(args[1]);
            const tipe = args[2] ? args[2].toLowerCase() : '';
            
            let cronStr = '';
            
            if (!isNaN(angka) && ['detik', 'menit', 'jam'].includes(tipe)) {
                if (tipe === 'detik') cronStr = `*/${angka} * * * * *`;
                if (tipe === 'menit') cronStr = `*/${angka} * * * *`;
                if (tipe === 'jam') cronStr = `0 */${angka} * * *`;
            } else {
                const waktuInput = args.slice(1).join(' ');
                if (cron.validate(waktuInput)) {
                    cronStr = waktuInput;
                }
            }

            if (cronStr && cron.validate(cronStr)) {
                cronExpression = cronStr;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Jadwal perulangan promosi (Siklus) berhasil diubah menjadi setiap *${angka ? angka + ' ' + tipe : cronStr}* (Sistem Cron: ${cronStr})` });
                if (isSpamming) {
                    await sock.sendMessage(jid, { text: `🔄 Bot sedang berjalan. Memulai ulang jadwal...` });
                    stopSpamJob();
                    startSpamJob(sock, jid);
                }
            } else {
                await sock.sendMessage(jid, { text: `❌ Format waktu tidak valid!\n\nGunakan format yang lebih mudah, contoh:\n*.setwaktu 30 menit*\n*.setwaktu 2 jam*\n*.setwaktu 15 detik*` });
            }
        }

        if (command === '.startspam') {
            if (!savedMessage) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi! Reply pesan dengan .setpesan' });
                return;
            }
            if (isSpamming) {
                await sock.sendMessage(jid, { text: '⚠️ Spam sudah berjalan!' });
                return;
            }
            
            startSpamJob(sock, jid);
            await sock.sendMessage(jid, { text: `✅ Spam promosi mulai dijalankan!\nJadwal: ${cronExpression}` });
        }

        if (command === '.stopspam') {
            if (!isSpamming) {
                await sock.sendMessage(jid, { text: '⚠️ Spam tidak sedang berjalan.' });
                return;
            }
            stopSpamJob();
            await sock.sendMessage(jid, { text: '🛑 Spam promosi berhasil dihentikan!' });
        }

        if (command === '.cekconfig') {
            let statusText = `*Konfigurasi Spam Bot*\n\n`;
            statusText += `Status Spam: ${isSpamming ? '🟢 BERJALAN' : '🔴 BERHENTI'}\n`;
            statusText += `Jadwal (Cron): ${cronExpression}\n`;
            statusText += `Jeda Antar Grup: ${sendDelayMs / 1000} detik\n`;
            statusText += `Grup Blacklist: ${blacklistedGroups.length} grup\n`;
            statusText += `Pesan Promosi: ${savedMessage ? '✅ Ada' : '❌ Belum di-set'}\n\n`;
            statusText += `Ketik .menu untuk melihat daftar perintah.`;
            await sock.sendMessage(jid, { text: statusText });
        }
        
        if (command === '.menu') {
            const menuText = `*🤖 MENU BOT SPAM GRUP 🤖*\n\n` +
            `Bot ini berjalan pada nomor ini sendiri (ngobrol sendiri), tidak membalas chat orang lain.\n\n` +
            `*Daftar Perintah:*\n` +
            `1. *.listgrup* : Melihat semua grup (termasuk status blacklist)\n` +
            `2. *.setpesan* : Reply pesan untuk disave sebagai promosi\n` +
            `3. *.setwaktu <angka> <detik/menit/jam>* : Mengatur perulangan kirim semua. Contoh: *.setwaktu 30 menit*\n` +
            `4. *.setjeda <angka> <detik/menit>* : Mengatur jeda kirim antar grup. Contoh: *.setjeda 1 menit*\n` +
            `5. *.blacklist <id_grup>* : Supaya grup tersebut tidak disebarkan promosi\n` +
            `6. *.unblacklist <id_grup>* : Menghapus grup dari daftar blacklist\n` +
            `7. *.startspam* : Memulai proses pengiriman spam sesuai jadwal\n` +
            `8. *.stopspam* : Menghentikan proses spam\n` +
            `9. *.cekconfig* : Melihat konfigurasi lengkap\n` +
            `10. *.teskirim* : Mengetes kirim ke 1 grup (Grup pertama)`;
            
            await sock.sendMessage(jid, { text: menuText });
        }

        if (command === '.teskirim') {
            if (!savedMessage) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi!' });
                return;
            }
            const groupMetadata = await sock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata);
            if (groups.length === 0) {
                await sock.sendMessage(jid, { text: '❌ Bot belum bergabung di grup mana pun.' });
                return;
            }
            const targetGroup = groups[0].id;
            await sock.sendMessage(jid, { text: `🔄 Mengetes kirim ke grup: ${groups[0].subject}...` });
            try {
                await sock.sendMessage(targetGroup, { forward: savedMessage });
                await sock.sendMessage(jid, { text: `✅ Berhasil dikirim ke grup: ${groups[0].subject}` });
            } catch (err) {
                await sock.sendMessage(jid, { text: `❌ Gagal mengirim tes: ${err.message}` });
            }
        }
    });

    function startSpamJob(sock, ownerJid) {
        if (spamJob) spamJob.stop();
        isSpamming = true;
        
        spamJob = cron.schedule(cronExpression, async () => {
            console.log('Menjalankan spam ke semua grup...');
            try {
                const groupMetadata = await sock.groupFetchAllParticipating();
                const groups = Object.values(groupMetadata);
                
                let successCount = 0;
                let failCount = 0;

                for (let group of groups) {
                    if (blacklistedGroups.includes(group.id)) {
                        console.log(`Melewati grup ${group.subject} (Di-blacklist)`);
                        continue;
                    }

                    try {
                        await sock.sendMessage(group.id, { forward: savedMessage });
                        successCount++;
                        console.log(`Berhasil kirim ke ${group.subject}. Jeda ${sendDelayMs/1000} detik...`);
                        // Jeda agar tidak kena ban WA sesuai pengaturan (default 1 menit)
                        await new Promise(resolve => setTimeout(resolve, sendDelayMs));
                    } catch (e) {
                        console.error(`Gagal kirim ke ${group.subject}`, e);
                        failCount++;
                    }
                }
                
                console.log(`Spam selesai: ${successCount} Berhasil, ${failCount} Gagal.`);
                // Opsional: Lapor ke owner kalau selesai 1 cycle
                // await sock.sendMessage(ownerJid, { text: `✅ Cycle spam selesai!\nBerhasil: ${successCount} grup\nGagal: ${failCount} grup` });
            } catch (error) {
                console.error('Error saat fetch grup untuk spam:', error);
            }
        });
        
        spamJob.start();
    }

    function stopSpamJob() {
        if (spamJob) {
            spamJob.stop();
            spamJob = null;
        }
        isSpamming = false;
    }
}

startBot();
