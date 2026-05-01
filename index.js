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
let lastNonCommandMessage = null;
let groupSettings = {}; // Menyimpan setting per grup (welcome, left, dll)
let activeSock = null; // Socket global, selalu di-update saat reconnect
let spamOwnerJid = null; // JID owner yang start spam
let spamCycleCount = 0; // Counter siklus spam
let spamJobRunning = false; // Flag apakah sedang proses kirim

// Load saved message and config if exists
if (fs.existsSync('./config.json')) {
    try {
        const config = JSON.parse(fs.readFileSync('./config.json'));
        savedMessage = config.savedMessage || null;
        cronExpression = config.cronExpression || '0 * * * *';
        blacklistedGroups = config.blacklistedGroups || [];
        sendDelayMs = config.sendDelayMs || 60000;
        groupSettings = config.groupSettings || {};
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

function saveConfig() {
    fs.writeFileSync('./config.json', JSON.stringify({
        savedMessage,
        cronExpression,
        blacklistedGroups,
        sendDelayMs,
        groupSettings
    }, null, 2));
}

// Helper: kirim pesan dengan retry & fallback
async function sendWithRetry(groupId, message, maxRetries = 3) {
    if (!activeSock) return false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Cek koneksi sebelum kirim
            if (activeSock.ws?.readyState !== 1) { // 1 = OPEN
                console.log(`[RETRY] WebSocket tidak OPEN (state: ${activeSock.ws?.readyState}), tunggu 3 detik...`);
                await new Promise(r => setTimeout(r, 3000));
                if (activeSock.ws?.readyState !== 1) {
                    throw new Error(`WebSocket masih tidak OPEN setelah menunggu (state: ${activeSock.ws?.readyState})`);
                }
            }

            // Attempt 1-2: pakai relayMessage (menjaga metadata saluran)
            if (attempt <= 2) {
                await activeSock.relayMessage(groupId, message, { messageId: activeSock.generateMessageTag() });
            } else {
                // Attempt 3: fallback pakai sendMessage (lebih reliable)
                const contentType = getContentType(message);
                if (message.conversation) {
                    await activeSock.sendMessage(groupId, { text: message.conversation });
                } else if (message.extendedTextMessage) {
                    await activeSock.sendMessage(groupId, { text: message.extendedTextMessage.text });
                } else if (message.imageMessage) {
                    const img = message.imageMessage;
                    await activeSock.sendMessage(groupId, {
                        image: { url: img.url },
                        caption: img.caption || '',
                        mimetype: img.mimetype
                    });
                } else if (message.videoMessage) {
                    const vid = message.videoMessage;
                    await activeSock.sendMessage(groupId, {
                        video: { url: vid.url },
                        caption: vid.caption || '',
                        mimetype: vid.mimetype
                    });
                } else {
                    // Last resort: relay lagi
                    await activeSock.relayMessage(groupId, message, { messageId: activeSock.generateMessageTag() });
                }
            }
            return true; // Berhasil
        } catch (err) {
            console.error(`[RETRY] Attempt ${attempt}/${maxRetries} gagal untuk ${groupId}:`, err.message || err);
            if (attempt < maxRetries) {
                const waitTime = attempt * 2000; // 2s, 4s
                console.log(`[RETRY] Menunggu ${waitTime/1000} detik sebelum retry...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
        }
    }
    return false; // Semua retry gagal
}

function startSpamJob() {
    if (spamJob) spamJob.stop();
    isSpamming = true;
    spamCycleCount = 0;
    
    spamJob = cron.schedule(cronExpression, async () => {
        // Guard: jika sedang dalam proses kirim sebelumnya, skip
        if (spamJobRunning) {
            console.log('[SPAM] Siklus sebelumnya masih berjalan, melewati siklus ini.');
            return;
        }
        if (!activeSock) {
            console.log('[SPAM] activeSock belum siap, melewati siklus.');
            return;
        }

        spamJobRunning = true;
        spamCycleCount++;
        const cycleNum = spamCycleCount;
        const startTime = new Date();
        
        console.log(`\n========================================`);
        console.log(`[SPAM] Memulai Siklus #${cycleNum} pada ${startTime.toLocaleString('id-ID')}`);
        console.log(`========================================`);
        
        try {
            // Cek koneksi sebelum mulai
            if (activeSock.ws?.readyState !== 1) {
                console.error(`[SPAM] WebSocket tidak terkoneksi (state: ${activeSock.ws?.readyState}). Menunggu reconnect...`);
                await new Promise(r => setTimeout(r, 5000));
                if (activeSock.ws?.readyState !== 1) {
                    console.error(`[SPAM] Masih tidak terkoneksi. Melewati siklus ini.`);
                    try {
                        if (spamOwnerJid) {
                            await activeSock.sendMessage(spamOwnerJid, { 
                                text: `⚠️ *Siklus #${cycleNum} DILEWATI*\n\n❌ Koneksi WhatsApp terputus.\nBot akan mencoba lagi di jadwal berikutnya.\n\n⏰ ${startTime.toLocaleString('id-ID')}` 
                            });
                        }
                    } catch(e) {}
                    spamJobRunning = false;
                    return;
                }
            }

            // Cek savedMessage masih ada
            if (!savedMessage || !savedMessage.message) {
                console.error('[SPAM] savedMessage kosong! Melewati siklus.');
                try {
                    if (spamOwnerJid) {
                        await activeSock.sendMessage(spamOwnerJid, { text: `⚠️ *Siklus #${cycleNum} DILEWATI*\n\n❌ Pesan promosi tidak ditemukan.\nSilakan set ulang dengan .setpesan` });
                    }
                } catch(e) {}
                spamJobRunning = false;
                return;
            }

            const groupMetadata = await activeSock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata).reverse();
            
            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;
            let failedGroups = [];

            // Kirim notifikasi mulai ke owner
            try {
                if (spamOwnerJid) {
                    await activeSock.sendMessage(spamOwnerJid, { 
                        text: `🔄 *Siklus #${cycleNum} DIMULAI*\n\n📊 Total grup: ${groups.length}\n⏰ ${startTime.toLocaleString('id-ID')}\n\n_Mengirim ke semua grup..._` 
                    });
                }
            } catch(e) {
                console.error('[SPAM] Gagal kirim notifikasi mulai:', e.message);
            }

            for (let i = 0; i < groups.length; i++) {
                const group = groups[i];
                const isAdminOnly = group.announce;
                const isAnnounceGroup = group.isCommunityAnnounce;

                if (blacklistedGroups.includes(group.id)) {
                    console.log(`[SKIP] ${group.subject} (Blacklist)`);
                    skipCount++;
                    continue;
                }

                if (isAnnounceGroup) {
                    console.log(`[SKIP] ${group.subject} (Pengumuman)`);
                    skipCount++;
                    continue;
                }

                if (isAdminOnly) {
                    const me = group.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(activeSock.user.id));
                    const isMeAdmin = me?.admin || false;
                    
                    if (!isMeAdmin) {
                        console.log(`[SKIP] ${group.subject} (Admin Only)`);
                        skipCount++;
                        continue;
                    }
                }

                console.log(`[SPAM] [${i+1}/${groups.length}] Mengirim ke: ${group.subject}...`);
                const success = await sendWithRetry(group.id, savedMessage.message);
                
                if (success) {
                    successCount++;
                    console.log(`[SPAM] ✅ Berhasil kirim ke ${group.subject} (${successCount} berhasil)`);
                } else {
                    failCount++;
                    failedGroups.push(group.subject);
                    console.error(`[SPAM] ❌ GAGAL kirim ke ${group.subject} setelah semua retry`);
                }

                // Jeda antar grup
                if (i < groups.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, sendDelayMs));
                }
            }
            
            const endTime = new Date();
            const durasiDetik = Math.round((endTime - startTime) / 1000);
            const durasiStr = durasiDetik >= 60 ? `${Math.floor(durasiDetik/60)} menit ${durasiDetik%60} detik` : `${durasiDetik} detik`;

            console.log(`\n[SPAM] ====== SIKLUS #${cycleNum} SELESAI ======`);
            console.log(`[SPAM] Berhasil: ${successCount} | Gagal: ${failCount} | Dilewati: ${skipCount}`);
            console.log(`[SPAM] Durasi: ${durasiStr}`);

            // Kirim laporan ke owner
            try {
                if (spamOwnerJid) {
                    let reportText = `✅ *LAPORAN SIKLUS #${cycleNum} SELESAI*\n\n`;
                    reportText += `📊 *Hasil Kirim:*\n`;
                    reportText += `├ ✅ Berhasil: ${successCount} grup\n`;
                    reportText += `├ ❌ Gagal: ${failCount} grup\n`;
                    reportText += `├ ⏭️ Dilewati: ${skipCount} grup\n`;
                    reportText += `└ 📋 Total: ${groups.length} grup\n\n`;
                    reportText += `⏱️ Durasi: ${durasiStr}\n`;
                    reportText += `⏰ Selesai: ${endTime.toLocaleString('id-ID')}\n`;
                    
                    if (failedGroups.length > 0) {
                        reportText += `\n⚠️ *Gagal kirim ke:*\n`;
                        failedGroups.slice(0, 10).forEach((name, i) => {
                            reportText += `${i+1}. ${name}\n`;
                        });
                        if (failedGroups.length > 10) {
                            reportText += `... dan ${failedGroups.length - 10} grup lainnya\n`;
                        }
                    }
                    
                    reportText += `\n_Jadwal berikutnya sesuai: ${cronExpression}_`;
                    
                    await activeSock.sendMessage(spamOwnerJid, { text: reportText });
                }
            } catch(e) {
                console.error('[SPAM] Gagal kirim laporan ke owner:', e.message);
            }
        } catch (error) {
            console.error('[SPAM] ERROR FATAL saat siklus spam:', error);
            // Tetap kirim laporan error ke owner
            try {
                if (spamOwnerJid) {
                    await activeSock.sendMessage(spamOwnerJid, { 
                        text: `❌ *Siklus #${cycleNum} ERROR*\n\n${error.message}\n\n_Bot akan tetap mencoba di jadwal berikutnya._\n⏰ ${new Date().toLocaleString('id-ID')}` 
                    });
                }
            } catch(e) {}
        } finally {
            spamJobRunning = false; // SELALU reset flag
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
    spamCycleCount = 0;
    spamJobRunning = false;
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

    activeSock = sock; // Simpan sock secara global supaya survive reconnect

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

    sock.ev.on('group-participants.update', async (update) => {
        const { id, participants, action } = update;
        try {
            const settings = groupSettings[id] || {};
            const groupMetadata = await sock.groupMetadata(id).catch(() => null);
            const groupName = groupMetadata ? groupMetadata.subject : 'Grup';

            for (let participant of participants) {
                if (action === 'add' && settings.welcome) {
                    let msg = settings.welcomeMsg || `Halo @user, selamat datang di @group!`;
                    msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`).replace(/@group/g, groupName);
                    await sock.sendMessage(id, { text: msg, mentions: [participant] });
                } else if (action === 'remove' && settings.left) {
                    let msg = settings.leftMsg || `Selamat tinggal @user dari @group!`;
                    msg = msg.replace(/@user/g, `@${participant.split('@')[0]}`).replace(/@group/g, groupName);
                    await sock.sendMessage(id, { text: msg, mentions: [participant] });
                }
            }
        } catch (err) {
            console.error('Error in group-participants.update:', err);
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        const messageType = getContentType(msg.message);
        const isGroup = jid.endsWith('@g.us');
        
        let text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message[messageType]?.text || 
                   msg.message[messageType]?.caption || 
                   "";

        // --- FITUR MODERASI GRUP (Anti-Link & Anti-Badword) ---
        if (isGroup && !fromMe && text) {
            const settings = groupSettings[jid] || {};
            const sender = msg.key.participant;
            const isLink = text.match(/chat\.whatsapp\.com\/[a-zA-Z0-9]/i) || text.match(/wa\.me\//i);
            
            // Cek jika pengirim adalah admin
            let isAdmin = false;
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === sender);
                isAdmin = participant ? participant.admin : false;
            } catch (e) {}

            if (!isAdmin) {
                let isViolating = false;
                let shouldKick = false;

                // Anti Link
                if (isLink && (settings.antilink || settings.antilinknokick)) {
                    isViolating = true;
                    if (settings.antilink) shouldKick = true;
                }
                
                // Anti Badword
                if (!isViolating && (settings.antibadword || settings.antibadwordnokick)) {
                    const badwords = settings.badwords || [];
                    const textLower = text.toLowerCase();
                    const isBad = badwords.some(word => textLower.includes(word.toLowerCase()));
                    if (isBad) {
                        isViolating = true;
                        if (settings.antibadword) shouldKick = true;
                    }
                }

                if (isViolating) {
                    await sock.sendMessage(jid, { delete: msg.key }).catch(()=>{}); // Hapus pesan
                    if (shouldKick) {
                        await sock.groupParticipantsUpdate(jid, [sender], "remove").catch(()=>{});
                    }
                }
            }
        }

        if (!fromMe) return; // HANYA PROSES COMMAND JIKA DARI DIRI SENDIRI

        if (text) {
            console.log(`[INFO] Pesan dari Anda: ${text}`);
        }

        const isCommand = text.startsWith('.');
        if (!isCommand) {
            lastNonCommandMessage = msg;
        }

        const args = text.split(' ');
        const command = args[0].toLowerCase();

        if (command === '.listgrup') {
            const groupMetadata = await sock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata);
            let response = `*DAFTAR GRUP (${groups.length} Grup)*\n\n`;
            groups.forEach((group, i) => {
                const isBlacklisted = blacklistedGroups.includes(group.id);
                const isAdminOnly = group.announce; // Jika true, hanya admin yang bisa chat
                const isAnnounceGroup = group.isCommunityAnnounce; // Grup pengumuman komunitas
                
                let statusIcon = isAdminOnly ? '🔒 (Admin Only)' : '🔓 (Terbuka)';
                if (isAnnounceGroup) statusIcon = '📢 (Pengumuman)';
                
                response += `${i + 1}. ${group.subject} ${isBlacklisted ? '🚫' : ''}\nStatus: ${statusIcon}\nID: ${group.id}\n\n`;
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
            const contextInfo = msg.message[messageType]?.contextInfo;
            if (contextInfo && contextInfo.quotedMessage) {
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
                await sock.sendMessage(jid, { text: '✅ Pesan promosi berhasil disimpan dari reply!' });
            } else if (lastNonCommandMessage) {
                // Simpan pesan utuh (deep copy) untuk menghindari masalah referensi
                savedMessage = JSON.parse(JSON.stringify(lastNonCommandMessage));
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ Pesan promosi berhasil disimpan dari pesan terakhir yang dikirim!\n\n*(Cocok untuk forward dari Saluran karena sumber/metadata saluran tidak akan hilang)*' });
            } else {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengirim pesan apapun sebelumnya untuk disave.\n\n*Cara terbaik:* Forward pesan dari saluran ke chat ini, lalu kirim .setpesan (jangan di-reply).' });
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
                    startSpamJob();
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
            
            spamOwnerJid = jid;
            startSpamJob();
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
            `*Daftar Perintah Spam:*\n` +
            `1. *.listgrup* : Melihat semua grup (termasuk status blacklist)\n` +
            `2. *.setpesan* : Forward pesan dari saluran, lalu kirim .setpesan (jangan di-reply)\n` +
            `3. *.setwaktu <angka> <detik/menit/jam>* : Mengatur perulangan kirim semua. Contoh: *.setwaktu 30 menit*\n` +
            `4. *.setjeda <angka> <detik/menit>* : Mengatur jeda kirim antar grup. Contoh: *.setjeda 1 menit*\n` +
            `5. *.blacklist <id_grup>* : Supaya grup tersebut tidak disebarkan promosi\n` +
            `6. *.unblacklist <id_grup>* : Menghapus grup dari daftar blacklist\n` +
            `7. *.startspam* : Memulai proses pengiriman spam sesuai jadwal\n` +
            `8. *.stopspam* : Menghentikan proses spam\n` +
            `9. *.cekconfig* : Melihat konfigurasi lengkap\n` +
            `10. *.teskirim* : Mengetes kirim ke 1 grup (Grup pertama)\n\n` +
            `*Daftar Perintah Admin Grup:*\n` +
            `11. *.kick* : Mengeluarkan member (tag/reply/nomor)\n` +
            `12. *.add* : Menambahkan member (nomor)\n` +
            `13. *.promote* : Menjadikan admin (tag/reply/nomor)\n` +
            `14. *.demote* : Menurunkan admin (tag/reply/nomor)\n` +
            `15. *.setnamegc* : Mengubah nama grup\n` +
            `16. *.setdescgc* : Mengubah deskripsi grup\n` +
            `17. *.setopen* : Membuka grup (member bisa chat)\n` +
            `18. *.setclose* : Menutup grup (hanya admin)\n` +
            `19. *.hidetag* : Tag semua member (sembunyi)\n` +
            `20. *.tagall* : Tag semua member (kelihatan)\n` +
            `21. *.leavegc* : Bot keluar dari grup\n` +
            `22. *.linkgc* : Dapatkan link invite grup\n` +
            `23. *.revokelink* : Reset link invite grup\n` +
            `24. *.groupinfo* : Lihat info grup detail\n` +
            `25. *.welcome* : Nyala/Matikan sapaan member baru\n` +
            `26. *.setwelcome* : Atur teks pesan sapaan member baru\n` +
            `27. *.left* : Nyala/Matikan sapaan member keluar\n` +
            `28. *.setleft* : Atur teks pesan sapaan member keluar\n` +
            `29. *.antilink* : Nyala/Matikan anti-link (hapus & kick)\n` +
            `30. *.antilinknokick* : Nyala/Matikan anti-link (hanya hapus)\n` +
            `31. *.antibadword* : Nyala/Matikan anti kata kasar (hapus & kick)\n` +
            `32. *.antibadwordnokick* : Nyala/Matikan anti kata kasar (hanya hapus)\n` +
            `33. *.addbadword* : Tambah kata kasar ke daftar grup ini\n` +
            `34. *.delbadword* : Hapus kata kasar dari daftar grup ini\n` +
            `35. *.listbadword* : Lihat daftar kata kasar grup ini\n` +
            `36. *.resetbadword* : Hapus semua daftar kata kasar grup ini`;
            
            await sock.sendMessage(jid, { text: menuText });
        }

        if (command === '.teskirim') {
            if (!savedMessage) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi!' });
                return;
            }

            const groupMetadata = await sock.groupFetchAllParticipating();
            const allGroups = Object.values(groupMetadata);
            
            let targetGroupJid = args[1]; // Mengambil ID grup jika diberikan
            let targetGroupName = "";

            if (targetGroupJid) {
                const group = allGroups.find(g => g.id === targetGroupJid);
                if (!group) {
                    await sock.sendMessage(jid, { text: `❌ ID grup tidak ditemukan di daftar grup yang Anda ikuti.` });
                    return;
                }
                targetGroupName = group.subject;
            } else {
                // Jika tidak ada argumen, cari grup pertama yang tidak di-blacklist
                const availableGroups = allGroups.filter(g => !blacklistedGroups.includes(g.id));
                if (availableGroups.length === 0) {
                    await sock.sendMessage(jid, { text: '❌ Tidak ada grup yang tersedia (semua grup di-blacklist atau belum gabung grup).' });
                    return;
                }
                targetGroupJid = availableGroups[0].id;
                targetGroupName = availableGroups[0].subject;
            }

            await sock.sendMessage(jid, { text: `🔄 Mengetes kirim ke grup: *${targetGroupName}*...` });
            try {
                console.log(`[TES] Mencoba kirim ke: ${targetGroupName} (${targetGroupJid})`);
                // Menggunakan relayMessage untuk bypass validasi media dan menjaga metadata asli (View Channel)
                await sock.relayMessage(targetGroupJid, savedMessage.message, { messageId: sock.generateMessageTag() });
                console.log(`[TES] Berhasil dikirim ke: ${targetGroupName}`);
                await sock.sendMessage(jid, { text: `✅ Berhasil dikirim ke grup: *${targetGroupName}*` });
            } catch (err) {
                console.error(`[TES] Gagal kirim ke ${targetGroupName}:`, err);
                await sock.sendMessage(jid, { text: `❌ Gagal mengirim tes ke *${targetGroupName}*: ${err.message}` });
            }
        }

        // --- FITUR ADMIN GRUP ---
        const isGroup = jid.endsWith('@g.us');
        
        const getMentionedOrQuoted = () => {
            const mentioned = msg.message[messageType]?.contextInfo?.mentionedJid || [];
            if (mentioned.length > 0) return mentioned;
            const quoted = msg.message[messageType]?.contextInfo?.participant;
            if (quoted) return [quoted];
            const textNum = args[1] ? args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net' : null;
            if (textNum && textNum !== '@s.whatsapp.net') return [textNum];
            return [];
        };

        if (command === '.kick' && isGroup) {
            const users = getMentionedOrQuoted();
            if (users.length === 0) return await sock.sendMessage(jid, { text: '❌ Tag, reply, atau masukkan nomor target.' });
            await sock.groupParticipantsUpdate(jid, users, "remove").catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil mengeluarkan target.` });
        }

        if (command === '.add' && isGroup) {
            const users = getMentionedOrQuoted();
            if (users.length === 0) return await sock.sendMessage(jid, { text: '❌ Masukkan nomor target.' });
            await sock.groupParticipantsUpdate(jid, users, "add").catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil mengundang/menambahkan target.` });
        }

        if (command === '.promote' && isGroup) {
            const users = getMentionedOrQuoted();
            if (users.length === 0) return await sock.sendMessage(jid, { text: '❌ Tag, reply, atau masukkan nomor target.' });
            await sock.groupParticipantsUpdate(jid, users, "promote").catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil menaikkan jabatan target menjadi admin.` });
        }

        if (command === '.demote' && isGroup) {
            const users = getMentionedOrQuoted();
            if (users.length === 0) return await sock.sendMessage(jid, { text: '❌ Tag, reply, atau masukkan nomor target.' });
            await sock.groupParticipantsUpdate(jid, users, "demote").catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil menurunkan jabatan target dari admin.` });
        }

        if (command === '.setnamegc' && isGroup) {
            const newName = args.slice(1).join(' ');
            if (!newName) return await sock.sendMessage(jid, { text: '❌ Masukkan nama grup baru.' });
            await sock.groupUpdateSubject(jid, newName).catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil mengubah nama grup.` });
        }

        if (command === '.setdescgc' && isGroup) {
            const newDesc = args.slice(1).join(' ');
            if (!newDesc) return await sock.sendMessage(jid, { text: '❌ Masukkan deskripsi grup baru.' });
            await sock.groupUpdateDescription(jid, newDesc).catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Berhasil mengubah deskripsi grup.` });
        }

        if (command === '.setopen' && isGroup) {
            await sock.groupSettingUpdate(jid, 'not_announcement').catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Grup telah dibuka, semua member dapat mengirim pesan.` });
        }

        if (command === '.setclose' && isGroup) {
            await sock.groupSettingUpdate(jid, 'announcement').catch(() => {});
            await sock.sendMessage(jid, { text: `✅ Grup telah ditutup, hanya admin yang dapat mengirim pesan.` });
        }

        if (command === '.hidetag' && isGroup) {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(jid);
            const participants = groupMetadata.participants.map(p => p.id);
            await sock.sendMessage(jid, { text: textMsg || '📢 Perhatian', mentions: participants });
        }

        if (command === '.tagall' && isGroup) {
            const textMsg = args.slice(1).join(' ');
            const groupMetadata = await sock.groupMetadata(jid);
            const participants = groupMetadata.participants;
            let tek = `*📢 TAG ALL*\n\n${textMsg ? `Pesan: ${textMsg}\n\n` : ''}`;
            for (let mem of participants) {
                tek += `• @${mem.id.split('@')[0]}\n`;
            }
            await sock.sendMessage(jid, { text: tek, mentions: participants.map(p => p.id) });
        }

        if (command === '.leavegc' && isGroup) {
            await sock.sendMessage(jid, { text: `👋 Bot akan keluar dari grup ini.` });
            await sock.groupLeave(jid);
        }

        if (command === '.linkgc' && isGroup) {
            try {
                const code = await sock.groupInviteCode(jid);
                await sock.sendMessage(jid, { text: `🔗 *Link Grup:*\nhttps://chat.whatsapp.com/${code}` });
            } catch (err) {
                await sock.sendMessage(jid, { text: `❌ Gagal mengambil link grup. Pastikan bot adalah admin.` });
            }
        }

        if (command === '.revokelink' && isGroup) {
            try {
                await sock.groupRevokeInvite(jid);
                await sock.sendMessage(jid, { text: `✅ Berhasil mereset link invite grup.` });
            } catch (err) {
                await sock.sendMessage(jid, { text: `❌ Gagal mereset link. Pastikan bot adalah admin.` });
            }
        }

        if (command === '.groupinfo' && isGroup) {
            try {
                const groupMetadata = await sock.groupMetadata(jid);
                let textInfo = `*📊 INFO GRUP*\n\n`;
                textInfo += `*Nama:* ${groupMetadata.subject}\n`;
                textInfo += `*ID:* ${groupMetadata.id}\n`;
                textInfo += `*Dibuat:* ${new Date(groupMetadata.creation * 1000).toLocaleString()}\n`;
                textInfo += `*Member:* ${groupMetadata.participants.length}\n`;
                textInfo += `*Admin:* ${groupMetadata.participants.filter(p => p.admin).length}\n`;
                textInfo += `*Deskripsi:*\n${groupMetadata.desc ? groupMetadata.desc.toString() : 'Tidak ada'}`;
                await sock.sendMessage(jid, { text: textInfo });
            } catch (err) {
                await sock.sendMessage(jid, { text: `❌ Gagal mengambil info grup.` });
            }
        }

        if (command === '.welcome' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].welcome = !groupSettings[jid].welcome;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Pesan Welcome berhasil di-${groupSettings[jid].welcome ? 'Aktifkan' : 'Matikan'} di grup ini.` });
        }

        if (command === '.setwelcome' && isGroup) {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(jid, { text: `❌ Masukkan teks welcome.\nContoh: .setwelcome Halo @user, selamat datang di @group!` });
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].welcomeMsg = teks;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Berhasil mengatur teks welcome.` });
        }

        if (command === '.left' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].left = !groupSettings[jid].left;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Pesan Left (keluar) berhasil di-${groupSettings[jid].left ? 'Aktifkan' : 'Matikan'} di grup ini.` });
        }

        if (command === '.setleft' && isGroup) {
            const teks = args.slice(1).join(' ');
            if (!teks) return await sock.sendMessage(jid, { text: `❌ Masukkan teks left.\nContoh: .setleft Selamat tinggal @user dari @group.` });
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].leftMsg = teks;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Berhasil mengatur teks left.` });
        }

        if (command === '.antilink' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].antilink = !groupSettings[jid].antilink;
            if (groupSettings[jid].antilink) groupSettings[jid].antilinknokick = false;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Anti-Link (Hapus & Kick) berhasil di-${groupSettings[jid].antilink ? 'Aktifkan' : 'Matikan'}.` });
        }

        if (command === '.antilinknokick' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].antilinknokick = !groupSettings[jid].antilinknokick;
            if (groupSettings[jid].antilinknokick) groupSettings[jid].antilink = false;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Anti-Link (Hanya Hapus) berhasil di-${groupSettings[jid].antilinknokick ? 'Aktifkan' : 'Matikan'}.` });
        }

        if (command === '.antibadword' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].antibadword = !groupSettings[jid].antibadword;
            if (groupSettings[jid].antibadword) groupSettings[jid].antibadwordnokick = false;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Anti-Badword (Hapus & Kick) berhasil di-${groupSettings[jid].antibadword ? 'Aktifkan' : 'Matikan'}.` });
        }

        if (command === '.antibadwordnokick' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].antibadwordnokick = !groupSettings[jid].antibadwordnokick;
            if (groupSettings[jid].antibadwordnokick) groupSettings[jid].antibadword = false;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Anti-Badword (Hanya Hapus) berhasil di-${groupSettings[jid].antibadwordnokick ? 'Aktifkan' : 'Matikan'}.` });
        }

        if (command === '.addbadword' && isGroup) {
            const word = args[1];
            if (!word) return await sock.sendMessage(jid, { text: `❌ Masukkan kata yang ingin diblokir.\nContoh: .addbadword anjing` });
            if (!groupSettings[jid]) groupSettings[jid] = {};
            if (!groupSettings[jid].badwords) groupSettings[jid].badwords = [];
            if (!groupSettings[jid].badwords.includes(word.toLowerCase())) {
                groupSettings[jid].badwords.push(word.toLowerCase());
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Kata "${word}" berhasil ditambahkan ke daftar badword grup ini.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Kata "${word}" sudah ada di daftar badword.` });
            }
        }

        if (command === '.delbadword' && isGroup) {
            const word = args[1];
            if (!word) return await sock.sendMessage(jid, { text: `❌ Masukkan kata yang ingin dihapus.\nContoh: .delbadword anjing` });
            if (!groupSettings[jid] || !groupSettings[jid].badwords) return await sock.sendMessage(jid, { text: `⚠️ Belum ada daftar badword di grup ini.` });
            const index = groupSettings[jid].badwords.indexOf(word.toLowerCase());
            if (index > -1) {
                groupSettings[jid].badwords.splice(index, 1);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Kata "${word}" berhasil dihapus dari daftar badword grup ini.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Kata "${word}" tidak ditemukan di daftar badword.` });
            }
        }

        if (command === '.listbadword' && isGroup) {
            if (!groupSettings[jid] || !groupSettings[jid].badwords || groupSettings[jid].badwords.length === 0) {
                return await sock.sendMessage(jid, { text: `📝 Daftar badword grup ini kosong.` });
            }
            await sock.sendMessage(jid, { text: `📝 *Daftar Badword Grup:*\n\n` + groupSettings[jid].badwords.map((w, i) => `${i + 1}. ${w}`).join('\n') });
        }

        if (command === '.resetbadword' && isGroup) {
            if (!groupSettings[jid]) groupSettings[jid] = {};
            groupSettings[jid].badwords = [];
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Berhasil menghapus semua daftar badword di grup ini.` });
        }
    });


}

startBot();
