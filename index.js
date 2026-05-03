const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    getContentType,
    generateWAMessageFromContent,
    downloadContentFromMessage,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');

const logger = pino({ level: 'silent' });

const sessionName = process.argv[2] || 'auth_info';
const configFile = process.argv[2] ? `./config_${process.argv[2]}.json` : './config.json';

let savedMessage = null;
let savedMessages = []; // Untuk Multi-Pesan (Rotasi)
let spamJob = null;
let cronExpression = '0 * * * *'; // Default setiap jam
let isSpamming = false;
let blacklistedGroups = [];
let sendDelayMs = 60000; // Default 1 menit (60000 ms)
let sleepTimeStart = -1; // -1 berarti dimatikan (format 0-23)
let sleepTimeEnd = -1;
let autoDeleteMs = 0; // 0 berarti tidak ditarik
let useHidetag = false; // Flag hidetag
let autoClearChat = false; // Hapus chat setelah spam
let blacklistKeywords = []; // Filter kata nama grup
let lastNonCommandMessage = null;
let activeSock = null; // Socket global, selalu di-update saat reconnect
let spamOwnerJid = null; // JID owner yang start spam
let spamCycleCount = 0; // Counter siklus spam
let spamJobRunning = false; // Flag apakah sedang proses kirim
let useMessageRotation = true; // Flag rotasi pesan
let currentMessageIndex = 0; // Indeks pesan saat ini jika rotasi off
let ownerNumbers = []; // Daftar nomor owner tambahan

// Load saved message and config if exists
if (fs.existsSync(configFile)) {
    try {
        const config = JSON.parse(fs.readFileSync(configFile));
        savedMessage = config.savedMessage || null;
        savedMessages = config.savedMessages || (savedMessage ? [savedMessage] : []);
        cronExpression = config.cronExpression || '0 * * * *';
        blacklistedGroups = config.blacklistedGroups || [];
        sendDelayMs = config.sendDelayMs || 60000;
        sleepTimeStart = config.sleepTimeStart !== undefined ? config.sleepTimeStart : -1;
        sleepTimeEnd = config.sleepTimeEnd !== undefined ? config.sleepTimeEnd : -1;
        autoDeleteMs = config.autoDeleteMs || 0;
        useHidetag = config.useHidetag || false;
        autoClearChat = config.autoClearChat || false;
        blacklistKeywords = config.blacklistKeywords || [];
        useMessageRotation = config.useMessageRotation !== undefined ? config.useMessageRotation : true;
        ownerNumbers = config.ownerNumbers || [];
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

function saveConfig() {
    fs.writeFileSync(configFile, JSON.stringify({
        savedMessage,
        savedMessages,
        cronExpression,
        blacklistedGroups,
        sendDelayMs,
        sleepTimeStart,
        sleepTimeEnd,
        autoDeleteMs,
        useHidetag,
        autoClearChat,
        blacklistKeywords,
        useMessageRotation,
        ownerNumbers
    }, null, 2));
}

const { exec } = require('child_process');

async function handleJadibot(senderJid, type, number = '') {
    const sessionFolder = `auth_info_${Date.now()}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    const botSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        generateHighQualityLinkPreview: true,
    });

    if (type === 'pairing' && number) {
        setTimeout(async () => {
            try {
                let code = await botSock.requestPairingCode(number);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                await activeSock.sendMessage(senderJid, { text: `✅ *KODE PAIRING ANDA:*\n\n*${code}*\n\nSilakan masukkan kode ini di WhatsApp Anda (Tautkan Perangkat).` });
            } catch (err) {
                await activeSock.sendMessage(senderJid, { text: `❌ Gagal meminta pairing code: ${err.message}` });
            }
        }, 3000);
    }

    botSock.ev.on('creds.update', saveCreds);
    botSock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (qr && type === 'qr') {
            const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}&size=300x300`;
            await activeSock.sendMessage(senderJid, { 
                image: { url: qrImageUrl }, 
                caption: `📸 *SCAN QR CODE INI*\n\nBuka WhatsApp > Tautkan Perangkat > Scan QR ini.\n\n_QR akan expired dalam 20 detik._` 
            });
        }

        if (connection === 'open') {
            await activeSock.sendMessage(senderJid, { text: `✅ *BERHASIL TERHUBUNG!*\n\nBot Jaseb baru sedang disiapkan di background dan akan segera aktif...` });
            
            botSock.end(new Error('Bot connected, moving to PM2'));
            
            const pm2Name = `bot_jaseb_${number || Date.now().toString().slice(-6)}`;
            exec(`pm2 start index.js --name ${pm2Name} -- ${sessionFolder}`, (error, stdout, stderr) => {
                if (error) {
                    activeSock.sendMessage(senderJid, { text: `❌ Gagal menjalankan bot di PM2: ${error.message}\nCoba jalankan manual: node index.js ${sessionFolder}` });
                } else {
                    activeSock.sendMessage(senderJid, { text: `🚀 *BOT JASEB AKTIF!*\n\nStatus PM2: Berhasil ✅\nKetik .menu di nomor bot baru Anda untuk mulai mengatur spam.` });
                }
            });
        }
    });
}

// Helper: dapatkan pesan selanjutnya
function getNextMessageToUse() {
    if (savedMessages.length > 0) {
        if (useMessageRotation) {
            return savedMessages[Math.floor(Math.random() * savedMessages.length)];
        } else {
            const msg = savedMessages[currentMessageIndex % savedMessages.length];
            currentMessageIndex++;
            return msg;
        }
    }
    return savedMessage;
}

// Helper: proses spin text [A|B|C]
function processSpinText(text) {
    if (!text) return text;
    return text.replace(/\[([^\]]+)\]/g, (match, contents) => {
        const choices = contents.split('|');
        const randomIndex = Math.floor(Math.random() * choices.length);
        return choices[randomIndex];
    });
}

// Helper: kirim pesan dengan retry & fallback
async function sendWithRetry(groupId, message, participants = null, maxRetries = 3) {
    if (!activeSock) return false;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Cek koneksi sebelum kirim
            if (!activeSock.ws?.isOpen) {
                console.log(`[RETRY] WebSocket tidak OPEN, tunggu 3 detik...`);
                await new Promise(r => setTimeout(r, 3000));
                if (!activeSock.ws?.isOpen) {
                    throw new Error(`WebSocket masih tidak OPEN setelah menunggu`);
                }
            }

            let messageId = activeSock.generateMessageTag();
            
            // Proses Spin Text (Hanya untuk text)
            let clonedMsg = JSON.parse(JSON.stringify(message));
            const contentType = getContentType(clonedMsg);
            
            if (clonedMsg.conversation) {
                clonedMsg.conversation = processSpinText(clonedMsg.conversation);
            } else if (clonedMsg.extendedTextMessage?.text) {
                clonedMsg.extendedTextMessage.text = processSpinText(clonedMsg.extendedTextMessage.text);
            } else if (clonedMsg[contentType]?.text) {
                clonedMsg[contentType].text = processSpinText(clonedMsg[contentType].text);
            } else if (clonedMsg[contentType]?.caption) {
                clonedMsg[contentType].caption = processSpinText(clonedMsg[contentType].caption);
            }

            // Proses Hidetag
            if (useHidetag && participants && participants.length > 0) {
                const jids = participants.map(p => p.id);
                if (clonedMsg.conversation) {
                    clonedMsg.extendedTextMessage = {
                        text: clonedMsg.conversation,
                        contextInfo: { mentionedJid: jids }
                    };
                    delete clonedMsg.conversation;
                } else if (clonedMsg.extendedTextMessage) {
                    clonedMsg.extendedTextMessage.contextInfo = clonedMsg.extendedTextMessage.contextInfo || {};
                    clonedMsg.extendedTextMessage.contextInfo.mentionedJid = jids;
                } else if (clonedMsg.imageMessage) {
                    clonedMsg.imageMessage.contextInfo = clonedMsg.imageMessage.contextInfo || {};
                    clonedMsg.imageMessage.contextInfo.mentionedJid = jids;
                } else if (clonedMsg.videoMessage) {
                    clonedMsg.videoMessage.contextInfo = clonedMsg.videoMessage.contextInfo || {};
                    clonedMsg.videoMessage.contextInfo.mentionedJid = jids;
                }
            }

            // Attempt 1-2: pakai relayMessage (menjaga metadata saluran)
            if (attempt <= 2) {
                await activeSock.relayMessage(groupId, clonedMsg, { messageId: messageId });
            } else {
                // Attempt 3: fallback pakai sendMessage (lebih reliable)
                if (clonedMsg.conversation) {
                    await activeSock.sendMessage(groupId, { text: clonedMsg.conversation });
                } else if (clonedMsg.extendedTextMessage) {
                    await activeSock.sendMessage(groupId, { text: clonedMsg.extendedTextMessage.text });
                } else if (clonedMsg.contactMessage) {
                    await activeSock.sendMessage(groupId, { contacts: { displayName: clonedMsg.contactMessage.displayName, contacts: [{ vcard: clonedMsg.contactMessage.vcard }] } });
                } else if (clonedMsg.imageMessage) {
                    const img = clonedMsg.imageMessage;
                    await activeSock.sendMessage(groupId, {
                        image: { url: img.url },
                        caption: img.caption || '',
                        mimetype: img.mimetype
                    });
                } else if (clonedMsg.videoMessage) {
                    const vid = clonedMsg.videoMessage;
                    await activeSock.sendMessage(groupId, {
                        video: { url: vid.url },
                        caption: vid.caption || '',
                        mimetype: vid.mimetype
                    });
                } else {
                    // Last resort: relay lagi
                    await activeSock.relayMessage(groupId, clonedMsg, { messageId: messageId });
                }
            }
            return messageId; // Berhasil, kembalikan ID pesan
        } catch (err) {
            console.error(`[RETRY] Attempt ${attempt}/${maxRetries} gagal untuk ${groupId}:`, err.message || err);
            if (attempt < maxRetries) {
                const waitTime = attempt * 2000; // 2s, 4s
                console.log(`[RETRY] Menunggu ${waitTime/1000} detik sebelum retry...`);
                await new Promise(r => setTimeout(r, waitTime));
            }
        }
    }
    return null; // Semua retry gagal
}

async function runSpamCycle() {
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
            if (!activeSock.ws?.isOpen) {
                console.error(`[SPAM] WebSocket tidak terkoneksi. Menunggu reconnect...`);
                await new Promise(r => setTimeout(r, 5000));
                if (!activeSock.ws?.isOpen) {
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
            
            // Cek Jam Operasional (Sleep Time)
            if (sleepTimeStart !== -1 && sleepTimeEnd !== -1) {
                const currentHour = new Date().getHours();
                let isSleeping = false;
                if (sleepTimeStart < sleepTimeEnd) {
                    if (currentHour >= sleepTimeStart && currentHour < sleepTimeEnd) isSleeping = true;
                } else {
                    // Melewati tengah malam
                    if (currentHour >= sleepTimeStart || currentHour < sleepTimeEnd) isSleeping = true;
                }
                
                if (isSleeping) {
                    console.log(`[SPAM] Siklus dilewati karena sedang Jam Tidur (${sleepTimeStart}:00 - ${sleepTimeEnd}:00)`);
                    try {
                        if (spamOwnerJid) {
                            await activeSock.sendMessage(spamOwnerJid, { 
                                text: `💤 *Siklus #${cycleNum} DILEWATI*\n\nBot sedang dalam mode Jam Tidur (${sleepTimeStart}:00 - ${sleepTimeEnd}:00).\nBot akan diam sampai jam operasional tiba.\n\n⏰ ${startTime.toLocaleString('id-ID')}` 
                            });
                        }
                    } catch(e) {}
                    spamJobRunning = false;
                    return;
                }
            }

            // Cek savedMessage masih ada
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
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
                        text: `🔄 *Siklus #${cycleNum} DIMULAI*\n\n📊 Memindai ${groups.length} grup (Grup Blacklist/Admin-Only akan otomatis dilewati).\n⏰ ${startTime.toLocaleString('id-ID')}\n\n_Mengirim promosi..._` 
                    });
                }
            } catch(e) {
                console.error('[SPAM] Gagal kirim notifikasi mulai:', e.message);
            }

            for (let i = 0; i < groups.length; i++) {
                // Berhenti jika user memanggil .stopspam
                if (!isSpamming) {
                    console.log(`[SPAM] Dihentikan paksa oleh user. Membatalkan sisa pengiriman...`);
                    break;
                }

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

                if (blacklistKeywords.length > 0) {
                    const groupNameLower = group.subject.toLowerCase();
                    const isKeywordMatched = blacklistKeywords.some(kw => groupNameLower.includes(kw));
                    if (isKeywordMatched) {
                        console.log(`[SKIP] ${group.subject} (Filter Keyword)`);
                        skipCount++;
                        continue;
                    }
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
                const msgObjToUse = getNextMessageToUse();
                const sentMsgId = await sendWithRetry(group.id, msgObjToUse.message, group.participants);
                
                if (sentMsgId) {
                    successCount++;
                    console.log(`[SPAM] ✅ Berhasil kirim ke ${group.subject} (${successCount} berhasil)`);
                    
                    // Jadwalkan auto-delete jika diset
                    if (autoDeleteMs > 0) {
                        const targetGroupId = group.id; // Copy by value
                        setTimeout(async () => {
                            try {
                                await activeSock.sendMessage(targetGroupId, { delete: { remoteJid: targetGroupId, fromMe: true, id: sentMsgId } });
                                console.log(`[AUTO-DELETE] ✅ Berhasil menarik pesan di ${group.subject}`);
                            } catch(e) {
                                console.log(`[AUTO-DELETE] ❌ Gagal menarik pesan di ${group.subject}: ${e.message}`);
                            }
                        }, autoDeleteMs);
                    }
                    
                    if (autoClearChat) {
                        try {
                            const ts = Math.floor(Date.now() / 1000);
                            await activeSock.chatModify({ 
                                delete: true, 
                                lastMessages: [{ key: { remoteJid: group.id, id: sentMsgId, fromMe: true }, messageTimestamp: ts }] 
                            }, group.id);
                            console.log(`[AUTO-CLEAR] ✅ Berhasil membersihkan chat di ${group.subject}`);
                        } catch(e) {
                            console.log(`[AUTO-CLEAR] ❌ Gagal membersihkan chat di ${group.subject}: ${e.message}`);
                        }
                    }
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
}

function startSpamJob() {
    if (spamJob) spamJob.stop();
    isSpamming = true;
    spamCycleCount = 0;
    
    // Langsung eksekusi 1 kali saat start
    runSpamCycle();

    // Jadwalkan untuk eksekusi selanjutnya
    spamJob = cron.schedule(cronExpression, runSpamCycle);
    
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
    const { state, saveCreds } = await useMultiFileAuthState(sessionName);
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

    let loginMethod = 'qr';

    if (!sock.authState.creds.registered) {
        loginMethod = 'prompt'; // Sedang memilih
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (text) => new Promise((resolve) => rl.question(text, resolve));

        setTimeout(async () => {
            console.log(`\n========================================`);
            let opsi = await question('Pilih metode login:\n1. QR Code\n2. Pairing Code\nPilihan (1/2): ');
            if (opsi === '2') {
                loginMethod = 'pairing';
                let nomorWa = await question('Masukkan nomor WhatsApp (contoh: 628123456789): ');
                nomorWa = nomorWa.replace(/[^0-9]/g, '');
                if (nomorWa.startsWith('0')) {
                    nomorWa = '62' + nomorWa.substring(1);
                }
                console.log(`⏳ Meminta kode pairing untuk nomor: ${nomorWa}...`);
                try {
                    let code = await sock.requestPairingCode(nomorWa);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    console.log(`\n========================================`);
                    console.log(`✅ KODE PAIRING ANDA: ${code}`);
                    console.log(`Silakan masukkan kode ini di aplikasi WhatsApp Anda.`);
                    console.log(`========================================\n`);
                } catch (err) {
                    console.log(`\n❌ GAGAL MEMINTA KODE: ${err.message}`);
                    console.log(`Pastikan nomor sudah benar dan limit request API WhatsApp belum habis.`);
                    console.log(`Silakan stop script, hapus folder session, lalu coba login via QR Code.`);
                }
            } else {
                loginMethod = 'qr';
                console.log(`\nMenunggu QR Code... Silakan scan QR Code yang muncul di bawah ini.`);
            }
            rl.close();
        }, 1000);
    }

    activeSock = sock; // Simpan sock secara global supaya survive reconnect

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr && loginMethod === 'qr') {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus karena ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            } else {
                console.log('Bot logged out. Menghapus folder session otomatis...');
                if (fs.existsSync(sessionName)) {
                    fs.rmSync(sessionName, { recursive: true, force: true });
                    console.log(`Folder session ${sessionName} berhasil dihapus. Silakan jalankan ulang script untuk login kembali.`);
                }
                process.exit(0);
            }
        } else if (connection === 'open') {
            console.log('Bot berhasil terkoneksi!');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        try {
            if (m.type !== 'notify' && m.type !== 'append') return;
            const msg = m.messages[0];
            if (!msg.message) return;

            const jid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            const messageType = getContentType(msg.message);
            
            // --- HANDLING POLL VOTE ---
            // Removed as requested

            // Ambil teks dari berbagai tipe pesan
            let text = msg.message.conversation || 
                       msg.message.extendedTextMessage?.text || 
                       msg.message[messageType]?.text || 
                       msg.message[messageType]?.caption || 
                       "";

            const senderJid = msg.key.participant || msg.key.remoteJid || "";
            const senderNumber = senderJid.split('@')[0];
            const isOwner = ownerNumbers.includes(senderNumber);

            if (!fromMe && !isOwner) return; // HANYA PROSES COMMAND JIKA DARI DIRI SENDIRI ATAU OWNER

            if (text) {
                console.log(`[INFO] Pesan masuk (fromMe: ${fromMe}): ${text}`);
            }

            const isCommand = text.startsWith('.');
            // Hanya simpan pesan terakhir jika: BUKAN command, DI CHAT PRIBADI, dan BUKAN dari bot sendiri
            if (!isCommand && !jid.endsWith('@g.us') && !fromMe) {
                lastNonCommandMessage = msg;
                console.log(`[DEBUG] Berhasil menangkap pesan terakhir untuk calon promosi: ${getContentType(msg.message)}`);
            }

        const args = text.split(' ');
        const command = args[0].toLowerCase();

        if (command === '.pushkontak') {
            const isQuotedDocument = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
            const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || 
                               msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || "";

            let rawTextData = "";

            if (isQuotedDocument) {
                try {
                    await sock.sendMessage(jid, { text: "⏳ Mendownload file kontak..." });
                    const stream = await downloadContentFromMessage(isQuotedDocument, 'document');
                    let buffer = Buffer.from([]);
                    for await(const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                    }
                    rawTextData = buffer.toString('utf-8');
                } catch(e) {
                    return await sock.sendMessage(jid, { text: `❌ Gagal mendownload dokumen: ${e.message}` });
                }
            } else if (quotedText) {
                rawTextData = quotedText;
            } else {
                rawTextData = args.slice(1).join(' ');
            }

            if (!rawTextData.trim()) {
                let p = `📱 *FITUR PUSH KONTAK / JAPRI*\n\n`;
                p += `Cara penggunaan:\n`;
                p += `1. Kirim file .txt (berisi daftar nomor WhatsApp).\n`;
                p += `2. Reply/Balas file tersebut dengan pesan: *.pushkontak*\n\n`;
                p += `Atau bisa langsung copy-paste nomor:\n`;
                p += `*.pushkontak 08123xxx, 0821xxx, 0857xxx*\n\n`;
                p += `_Pesan yang dikirim adalah pesan promosi yang sudah disetting (.setpesan)_`;
                return await sock.sendMessage(jid, { text: p });
            }

            const regex = /(?:0|62|\+62)[\s\-]?8[0-9]{2,3}[\s\-]?[0-9]{3,4}[\s\-]?[0-9]{3,5}/g;
            const matches = rawTextData.match(regex) || [];
            
            let numberList = matches.map(n => {
                let num = n.replace(/\D/g, '');
                if (num.startsWith('0')) num = '62' + num.substring(1);
                return num + '@s.whatsapp.net';
            });
            
            numberList = [...new Set(numberList)];

            if (numberList.length === 0) {
                return await sock.sendMessage(jid, { text: "❌ Tidak ditemukan nomor WhatsApp yang valid dalam teks/file." });
            }

            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                return await sock.sendMessage(jid, { text: "❌ Pesan promosi kosong! Setel dulu dengan .setpesan" });
            }

            await sock.sendMessage(jid, { text: `🚀 Memulai *Push Kontak* ke ${numberList.length} nomor.\n\n⏳ Estimasi jeda: ~${Math.floor(sendDelayMs / 1000)} detik (Acak otomatis untuk keamanan).\n\n_Bot akan berjalan di background. Harap tunggu laporan akhirnya._` });

            (async () => {
                let success = 0;
                let failed = 0;
                for (let i = 0; i < numberList.length; i++) {
                    const targetJid = numberList[i];
                    console.log(`[PUSH] Mengirim ke ${targetJid}...`);
                    
                    try {
                        await sock.presenceSubscribe(targetJid);
                        await sock.sendPresenceUpdate('composing', targetJid);
                        await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000)); 
                        await sock.sendPresenceUpdate('paused', targetJid);

                        const msgObjToUse = getNextMessageToUse();
                        
                        let clonedMsg = JSON.parse(JSON.stringify(msgObjToUse.message));
                        
                        if (clonedMsg.conversation) {
                            clonedMsg.conversation = processSpinText(clonedMsg.conversation);
                            await sock.sendMessage(targetJid, { text: clonedMsg.conversation });
                        } else if (clonedMsg.extendedTextMessage?.text) {
                            clonedMsg.extendedTextMessage.text = processSpinText(clonedMsg.extendedTextMessage.text);
                            await sock.sendMessage(targetJid, { text: clonedMsg.extendedTextMessage.text });
                        } else if (clonedMsg.imageMessage) {
                            const img = clonedMsg.imageMessage;
                            const cap = processSpinText(img.caption || '');
                            await sock.sendMessage(targetJid, { image: { url: img.url }, caption: cap, mimetype: img.mimetype });
                        } else {
                            await sock.relayMessage(targetJid, clonedMsg, { messageId: sock.generateMessageTag() });
                        }
                        
                        success++;
                    } catch(e) {
                        console.error(`[PUSH] Gagal kirim ke ${targetJid}:`, e.message);
                        failed++;
                    }

                    if (i < numberList.length - 1) {
                        const randomFactor = 0.7 + (Math.random() * 0.6); 
                        const delay = Math.floor(sendDelayMs * randomFactor);
                        await new Promise(r => setTimeout(r, Math.max(delay, 5000))); 
                    }
                }

                await sock.sendMessage(jid, { text: `✅ *LAPORAN PUSH KONTAK SELESAI*\n\n📊 Total Target: ${numberList.length}\n✔️ Berhasil: ${success}\n❌ Gagal: ${failed}` });
            })();
        }

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
            const groupMetadata = await sock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata);
            const available = groups.filter(g => !blacklistedGroups.includes(g.id));

            if (args.length === 1) {
                if (available.length === 0) {
                    return await sock.sendMessage(jid, { text: '✅ Semua grup sudah di-blacklist.' });
                }

                const options = available.slice(0, 11).map(g => g.subject.substring(0, 50));
                options.push('❌ BATAL');

                await sock.sendMessage(jid, {
                    poll: {
                        name: '🚫 *MENU BLACKLIST GRUP*\n(Silakan pilih nama grup di bawah ini)',
                        values: options,
                        selectableCount: 1
                    }
                });
                return;
            }

            // Manual handling
            let addedCount = 0;
            for (let i = 1; i < args.length; i++) {
                const target = args[i];
                let groupId = target;
                if (!isNaN(target) && Number(target) > 0 && Number(target) <= groups.length) {
                    groupId = groups[Number(target) - 1].id;
                }
                if (groupId.endsWith('@g.us') && !blacklistedGroups.includes(groupId)) {
                    blacklistedGroups.push(groupId);
                    addedCount++;
                }
            }
            if (addedCount > 0) {
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Berhasil mem-blacklist ${addedCount} grup.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Gagal/ID salah.` });
            }
        }

        if (command === '.unblacklist') {
            const groupMetadataList = await sock.groupFetchAllParticipating();
            const groupsList = Object.values(groupMetadataList);
            const blacklisted = groupsList.filter(g => blacklistedGroups.includes(g.id));

            if (args.length === 1) {
                if (blacklisted.length === 0) {
                    return await sock.sendMessage(jid, { text: '⚠️ Tidak ada grup ter-blacklist.' });
                }

                const options = blacklisted.slice(0, 11).map(g => g.subject.substring(0, 50));
                options.push('❌ BATAL');

                await sock.sendMessage(jid, {
                    poll: {
                        name: '🔓 *MENU UN-BLACKLIST GRUP*\n(Pilih grup untuk diaktifkan kembali)',
                        values: options,
                        selectableCount: 1
                    }
                });
                return;
            }

            let removedCount = 0;
            for (let i = 1; i < args.length; i++) {
                const target = args[i];
                let targetId = target;
                if (!isNaN(target) && Number(target) > 0 && Number(target) <= groupsList.length) {
                    targetId = groupsList[Number(target) - 1].id;
                }
                const index = blacklistedGroups.indexOf(targetId);
                if (index > -1) {
                    blacklistedGroups.splice(index, 1);
                    removedCount++;
                }
            }
            if (removedCount > 0) {
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Berhasil menghapus ${removedCount} grup dari blacklist.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Gagal menghapus.` });
            }
        }



        if (command === '.addbotjaseb') {
            const type = args[1]?.toLowerCase();
            const number = args[2];
            
            if (type === 'qr') {
                await sock.sendMessage(jid, { text: `⏳ *Meminta QR Code...*\nHarap tunggu sebentar.` });
                handleJadibot(jid, 'qr');
            } else if (type === 'pairing') {
                if (!number) return await sock.sendMessage(jid, { text: `❌ Masukkan nomor WhatsApp Anda!\nContoh: *.addbotjaseb pairing 628123456789*` });
                await sock.sendMessage(jid, { text: `⏳ *Meminta Pairing Code...*\nNomor: ${number}\nHarap tunggu sebentar.` });
                handleJadibot(jid, 'pairing', number.replace(/[^0-9]/g, ''));
            } else {
                let msg = `🤖 *JADIBOT JASEB (Multi-Instance)* 🤖\n\n`;
                msg += `Ingin menjadikan nomor lain sebagai bot spam juga? Pilih metode login:\n\n`;
                msg += `1️⃣ *Via QR Code*\nKetik: *.addbotjaseb qr*\n_(Anda akan menerima gambar QR untuk discan)_\n\n`;
                msg += `2️⃣ *Via Pairing Code*\nKetik: *.addbotjaseb pairing 628xxx*\n_(Anda akan menerima 8 digit huruf untuk dimasukkan ke WA)_\n\n`;
                msg += `_Note: Bot baru akan otomatis berjalan di background menggunakan PM2._`;
                await sock.sendMessage(jid, { text: msg });
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

        if (command === '.setautodelete') {
            const jedaInput = parseInt(args[1]);
            const tipe = args[2] ? args[2].toLowerCase() : '';
            if (args[1] === 'off') {
                autoDeleteMs = 0;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Fitur Auto-Delete dimatikan. Pesan promosi tidak akan ditarik.` });
                return;
            }
            if (isNaN(jedaInput) || (tipe !== 'detik' && tipe !== 'menit')) {
                await sock.sendMessage(jid, { text: '❌ Format salah.\nContoh: .setautodelete 5 menit\nContoh: .setautodelete 30 detik\nUntuk mematikan: .setautodelete off' });
                return;
            }
            
            autoDeleteMs = tipe === 'menit' ? jedaInput * 60000 : jedaInput * 1000;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Pesan promosi akan ditarik (Delete for Everyone) otomatis setelah ${jedaInput} ${tipe}.` });
        }

        if (command === '.setsleep') {
            if (args[1] === 'off') {
                sleepTimeStart = -1;
                sleepTimeEnd = -1;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Jam Tidur dimatikan. Bot akan promosi 24 Jam Nonstop.` });
                return;
            }
            const start = parseInt(args[1]);
            const end = parseInt(args[2]);
            
            if (isNaN(start) || isNaN(end) || start < 0 || start > 23 || end < 0 || end > 23) {
                await sock.sendMessage(jid, { text: '❌ Format salah.\nContoh (Bot diam jam 22 malam sampai 5 pagi): .setsleep 22 5\nUntuk mematikan: .setsleep off' });
                return;
            }
            
            sleepTimeStart = start;
            sleepTimeEnd = end;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Jam Tidur diaktifkan!\nBot akan otomatis berhenti ngirim promosi pada jam *${start}:00* sampai *${end}:00*.` });
        }

        if (command === '.sethidetag') {
            const opt = args[1] ? args[1].toLowerCase() : '';
            if (opt === 'on') {
                useHidetag = true;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Fitur Hidetag diaktifkan!\nBot akan me-mention seluruh anggota grup secara tersembunyi.` });
            } else if (opt === 'off') {
                useHidetag = false;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Fitur Hidetag dimatikan.` });
            } else {
                await sock.sendMessage(jid, { text: `❌ Format salah.\nGunakan: .sethidetag on\nAtau: .sethidetag off` });
            }
        }

        if (command === '.autoclear') {
            const opt = args[1] ? args[1].toLowerCase() : '';
            if (opt === 'on') {
                autoClearChat = true;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Fitur Auto-Clear Chat diaktifkan!\nBot akan otomatis menghapus riwayat chat di grup setelah selesai mengirim promosi, agar WA tidak ngelag.` });
            } else if (opt === 'off') {
                autoClearChat = false;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Fitur Auto-Clear Chat dimatikan.` });
            } else {
                await sock.sendMessage(jid, { text: `❌ Format salah.\nGunakan: .autoclear on\nAtau: .autoclear off` });
            }
        }

        if (command === '.cleangrup') {
            await sock.sendMessage(jid, { text: '⏳ *Memindai grup...*\nMencari grup "Admin Only" di mana bot tidak bisa mengirim pesan...' });
            try {
                const groupMetadataList = await sock.groupFetchAllParticipating();
                const groupsList = Object.values(groupMetadataList);
                let leaveCount = 0;
                
                for (const group of groupsList) {
                    if (group.announce) {
                        const me = group.participants.find(p => p.id.includes(activeSock.user.id.split(':')[0]));
                        if (!me?.admin) {
                            try {
                                await activeSock.groupLeave(group.id);
                                leaveCount++;
                                console.log(`[LEAVE] Keluar dari grup Admin Only: ${group.subject}`);
                                await new Promise(r => setTimeout(r, 2000)); // Jeda agar tidak kena rate limit
                            } catch(e) {
                                console.log(`[LEAVE] Gagal keluar dari ${group.subject}:`, e.message);
                            }
                        }
                    }
                }
                await sock.sendMessage(jid, { text: `✅ *Pembersihan Selesai!*\nBot telah keluar (Leave) dari *${leaveCount}* grup sampah (Admin Only). Ruang grup Anda sekarang lebih lega!` });
            } catch(e) {
                await sock.sendMessage(jid, { text: `❌ Terjadi kesalahan saat pembersihan grup.` });
            }
        }

        if (command === '.blacklistkata') {
            const keywords = text.substring(14).trim();
            if (!keywords) {
                await sock.sendMessage(jid, { text: `*Daftar Keyword Blacklist saat ini:*\n${blacklistKeywords.length > 0 ? blacklistKeywords.join(', ') : 'TIDAK ADA'}\n\n*Cara set:* .blacklistkata agama, keluarga, rt\n*Cara hapus semua:* .blacklistkata off` });
                return;
            }
            if (keywords.toLowerCase() === 'off' || keywords.toLowerCase() === 'clear') {
                blacklistKeywords = [];
                saveConfig();
                return await sock.sendMessage(jid, { text: `✅ Semua keyword blacklist berhasil dihapus.` });
            }
            blacklistKeywords = keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k);
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Keyword blacklist berhasil disimpan. Bot tidak akan promosi ke grup yang namanya mengandung kata:\n*${blacklistKeywords.join(', ')}*` });
        }

        if (command === '.setpesan') {
            const contextInfo = msg.message[messageType]?.contextInfo;
            let targetMsg = null;
            let source = "";

            if (contextInfo && contextInfo.quotedMessage) {
                targetMsg = {
                    key: {
                        remoteJid: jid,
                        fromMe: contextInfo.participant === sock.user.id,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    },
                    message: contextInfo.quotedMessage
                };
                source = "Reply (Balasan)";
            } else if (lastNonCommandMessage) {
                targetMsg = JSON.parse(JSON.stringify(lastNonCommandMessage));
                source = "Pesan Terakhir di Chat Pribadi";
            }

            if (targetMsg) {
                savedMessage = targetMsg;
                savedMessages = [targetMsg]; // Reset rotasi
                saveConfig();
                
                const type = getContentType(targetMsg.message);
                await sock.sendMessage(jid, { text: `✅ *BERHASIL DISIMPAN (UTAMA)*\n\n Sumber: ${source}\n Tipe: ${type}\n\nSemua pesan rotasi lama telah dihapus dan diganti dengan pesan ini.` });
            } else {
                await sock.sendMessage(jid, { text: '❌ *GAGAL MENYIMPAN*\n\nPastikan Anda sudah mengirim pesan (teks/gambar/forward) ke chat ini, atau Reply pesan tersebut dengan .setpesan' });
            }
        }

        if (command === '.addpesan') {
            const contextInfo = msg.message[messageType]?.contextInfo;
            let targetMsg = null;
            let source = "";

            if (contextInfo && contextInfo.quotedMessage) {
                targetMsg = {
                    key: {
                        remoteJid: jid,
                        fromMe: contextInfo.participant === sock.user.id,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    },
                    message: contextInfo.quotedMessage
                };
                source = "Reply (Balasan)";
            } else if (lastNonCommandMessage) {
                targetMsg = JSON.parse(JSON.stringify(lastNonCommandMessage));
                source = "Pesan Terakhir di Chat Pribadi";
            }

            if (targetMsg) {
                savedMessages.push(targetMsg);
                if (!savedMessage) savedMessage = targetMsg;
                saveConfig();
                
                const type = getContentType(targetMsg.message);
                await sock.sendMessage(jid, { text: `✅ *BERHASIL DITAMBAHKAN*\n\n Sumber: ${source}\n Tipe: ${type}\n Total: ${savedMessages.length} pesan dalam rotasi.` });
            } else {
                await sock.sendMessage(jid, { text: '❌ *GAGAL MENAMBAHKAN*\n\nKirim pesan dulu atau Reply pesan tersebut dengan .addpesan' });
            }
        }

        if (command === '.delpesan' || command === '.hapuspesan') {
            const indexArg = parseInt(args[1]);
            
            if (!isNaN(indexArg) && indexArg > 0 && indexArg <= savedMessages.length) {
                // Hapus satu pesan spesifik
                savedMessages.splice(indexArg - 1, 1);
                // Jika pesan utama (savedMessage) terhapus dan masih ada sisa pesan, set ke pesan pertama
                if (savedMessages.length > 0) {
                    savedMessage = savedMessages[0];
                } else {
                    savedMessage = null;
                }
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ *Pesan ke-${indexArg} berhasil dihapus!*\n(Sisa ${savedMessages.length} pesan di rotasi)` });
            } else if (args[1] === 'semua' || args[1] === 'all' || !args[1]) {
                // Default: Hapus semua
                savedMessage = null;
                savedMessages = [];
                saveConfig();
                await sock.sendMessage(jid, { text: '🗑️ *Semua pesan promosi berhasil dihapus!*\n\nSilakan setel ulang dengan mengirim pesan lalu ketik *.setpesan*' });
            } else {
                await sock.sendMessage(jid, { text: `❌ Format salah atau urutan pesan tidak ditemukan.\nContoh untuk hapus pesan ke-2:\n*.delpesan 2*\n\nAtau untuk hapus semua ketik:\n*.delpesan semua*` });
            }
        }

        if (command === '.cekpesan' || command === '.listpesan') {
            if (savedMessages.length === 0 && (!savedMessage || !savedMessage.message)) {
                await sock.sendMessage(jid, { text: '⚠️ Tidak ada pesan promosi yang tersimpan.' });
                return;
            }
            
            await sock.sendMessage(jid, { text: `📋 *DAFTAR PESAN PROMOSI (${savedMessages.length} Pesan)*\n_Berikut adalah pesan-pesan yang akan dikirim secara rotasi:_` });
            
            for (let i = 0; i < savedMessages.length; i++) {
                let msgObjToUse = savedMessages[i];
                // Kirim label nomor pesannya dulu
                await sock.sendMessage(jid, { text: `*(Pesan ke-${i + 1})* 👇` });
                await new Promise(r => setTimeout(r, 200));
                
                // Kirim isi pesannya
                await sock.relayMessage(jid, msgObjToUse.message, { messageId: sock.generateMessageTag() });
                await new Promise(r => setTimeout(r, 800));
            }
            
            await sock.sendMessage(jid, { text: `💡 *Tip:* Untuk menghapus salah satu pesan, ketik misalnya *.delpesan 1* atau *.delpesan 2*\nUntuk menghapus semua, ketik *.delpesan semua*` });
        }

        if (command === '.addvcard') {
            const params = text.substring(9).trim().split('|');
            if (params.length < 2) {
                return await sock.sendMessage(jid, { text: '❌ Format salah. Contoh:\n*.addvcard Admin Jaseb|628123456789*' });
            }
            const nama = params[0].trim();
            const nomor = params[1].replace(/[^0-9]/g, '');
            
            const vcard = 'BEGIN:VCARD\n'
                + 'VERSION:3.0\n'
                + `FN:${nama}\n`
                + `TEL;type=CELL;type=VOICE;waid=${nomor}:+${nomor}\n`
                + 'END:VCARD';
                
            const contactMsg = {
                contactMessage: {
                    displayName: nama,
                    vcard: vcard
                }
            };
            
            const newMsg = {
                key: { remoteJid: jid, fromMe: true, id: activeSock.generateMessageTag(), participant: jid },
                message: contactMsg
            };
            
            savedMessages.push(newMsg);
            if (!savedMessage) savedMessage = newMsg;
            saveConfig();
            
            await sock.sendMessage(jid, { text: `✅ Kartu Kontak (VCard) berhasil ditambahkan ke rotasi promosi!\nNama: ${nama}\nNomor: ${nomor}` });
            await sock.sendMessage(jid, { contacts: { displayName: nama, contacts: [{ vcard }] } }); // Kasih preview
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
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi! Reply pesan dengan .setpesan atau .addpesan' });
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

        if (command === '.spamsekarang') {
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi! Reply pesan dengan .setpesan atau .addpesan' });
                return;
            }

            const jedaInput = parseInt(args[1]);
            const customDelay = !isNaN(jedaInput) ? jedaInput * 1000 : 0; // Default to 0ms if not provided

            await sock.sendMessage(jid, { text: `🚀 *Mulai Spam Sekarang!*\n\nMemindai grup... Jeda per grup: ${customDelay === 0 ? 'Tanpa Jeda' : jedaInput + ' detik'}.\nBot akan berjalan di background.` });

            // Run in background
            (async () => {
                const groupMetadata = await sock.groupFetchAllParticipating();
                const groups = Object.values(groupMetadata).reverse();
                
                let successCount = 0;
                let failCount = 0;
                let skipCount = 0;

                for (let i = 0; i < groups.length; i++) {
                    const group = groups[i];
                    const isAdminOnly = group.announce;
                    const isAnnounceGroup = group.isCommunityAnnounce;

                    if (blacklistedGroups.includes(group.id)) { skipCount++; continue; }
                    if (isAnnounceGroup) { skipCount++; continue; }
                    
                    if (blacklistKeywords.length > 0) {
                        const groupNameLower = group.subject.toLowerCase();
                        if (blacklistKeywords.some(kw => groupNameLower.includes(kw))) { skipCount++; continue; }
                    }

                    if (isAdminOnly) {
                        const me = group.participants.find(p => jidNormalizedUser(p.id) === jidNormalizedUser(activeSock.user.id));
                        if (!me?.admin) { skipCount++; continue; }
                    }

                    console.log(`[SPAM-SEKARANG] Mengirim ke: ${group.subject}...`);
                    const msgObjToUse = getNextMessageToUse();
                    const sentMsgId = await sendWithRetry(group.id, msgObjToUse.message, group.participants);

                    if (sentMsgId) {
                        successCount++;
                        if (autoDeleteMs > 0) {
                            const targetGroupId = group.id;
                            setTimeout(async () => {
                                try {
                                    await activeSock.sendMessage(targetGroupId, { delete: { remoteJid: targetGroupId, fromMe: true, id: sentMsgId } });
                                } catch(e) {}
                            }, autoDeleteMs);
                        }
                        if (autoClearChat) {
                            try {
                                const ts = Math.floor(Date.now() / 1000);
                                await activeSock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: group.id, id: sentMsgId, fromMe: true }, messageTimestamp: ts }] }, group.id);
                            } catch(e) {}
                        }
                    } else {
                        failCount++;
                    }

                    if (customDelay > 0 && i < groups.length - 1) {
                        await new Promise(resolve => setTimeout(resolve, customDelay));
                    }
                }

                await sock.sendMessage(jid, { text: `✅ *LAPORAN SPAM SEKARANG SELESAI*\n\n📊 *Hasil:*\n✔️ Berhasil: ${successCount}\n❌ Gagal: ${failCount}\n⏭️ Dilewati: ${skipCount}` });
            })();
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
            statusText += `Hidetag (Mention All): ${useHidetag ? '✅ ON' : '❌ OFF'}\n`;
            statusText += `Jam Tidur (Sleep): ${sleepTimeStart !== -1 ? `${sleepTimeStart}:00 - ${sleepTimeEnd}:00` : '❌ OFF (24 Jam)'}\n`;
            statusText += `Auto-Tarik Pesan: ${autoDeleteMs > 0 ? `${autoDeleteMs / 1000} detik` : '❌ OFF'}\n`;
            statusText += `Auto-Clear Chat: ${autoClearChat ? '✅ ON' : '❌ OFF'}\n`;
            statusText += `Grup Blacklist (Manual): ${blacklistedGroups.length} grup\n`;
            statusText += `Filter Kata Grup: ${blacklistKeywords.length > 0 ? blacklistKeywords.join(', ') : '❌ OFF'}\n`;
            statusText += `Rotasi Promosi: ${savedMessages.length > 1 ? `✅ Aktif (${savedMessages.length} pesan)` : '❌ OFF (1 pesan)'}\n`;
            statusText += `Pesan Utama: ${savedMessage ? '✅ Ada' : '❌ Belum di-set'}\n\n`;
            statusText += `Mode Rotasi Pesan: ${useMessageRotation ? '✅ Acak' : '❌ Berurutan'}\n`;
            statusText += `Ketik .menu untuk melihat daftar perintah.`;
            await sock.sendMessage(jid, { text: statusText });
        }

        if (command === '.rotasipesan') {
            const opt = args[1] ? args[1].toLowerCase() : '';
            if (opt === 'on') {
                useMessageRotation = true;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Mode *Rotasi Pesan Acak* diaktifkan!\nBot akan memilih pesan secara acak dari daftar .cekpesan` });
            } else if (opt === 'off') {
                useMessageRotation = false;
                currentMessageIndex = 0; // Reset ke pesan pertama
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Mode *Rotasi Pesan Acak* dimatikan!\nBot akan mengirim pesan *Sesuai Urutan* (Pesan 1, lalu 2, dst).` });
            } else {
                await sock.sendMessage(jid, { text: `❌ Format salah.\nGunakan: .rotasipesan on\nAtau: .rotasipesan off\n\nStatus saat ini: ${useMessageRotation ? 'Acak' : 'Berurutan'}` });
            }
        }

        if (command === '.addowner') {
            const num = args[1];
            if (!num) return await sock.sendMessage(jid, { text: `❌ Masukkan nomor!\nContoh: .addowner 628123456789` });
            const cleanNum = num.replace(/[^0-9]/g, '');
            if (!ownerNumbers.includes(cleanNum)) {
                ownerNumbers.push(cleanNum);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Nomor ${cleanNum} berhasil ditambahkan sebagai Owner.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Nomor ${cleanNum} sudah ada di daftar Owner.` });
            }
        }

        if (command === '.delowner') {
            const num = args[1];
            if (!num) return await sock.sendMessage(jid, { text: `❌ Masukkan nomor!\nContoh: .delowner 628123456789` });
            const cleanNum = num.replace(/[^0-9]/g, '');
            const idx = ownerNumbers.indexOf(cleanNum);
            if (idx > -1) {
                ownerNumbers.splice(idx, 1);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Nomor ${cleanNum} berhasil dihapus dari daftar Owner.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Nomor ${cleanNum} tidak ditemukan di daftar Owner.` });
            }
        }

        if (command === '.listowner') {
            if (ownerNumbers.length === 0) return await sock.sendMessage(jid, { text: `📋 Daftar Owner tambahan kosong.` });
            let txt = `📋 *DAFTAR OWNER BOT*\n\n`;
            ownerNumbers.forEach((n, i) => txt += `${i+1}. ${n}\n`);
            await sock.sendMessage(jid, { text: txt });
        }
        
        if (command === '.menu') {
            const menuText = `*DAFTAR PERINTAH BOT*\n\n` +
            `.listgrup\n` +
            `.setpesan\n` +
            `.addpesan\n` +
            `.cekpesan\n` +
            `.delpesan\n` +
            `.addvcard <nama>|<nomor>\n` +
            `.pushkontak\n` +
            `.setwaktu <angka> <menit/jam>\n` +
            `.setjeda <angka> <detik>\n` +
            `.sethidetag <on/off>\n` +
            `.rotasipesan <on/off>\n` +
            `.autoclear <on/off>\n` +
            `.setautodelete <angka> <detik/menit> | off\n` +
            `.setsleep <jamMulai> <jamSelesai> | off\n` +
            `.cleangrup\n` +
            `.blacklist\n` +
            `.blacklistkata <kata1, kata2>\n` +
            `.unblacklist\n` +
            `.teskirim\n` +
            `.startspam\n` +
            `.spamsekarang\n` +
            `.stopspam\n` +
            `.cekconfig\n` +
            `.addbotjaseb\n` +
            `.addowner\n` +
            `.delowner\n` +
            `.listowner`;

            await sock.sendMessage(jid, { text: menuText });
        }

        if (command === '.teskirim') {
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
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
                const msgObjToUse = getNextMessageToUse();
                // Menggunakan relayMessage untuk bypass validasi media dan menjaga metadata asli (View Channel)
                await sock.relayMessage(targetGroupJid, msgObjToUse.message, { messageId: sock.generateMessageTag() });
                console.log(`[TES] Berhasil dikirim ke: ${targetGroupName}`);
                await sock.sendMessage(jid, { text: `✅ Berhasil dikirim ke grup: *${targetGroupName}*` });
            } catch (err) {
                console.error(`[TES] Gagal kirim ke ${targetGroupName}:`, err);
                await sock.sendMessage(jid, { text: `❌ Gagal mengirim tes ke *${targetGroupName}*: ${err.message}` });
            }
        }
    } catch (err) {
        console.error('[ERROR] Terjadi kesalahan saat memproses pesan:', err);
    }
});


}

startBot();
