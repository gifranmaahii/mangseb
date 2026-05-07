const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    jidNormalizedUser,
    getContentType,
    generateWAMessageFromContent,
    generateWAMessageContent,
    downloadContentFromMessage,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const fs = require('fs');
const crypto = require('crypto');

const logger = pino({ level: 'silent' });

const sessionName = process.argv[2] || 'auth_info';
const configFile = process.argv[2] ? `./config_${process.argv[2]}.json` : './config.json';

let savedMessage = null;
let savedSwgcMessage = null; // Pesan khusus untuk SWGC
let useDedicatedSwgcMessage = false; // Toggle pakai pesan khusus SWGC
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
let ownerNumbers = ['6283120144186', '6283120144186@s.whatsapp.net', '249928542642268']; // Daftar nomor owner tambahan
let linkScraper = false; // Fitur pemantau link
let scraperTargetJid = null; // Tujuan laporan link scraper
let priorityMainMessage = false; // Prioritas pesan utama (.setpesan)
let mainMessagePriorityPercent = 60; // Persentase prioritas pesan utama (0-100)
let doubleMessageMode = false; // Kirim 2 pesan per grup (utama + rotasi)
let doubleMessageDelay = 5000; // Jeda antar pesan dalam grup (ms)
let useZws = false; // Gunakan Zero Width Space pada link
let editMode = 'off'; // off, on, auto
let guardedGroups = []; // Daftar grup yang terdeteksi ada bot penjaga
let scrapedLinks = []; // Database link yang sudah ditemukan
const scrapedLinksFile = './scraped_links.json';

let isAutoSwgc = false; // Flag Auto SWGC
let autoSwgcCronExpression = '*/30 * * * *'; // Default 30 menit
let autoSwgcJob = null;

let useInteractiveLink = false; // Toggle Kotak Link Interaktif
let interactiveLink = '';
let interactiveTitle = 'GABUNG GRUP BOT';
let interactiveBody = 'Klik di sini untuk bergabung!';
let interactiveThumbnail = null; // Buffer atau Base64 gambar

// Cache untuk deteksi bot penjaga
let sentMessagesRecord = new Map(); // ID Pesan -> { groupId, timestamp }
let intentionalDeletions = new Map(); // ID Pesan -> timestamp

let groupCache = null;
let lastGroupCacheTime = 0;
const GROUP_CACHE_TTL = 600000; // 10 menit
let isFetchingGroups = false;

async function getGroups() {
    const now = Date.now();
    
    if (groupCache && (now - lastGroupCacheTime < GROUP_CACHE_TTL)) {
        return groupCache;
    }
    if (!activeSock) return [];
    
    if (isFetchingGroups) {
        while (isFetchingGroups) {
            await new Promise(r => setTimeout(r, 1000));
        }
        return groupCache || [];
    }

    isFetchingGroups = true;
    try {
        console.log('[CACHE] Refreshing group list metadata...');
        const groupMetadata = await activeSock.groupFetchAllParticipating();
        groupCache = Object.values(groupMetadata);
        lastGroupCacheTime = now;
    } catch (e) {
        console.error('[CACHE] Gagal mengambil daftar grup:', e.message);
    } finally {
        isFetchingGroups = false;
    }
    return groupCache || [];
}

// Fungsi membersihkan file sesi lama (> 2 hari)
function cleanupSessions() {
    if (!fs.existsSync(sessionName)) return;
    const files = fs.readdirSync(sessionName);
    const now = Date.now();
    let deletedCount = 0;
    
    // Daftar prefix file yang aman untuk dibersihkan jika sudah usang
    const cleanupPrefixes = ['session-', 'pre-key-', 'sender-key-', 'app-state-', 'next-pre-key-'];
    
    files.forEach(file => {
        const isTarget = cleanupPrefixes.some(prefix => file.startsWith(prefix)) && file.endsWith('.json');
        if (isTarget && file !== 'creds.json') {
            const filePath = `${sessionName}/${file}`;
            try {
                const stats = fs.statSync(filePath);
                const ageMs = now - stats.mtimeMs;
                if (ageMs > 2 * 24 * 60 * 60 * 1000) { // Hapus jika > 2 hari
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            } catch(e) {}
        }
    });
    if (deletedCount > 0) console.log(`[CLEANUP] Berhasil menghapus ${deletedCount} file sesi/kunci usang untuk menghemat ruang.`);
}

// Cleanup interval lebih sering (setiap 2 menit)
setInterval(() => {
    const now = Date.now();
    // Bersihkan record pesan yang sudah lewat 5 menit (sebelumnya 10 menit)
    for (const [id, data] of sentMessagesRecord.entries()) {
        if (now - data.timestamp > 300000) sentMessagesRecord.delete(id);
    }
    // Bersihkan record delete yang sudah lewat 1 menit
    for (const [id, timestamp] of intentionalDeletions.entries()) {
        if (now - timestamp > 60000) intentionalDeletions.delete(id);
    }
    
    // Paksa GC jika tersedia (jalankan dengan --expose-gc)
    if (global.gc) {
        global.gc();
        console.log('[MEM] Garbage Collection executed.');
    }
    
    // Jalankan pembersihan sesi setiap 1 jam
    if (new Date().getMinutes() < 2) {
        cleanupSessions();
    }
}, 120000);

// Load scraped links
if (fs.existsSync(scrapedLinksFile)) {
    try { scrapedLinks = JSON.parse(fs.readFileSync(scrapedLinksFile)); } catch(e) {}
}

function saveScrapedLinks() {
    fs.writeFileSync(scrapedLinksFile, JSON.stringify(scrapedLinks, null, 2));
}

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
        ownerNumbers = config.ownerNumbers || ownerNumbers; // Preserve defaults if missing in config
        linkScraper = config.linkScraper || false;
        scraperTargetJid = config.scraperTargetJid || null;
        priorityMainMessage = config.priorityMainMessage || false;
        mainMessagePriorityPercent = config.mainMessagePriorityPercent !== undefined ? config.mainMessagePriorityPercent : 60;
        doubleMessageMode = config.doubleMessageMode || false;
        doubleMessageDelay = config.doubleMessageDelay || 5000;
        useZws = config.useZws || false;
        editMode = config.editMode || 'off';
        guardedGroups = config.guardedGroups || [];
        isAutoSwgc = config.isAutoSwgc || false;
        autoSwgcCronExpression = config.autoSwgcCronExpression || '*/30 * * * *';
        savedSwgcMessage = config.savedSwgcMessage || null;
        useDedicatedSwgcMessage = config.useDedicatedSwgcMessage || false;

        useInteractiveLink = config.useInteractiveLink || false;
        interactiveLink = config.interactiveLink || '';
        interactiveTitle = config.interactiveTitle || 'GABUNG GRUP BOT';
        interactiveBody = config.interactiveBody || 'Klik di sini untuk bergabung!';
        interactiveThumbnail = config.interactiveThumbnail ? Buffer.from(config.interactiveThumbnail, 'base64') : null;
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

// Ensure config file is up to date with all fields
saveConfig();

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
        ownerNumbers,
        linkScraper,
        scraperTargetJid,
        priorityMainMessage,
        mainMessagePriorityPercent,
        doubleMessageMode,
        doubleMessageDelay,
        useZws,
        editMode,
        guardedGroups,
        isAutoSwgc,
        autoSwgcCronExpression,
        savedSwgcMessage,
        useDedicatedSwgcMessage,
        useInteractiveLink,
        interactiveLink,
        interactiveTitle,
        interactiveBody,
        interactiveThumbnail: interactiveThumbnail ? interactiveThumbnail.toString('base64') : null
    }, null, 2));
}

const { exec } = require('child_process');

async function handleJadibot(senderJid, type, number = '') {
    const cleanNumber = number ? number.replace(/[^0-9]/g, '') : `guest_${Date.now().toString().slice(-6)}`;
    const sessionFolder = `auth_info_${cleanNumber}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);
    const { version } = await fetchLatestBaileysVersion();
    
    const botSock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        browser: ['Mangseb Bot Pro', 'Chrome', '1.0.0'],
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
            exec(`pm2 start index.js --node-args="--max-old-space-size=1024 --expose-gc" --name ${pm2Name} -- ${sessionFolder}`, (error, stdout, stderr) => {
                if (error) {
                    activeSock.sendMessage(senderJid, { text: `❌ Gagal menjalankan bot di PM2: ${error.message}\nCoba jalankan manual: "start": "node --max-old-space-size=1024 --expose-gc index.js", ${sessionFolder}` });
                } else {
                    activeSock.sendMessage(senderJid, { text: `🚀 *BOT JASEB AKTIF!*\n\nStatus PM2: Berhasil ✅\nKetik .menu di nomor bot baru Anda untuk mulai mengatur spam.` });
                }
            });
        }
    });
}

// Helper: Sisipkan Zero Width Space ke Link
function injectZws(text) {
    if (!text || !useZws) return text;
    // Menyisipkan \u200B setelah https://chat.whatsapp.com/
    return text.replace(/(https:\/\/chat\.whatsapp\.com\/)/g, "$1\u200B");
}

// Helper: dapatkan pesan selanjutnya
function getNextMessageToUse() {
    if (savedMessages.length > 0) {
        let selectedMsg;
        // Jika prioritas pesan utama ON, gunakan peluang berdasarkan persentase yang di-set
        if (priorityMainMessage && savedMessage) {
            const chance = mainMessagePriorityPercent / 100;
            if (Math.random() < chance) {
                selectedMsg = JSON.parse(JSON.stringify(savedMessage));
            }
        }

        if (!selectedMsg) {
            if (useMessageRotation) {
                selectedMsg = JSON.parse(JSON.stringify(savedMessages[Math.floor(Math.random() * savedMessages.length)]));
            } else {
                selectedMsg = JSON.parse(JSON.stringify(savedMessages[currentMessageIndex % savedMessages.length]));
                currentMessageIndex++;
            }
        }

        // Terapkan Spin Text dan ZWS jika aktif
        if (selectedMsg && selectedMsg.message) {
            // Gunakan struktur pesan langsung tanpa cloning berat
            const type = getContentType(selectedMsg.message);
            if (type === 'conversation') {
                selectedMsg.message.conversation = injectZws(processSpinText(selectedMsg.message.conversation));
            } else if (selectedMsg.message[type]?.caption) {
                selectedMsg.message[type].caption = injectZws(processSpinText(selectedMsg.message[type].caption));
            } else if (selectedMsg.message.extendedTextMessage?.text) {
                selectedMsg.message.extendedTextMessage.text = injectZws(processSpinText(selectedMsg.message.extendedTextMessage.text));
            }
        }
        return selectedMsg;
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
    if (!activeSock) return null;

    // --- LOGIKA EDIT MODE (BYPASS SENSOR) ---
    const isGuarded = guardedGroups.includes(groupId);
    const shouldEdit = editMode === 'on' || (editMode === 'auto' && isGuarded);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            if (!activeSock.ws?.isOpen) {
                await new Promise(r => setTimeout(r, 3000));
                if (!activeSock.ws?.isOpen) throw new Error(`WebSocket disconnected`);
            }

            let messageId = activeSock.generateMessageTag();
            let finalMessage = JSON.parse(JSON.stringify(message));

            // --- 1. INJEKSI KOTAK LINK INTERAKTIF (External Ad Reply) ---
            if (useInteractiveLink && interactiveLink) {
                const mType = getContentType(finalMessage);
                
                const adReply = {
                    title: interactiveTitle,
                    body: interactiveBody,
                    sourceUrl: interactiveLink,
                    mediaType: 1,
                    showAdAttribution: true,
                    renderLargerThumbnail: true,
                    thumbnail: interactiveThumbnail || finalMessage.jpegThumbnail || null
                };

                // Injeksi ke Root
                if (!finalMessage.contextInfo) finalMessage.contextInfo = {};
                finalMessage.contextInfo.externalAdReply = adReply;

                // Injeksi ke Type-Specific (Penting untuk Media/ExtendedText)
                if (mType && finalMessage[mType]) {
                    if (!finalMessage[mType].contextInfo) finalMessage[mType].contextInfo = {};
                    finalMessage[mType].contextInfo.externalAdReply = adReply;
                }
            }

            const type = getContentType(finalMessage);

            // Jika harus pakai Edit Mode (Bypass)
            if (shouldEdit && (type === 'conversation' || finalMessage[type]?.caption || finalMessage.extendedTextMessage?.text)) {
                let originalContent = finalMessage.conversation || finalMessage[type]?.caption || finalMessage.extendedTextMessage?.text || "";
                
                // Ambil contextInfo yang sudah digabung (Newsletter + Link Box)
                const contextInfo = finalMessage.contextInfo || (type && finalMessage[type]?.contextInfo) || null;
                const linkRegex = /(https:\/\/chat\.whatsapp\.com\/[^\s\n]+|https:\/\/whatsapp\.com\/channel\/[^\s\n]+)/g;
                
                if (linkRegex.test(originalContent)) {
                    // --- 1. SMART SPLIT BYPASS UNTUK SHARE SALURAN (MEWAH) ---
                    // Kita gunakan 2 pesan hanya jika ini benar-benar Forwarded Newsletter (Saluran)
                    if (contextInfo?.forwardedNewsletterMessageInfo) {
                        console.log(`[BYPASS] Smart Split: Mengirim Pesan Saluran (Mewah) untuk grup ${groupId}...`);
                        const safeContent = originalContent.replace(linkRegex, '[Link di bawah 👇]');
                        
                        // Kirim Pesan Saluran Utama (Tanpa Link)
                        const mainMsg = await activeSock.sendMessage(groupId, { 
                            text: safeContent, 
                            contextInfo: contextInfo 
                        });

                        // Kirim Pesan Kedua khusus Link (Gunakan Edit Mode agar lebih aman)
                        const linkOnly = originalContent.match(linkRegex).join('\n');
                        const linkMsg = await activeSock.sendMessage(groupId, { text: "⏳ Mengambil link..." });
                        if (linkMsg?.key) {
                            setTimeout(async () => {
                                try {
                                    await activeSock.sendMessage(groupId, { 
                                        edit: linkMsg.key, 
                                        text: `🔗 *LINK GABUNG:*\n${linkOnly}` 
                                    });
                                    console.log(`[BYPASS] ✅ Smart Split Link Berhasil di ${groupId}`);
                                } catch (e) {
                                    console.error(`[BYPASS] ❌ Gagal edit link split:`, e.message);
                                }
                            }, 5000);
                        }

                        if (mainMsg?.key?.id) {
                            sentMessagesRecord.set(mainMsg.key.id, { groupId, timestamp: Date.now() });
                            return mainMsg.key.id;
                        }
                    } 
                    
                    // --- 2. EDIT MODE NORMAL ---
                    else {
                        console.log(`[BYPASS] Normal Edit: Mengirim pesan teks tunggal untuk grup ${groupId}...`);
                        const safeContent = originalContent.replace(linkRegex, '').trim() || "Promosi Terbaru:";
                        
                        const firstMsg = await activeSock.sendMessage(groupId, { 
                            text: safeContent, 
                            contextInfo: contextInfo 
                        });

                        if (firstMsg?.key) {
                            const targetKey = firstMsg.key;
                            setTimeout(async () => {
                                try {
                                    if (!activeSock) return;
                                    await activeSock.sendMessage(groupId, { edit: targetKey, ...finalMessage });
                                } catch (e) {}
                            }, 5000);
                            return targetKey.id;
                        }
                    }
                }
            }

            // --- PENGIRIMAN NORMAL (TIDAK EDIT) ---
            if (finalMessage.conversation) {
                finalMessage.conversation = processSpinText(finalMessage.conversation);
            } else if (finalMessage.extendedTextMessage?.text) {
                finalMessage.extendedTextMessage.text = processSpinText(finalMessage.extendedTextMessage.text);
            } else if (finalMessage[type]?.caption) {
                finalMessage[type].caption = processSpinText(finalMessage[type].caption);
            }

            if (useHidetag && participants && participants.length > 0) {
                const jids = participants.map(p => p.id);
                if (finalMessage.conversation) {
                    finalMessage.extendedTextMessage = { text: finalMessage.conversation, contextInfo: { mentionedJid: jids } };
                    delete finalMessage.conversation;
                } else if (finalMessage.extendedTextMessage) {
                    finalMessage.extendedTextMessage.contextInfo = { ...finalMessage.extendedTextMessage.contextInfo, mentionedJid: jids };
                } else if (finalMessage[type]) {
                    finalMessage[type].contextInfo = { ...finalMessage[type].contextInfo, mentionedJid: jids };
                }
            }

            let result;
            if (attempt <= 2) {
                await activeSock.relayMessage(groupId, finalMessage, { messageId });
            } else {
                if (finalMessage.conversation) result = await activeSock.sendMessage(groupId, { text: finalMessage.conversation });
                else if (finalMessage.extendedTextMessage) result = await activeSock.sendMessage(groupId, { text: finalMessage.extendedTextMessage.text });
                else if (finalMessage[type]) result = await activeSock.sendMessage(groupId, { [type]: finalMessage[type] });
                if (result?.key?.id) messageId = result.key.id;
            }

            if (messageId) {
                sentMessagesRecord.set(messageId, { groupId, timestamp: Date.now() });
            }
            return messageId;

        } catch (err) {
            console.error(`[RETRY] Attempt ${attempt}/${maxRetries} gagal:`, err.message);
            if (attempt < maxRetries) await new Promise(r => setTimeout(r, 2000));
        }
    }
    return null;
}

const BG_COLORS = [
    "#FF5733", "#33FF57", "#3357FF", "#F033FF", "#FF33F0",
    "#33FFF0", "#F0FF33", "#FF8333", "#8333FF", "#33FF83",
];

async function sendStoryToGroup(sock, jid, data) {
    // data = { type: 'text'|'image'|'video', text, buffer, mime }
    try {
        let content;
        if (data.buffer) {
            content = {
                [data.type]: data.buffer,
                caption: data.text,
                mimetype: data.mime,
            };
        } else {
            const color = BG_COLORS[Math.floor(Math.random() * BG_COLORS.length)];
            content = {
                text: data.text || "",
                backgroundColor: color,
                font: Math.floor(Math.random() * 7) + 1,
            };
        }

        const inside = await generateWAMessageContent(content, {
            upload: sock.waUploadToServer,
            logger: pino({ level: 'silent' }),
        });

        const messageSecret = crypto.randomBytes(32);
        const msg = await generateWAMessageFromContent(jid, {
            messageContextInfo: { messageSecret },
            groupStatusMessageV2: {
                message: {
                    ...inside,
                    messageContextInfo: { messageSecret },
                },
            },
        }, { userJid: sock.user.id });

        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        return true;
    } catch (e) {
        console.error(`[SWGC] Gagal kirim ke ${jid}:`, e.message);
        return false;
    }
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

            const groups = (await getGroups()).slice().reverse();
            
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
                let messagesToSend = [];
                if (doubleMessageMode && savedMessage && savedMessages.length > 0) {
                    messagesToSend.push(savedMessage); // push as is, cloning done in sendWithRetry
                    messagesToSend.push(getNextMessageToUse());
                } else {
                    messagesToSend.push(getNextMessageToUse());
                }

                let isAnySuccess = false;
                for (let j = 0; j < messagesToSend.length; j++) {
                    let msgObj = messagesToSend[j];
                    if (j > 0) await new Promise(r => setTimeout(r, doubleMessageDelay));

                    sentMsgId = await sendWithRetry(group.id, msgObj.message, group.participants);

                    if (sentMsgId) {
                        isAnySuccess = true;
                        // Jadwalkan auto-delete jika diset
                        if (autoDeleteMs > 0) {
                            const targetGroupId = group.id;
                            const messageId = sentMsgId;
                            setTimeout(async () => {
                                try {
                                    intentionalDeletions.set(messageId, Date.now());
                                    await activeSock.sendMessage(targetGroupId, { delete: { remoteJid: targetGroupId, fromMe: true, id: messageId } });
                                } catch(e) {}
                            }, autoDeleteMs);
                        }
                        if (autoClearChat) {
                            try {
                                const ts = Math.floor(Date.now() / 1000);
                                await activeSock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: group.id, id: sentMsgId, fromMe: true }, messageTimestamp: ts }] }, group.id);
                            } catch(e) {}
                        }
                    }
                }

                if (isAnySuccess) {
                    successCount++;
                    console.log(`[SPAM] ✅ Berhasil kirim ke ${group.subject} (${successCount} berhasil)`);
                } else {
                    failCount++;
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
    spamJobRunning = false;
    spamCycleCount = 0;
}

async function runAutoSwgcCycle() {
    if (!activeSock) return;
    console.log('[AUTO-SWGC] Memulai siklus story otomatis...');
    
    try {
        // Logika Mode:
        let msgObj = null;
        if (useDedicatedSwgcMessage) {
            msgObj = savedSwgcMessage;
            if (!msgObj) {
                console.log('[AUTO-SWGC] Skip: Mode Khusus ON tapi pesan SWGC belum di-set.');
                return;
            }
        } else {
            msgObj = savedMessage;
        }

        if (!msgObj) {
            console.log('[AUTO-SWGC] Skip: Tidak ada pesan yang tersedia.');
            return;
        }

        const type = getContentType(msgObj.message);
        let mediaData = null;

        if (type === 'imageMessage' || type === 'videoMessage') {
            const stream = await downloadContentFromMessage(msgObj.message[type], type.replace('Message', ''));
            let buf = Buffer.alloc(0);
            for await(const chunk of stream) {
                buf = Buffer.concat([buf, chunk]);
            }
            mediaData = {
                type: type.replace('Message', ''),
                text: processSpinText(msgObj.message[type].caption || ''),
                buffer: buf,
                mime: msgObj.message[type].mimetype
            };
        } else {
            let text = "";
            if (type === 'conversation') text = msgObj.message.conversation;
            else if (type === 'extendedTextMessage') text = msgObj.message.extendedTextMessage.text;
            mediaData = { type: 'text', text: processSpinText(text), buffer: null };
        }

        if (!mediaData) return;

        // Kirim ke Status
        await sendStoryToGroup(activeSock, "status@broadcast", mediaData);
        
        // Kirim ke semua grup
        const groups = await getGroups();
        for (const group of groups) {
            if (blacklistedGroups.includes(group.id)) continue;
            await sendStoryToGroup(activeSock, group.id, mediaData);
            await new Promise(r => setTimeout(r, 3000));
        }
        console.log('[AUTO-SWGC] Siklus selesai.');
    } catch (e) {
        console.error('[AUTO-SWGC] Error:', e.message);
    }
}

function startAutoSwgcJob() {
    if (autoSwgcJob) autoSwgcJob.stop();
    autoSwgcJob = cron.schedule(autoSwgcCronExpression, runAutoSwgcCycle);
    autoSwgcJob.start();
}

function stopAutoSwgcJob() {
    if (autoSwgcJob) {
        autoSwgcJob.stop();
        autoSwgcJob = null;
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(sessionName);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`Menggunakan WA v${version.join('.')}, isLatest: ${isLatest}`);

    let loginMethod = 'qr';
    const sock = makeWASocket({
        version,
        logger,
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        printQRInTerminal: true,
        browser: ['Mangseb Bot Pro', 'Windows', '3.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnline: true, 
        shouldSyncHistoryMessage: () => false, 
        retryRequestDelayMs: 5000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0, 
    });

    if (!sock.authState.creds.registered) {
        loginMethod = 'prompt'; // Sedang memilih
        const readline = require('readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const question = (text) => new Promise((resolve) => rl.question(text, resolve));

        setTimeout(async () => {
            console.log(`\n========================================`);
            console.log(`   PILIH METODE LOGIN`);
            console.log(`========================================`);
            console.log(`1. QR Code`);
            console.log(`2. Pairing Code`);
            console.log(`========================================`);
            let opsi = await question('Masukkan pilihan (1/2): ');
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
        
        if (qr) {
            // Langsung munculkan QR di terminal jika tersedia, tanpa menunggu input
            if (loginMethod === 'qr' || loginMethod === 'prompt') {
                qrcode.generate(qr, { small: true });
            }
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
            const botNumber = sock.user.id.split(':')[0];
            if (!ownerNumbers.includes(botNumber)) {
                ownerNumbers.push(botNumber);
                console.log(`[SYSTEM] Nomor bot (${botNumber}) otomatis ditambahkan sebagai Owner.`);
            }
            if (isAutoSwgc) {
                startAutoSwgcJob();
                console.log('[SYSTEM] Auto SWGC diaktifkan kembali.');
            }
        }
    });

    sock.ev.on('messages.upsert', async m => {
        try {
            const msg = m.messages[0];
            if (!msg || !msg.message) return;

            // --- FILTER PESAN LAMA (HISTORY/DELAYED) ---
            const messageTimestamp = msg.messageTimestamp;
            const nowSeconds = Math.floor(Date.now() / 1000);
            if (nowSeconds - messageTimestamp > 60) {
                // Abaikan pesan yang lebih tua dari 60 detik
                return;
            }

            const jid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;
            
            // Ekstraksi teks
            const type = getContentType(msg.message);
            let text = "";
            if (type === 'conversation') text = msg.message.conversation;
            else if (type === 'extendedTextMessage') text = msg.message.extendedTextMessage.text;
            else if (msg.message[type]?.caption) text = msg.message[type].caption;
            else if (msg.message[type]?.text) text = msg.message[type].text;

            const senderJid = msg.key.participant || msg.key.remoteJid || "";
            const senderNumber = senderJid.replace(/[^0-9]/g, ''); // Ambil angka saja
            
            const isOwner = fromMe || ownerNumbers.some(owner => senderNumber.includes(owner.replace(/[^0-9]/g, '')));
            const isCommand = text.startsWith('.');

            // Log HANYA jika itu perintah atau dari owner (agar tidak sampah log grup)
            if (isCommand || isOwner) {
                if (text) console.log(`[MSG] Dari: ${senderNumber} | Me: ${fromMe} | Teks: ${text.substring(0, 40)}`);
            }

            const args = text ? text.split(' ') : [];
            const command = args.length > 0 ? args[0].toLowerCase() : "";

            if (!isOwner) {
                if (isCommand) console.log(`[AUTH] Perintah ${command} diabaikan: ${senderNumber} bukan Owner.`);
                return; 
            }
            if (isCommand) {
                console.log(`[CMD] Menjalankan: ${command} oleh ${senderNumber}`);
            }

            // --- DETEKSI PENGHAPUSAN PESAN (REVOKE/DELETE) ---
            if (msg.message?.protocolMessage?.type === 0 || msg.message?.protocolMessage?.type === 'REVOKE') {
                const targetId = msg.message.protocolMessage.key.id;
                const record = sentMessagesRecord.get(targetId);
                console.log(`[SENSOR-UPSERT] Terdeteksi ProtocolMessage (Delete) ID: ${targetId}`);
                
                if (record) {
                    const groupId = record.groupId;
                    console.log(`[SENSOR-UPSERT] Match! Pesan kita di grup ${groupId} dihapus.`);
                    if (!guardedGroups.includes(groupId)) {
                        guardedGroups.push(groupId);
                        saveConfig();
                        if (spamOwnerJid) {
                            sock.sendMessage(spamOwnerJid, { text: `⚠️ *SENSOR BOT (UPSERT)*\n\nBot penjaga terdeteksi di grup:\n*${groupId}*\n\nBot akan otomatis menggunakan Edit Mode.` }).catch(() => {});
                        }
                    }
                }
            }

            // --- FITUR LINK SCRAPER (MONITORING GRUP) ---
            if (linkScraper && jid.endsWith('@g.us') && !fromMe) {
                const linkRegex = /https:\/\/chat\.whatsapp\.com\/[a-zA-Z0-9]+/g;
                const linksFound = text.match(linkRegex);
                
                if (linksFound) {
                    console.log(`[SCRAPER] Terdeteksi link di grup ${jid}, mengecek kata kunci...`);
                    const keywords = ['own ch', 'jual', 'beli', 'saluran', 'channel', 'jaseb', 'admin', 'up', 'saluram', 'ch'];
                    const hasKeyword = keywords.some(k => text.toLowerCase().includes(k));
                    
                    if (hasKeyword) {
                        for (const link of linksFound) {
                            if (!scrapedLinks.includes(link)) {
                                console.log(`[SCRAPER] Link baru ditemukan: ${link}. Mengirim ke owner...`);
                                scrapedLinks.push(link);
                                if (scrapedLinks.length > 500) scrapedLinks.shift();
                                saveScrapedLinks();
                                
                                // Tentukan target pengiriman (Target Jid atau Owner Pertama atau Bot Sendiri)
                                const target = scraperTargetJid || (ownerNumbers.length > 0 ? ownerNumbers[0] + '@s.whatsapp.net' : sock.user.id);
                                
                                const report = `📢 *LINK TERDETEKSI!*\n\n`
                                    + `👥 *Grup ID:* ${jid}\n`
                                    + `👤 *Pengirim:* ${msg.pushName || 'User'}\n`
                                    + `📝 *Pesan:* ${text}\n\n`
                                    + `🔗 *Link:* ${link}`;
                                
                                await sock.sendMessage(target, { text: report }).catch(e => console.error(`[SCRAPER] Gagal kirim ke ${target}:`, e));
                            } else {
                                console.log(`[SCRAPER] Link sudah pernah diproses: ${link}`);
                            }
                        }
                    } else {
                        console.log(`[SCRAPER] Tidak ada kata kunci yang cocok dalam pesan.`);
                    }
                }
            }


            // Hanya simpan pesan terakhir jika: BUKAN command, DI CHAT PRIBADI, dan BUKAN dari bot sendiri
            if (!isCommand && !jid.endsWith('@g.us') && !fromMe) {
                lastNonCommandMessage = msg;
                console.log(`[DEBUG] Berhasil menangkap pesan terakhir untuk calon promosi: ${getContentType(msg.message)}`);
            }

        if (command === '.pushkontak') {
            const isQuotedDocument = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.documentMessage;
            const quotedText = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.conversation || 
                               msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text || "";

            let rawTextData = "";

            if (isQuotedDocument) {
                try {
                    await sock.sendMessage(jid, { text: "⏳ Mendownload file kontak..." });
                    const stream = await downloadContentFromMessage(isQuotedDocument, 'document');
                    let buffer = Buffer.alloc(0);
                    for await(const chunk of stream) {
                        buffer = Buffer.concat([buffer, chunk]);
                        // Batasi ukuran untuk mencegah crash
                        if (buffer.length > 10 * 1024 * 1024) { 
                             sock.sendMessage(jid, { text: "❌ File terlalu besar (maks 10MB)." }).catch(() => {});
                             break;
                        }
                    }
                    rawTextData = buffer.toString('utf-8');
                    buffer = null; // Free memory immediately
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

        // ==========================================
        // COMMAND: .listgrup [halaman]
        // ==========================================
        if (command === '.listgrup') {
            const page = parseInt(args[1]) || 1;
            const pageSize = 25;
            
            await sock.sendMessage(jid, { text: '⏳ Sedang mengambil daftar grup...' });
            const allGroups = await getGroups();
            
            if (allGroups.length === 0) {
                return await sock.sendMessage(jid, { text: '⚠️ Tidak ada grup yang ditemukan.' });
            }

            const totalPages = Math.ceil(allGroups.length / pageSize);
            if (page > totalPages) {
                return await sock.sendMessage(jid, { text: `❌ Halaman ${page} tidak tersedia. Total halaman: ${totalPages}` });
            }

            const startIdx = (page - 1) * pageSize;
            const endIdx = startIdx + pageSize;
            const pagedGroups = allGroups.slice(startIdx, endIdx);

            let response = `📋 *DAFTAR GRUP (Hal ${page}/${totalPages})*\n`;
            response += `Total: ${allGroups.length} grup\n\n`;

            pagedGroups.forEach((g, i) => {
                const isBlacklisted = blacklistedGroups.includes(g.id);
                const isGuarded = guardedGroups.includes(g.id);
                let status = isBlacklisted ? '🚫' : (isGuarded ? '🛡️' : '✅');
                
                response += `${startIdx + i + 1}. *${g.subject}*\nID: \`${g.id}\` [${status}]\n\n`;
            });

            if (page < totalPages) {
                response += `\n💡 Ketik \`.listgrup ${page + 1}\` untuk halaman berikutnya.`;
            }

            await sock.sendMessage(jid, { text: response });
            return;
        }

        // ==========================================
        // COMMAND: .cekgrup [nama]
        // ==========================================
        if (command === '.cekgrup') {
            const query = args.slice(1).join(' ').toLowerCase();
            if (query.length < 3) {
                return await sock.sendMessage(jid, { text: '⚠️ Masukkan minimal 3 karakter untuk mencari grup agar bot tidak berat.' });
            }

            await sock.sendMessage(jid, { text: `🔍 Mencari: "${query}"...` });
            const allGroups = await getGroups();
            const filtered = allGroups.filter(g => g.subject.toLowerCase().includes(query));

            if (filtered.length === 0) {
                return await sock.sendMessage(jid, { text: `❌ Tidak ditemukan grup dengan nama "${query}".` });
            }

            let response = `🔍 *HASIL PENCARIAN*\n`;
            response += `Ditemukan: ${filtered.length} grup\n`;
            response += `_Menampilkan 10 hasil teratas:_\n\n`;

            filtered.slice(0, 10).forEach((g, i) => {
                const isBlacklisted = blacklistedGroups.includes(g.id);
                const isGuarded = guardedGroups.includes(g.id);
                let status = isBlacklisted ? '🚫' : (isGuarded ? '🛡️' : '✅');
                
                response += `${i + 1}. *${g.subject.substring(0, 30)}*\nID: \`${g.id}\` [${status}]\n\n`;
            });

            if (filtered.length > 10) {
                response += `\n💡 Ada ${filtered.length - 10} grup lain, gunakan nama yang lebih spesifik.`;
            }

            await sock.sendMessage(jid, { text: response });
            return;
        }

        if (command === '.blacklist') {
            const groups = await getGroups();
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
            const groupsList = await getGroups();
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
                const groupsList = await getGroups();
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

        if (command === '.setpesan' || command === '.addpesan') {
            const contextInfo = msg.message[type]?.contextInfo;
            let targetMsg = null;
            let source = "";

            // 1. Coba ambil dari Reply/Quoted dulu (paling akurat)
            if (contextInfo && contextInfo.quotedMessage) {
                targetMsg = {
                    key: {
                        remoteJid: jid,
                        fromMe: (contextInfo.participant && sock.user?.id) ? jidNormalizedUser(contextInfo.participant) === jidNormalizedUser(sock.user.id) : false,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    },
                    message: contextInfo.quotedMessage
                };
                source = "Reply (Balasan)";
            } 
            // 2. Kalau gak ada reply, ambil dari pesan terakhir di PC
            else if (lastNonCommandMessage) {
                targetMsg = JSON.parse(JSON.stringify(lastNonCommandMessage));
                source = "Pesan Terakhir di Chat Pribadi";
            }

            if (targetMsg) {
                if (command === '.setpesan') {
                    savedMessage = targetMsg;
                    savedMessages = [targetMsg];
                    saveConfig();
                    await sock.sendMessage(jid, { text: `✅ *BERHASIL DISIMPAN (UTAMA)*\n\nSumber: ${source}\nTipe: ${getContentType(targetMsg.message)}\n\n_Semua pesan lama dihapus._` });
                } else {
                    savedMessages.push(targetMsg);
                    if (!savedMessage) savedMessage = targetMsg;
                    saveConfig();
                    await sock.sendMessage(jid, { text: `✅ *BERHASIL DITAMBAHKAN*\n\nSumber: ${source}\nTipe: ${getContentType(targetMsg.message)}\nTotal: ${savedMessages.length} pesan dalam rotasi.` });
                }
            } else {
                await sock.sendMessage(jid, { text: `❌ *GAGAL*\n\nKirim/forward pesan dulu atau Reply pesannya dengan ${command}` });
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
            const fullText = text.substring(10).toLowerCase();
            if (!fullText) {
                return await sock.sendMessage(jid, { text: `*CARA SET WAKTU SIKLUS:*\n\nContoh:\n• .setwaktu 30 menit\n• .setwaktu 1 jam\n• .setwaktu 1 jam 30 menit\n• .setwaktu 45 detik\n\n*Atau gunakan Cron:* .setwaktu */15 * * * *` });
            }

            let cronStr = '';
            
            // Cek jika input adalah Cron manual
            if (cron.validate(fullText) && fullText.split(' ').length >= 5) {
                cronStr = fullText;
            } else {
                // Parsing format "X jam Y menit Z detik"
                let totalSeconds = 0;
                const hours = fullText.match(/(\d+)\s*jam/);
                const minutes = fullText.match(/(\d+)\s*menit/);
                const seconds = fullText.match(/(\d+)\s*detik/);

                if (hours) totalSeconds += parseInt(hours[1]) * 3600;
                if (minutes) totalSeconds += parseInt(minutes[1]) * 60;
                if (seconds) totalSeconds += parseInt(seconds[1]);

                if (totalSeconds > 0) {
                    if (totalSeconds < 60) {
                        cronStr = `*/${totalSeconds} * * * * *`;
                    } else {
                        const totalMinutes = Math.floor(totalSeconds / 60);
                        cronStr = `*/${totalMinutes} * * * *`;
                    }
                }
            }

            if (cronStr && cron.validate(cronStr)) {
                cronExpression = cronStr;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ *Jadwal Siklus Diperbarui!*\n\nBot akan mengirim promosi setiap: *${fullText}*\n(Sistem Cron: ${cronStr})` });
                if (isSpamming) {
                    await sock.sendMessage(jid, { text: `🔄 Memulai ulang jadwal otomatis...` });
                    stopSpamJob();
                    startSpamJob();
                }
            } else {
                await sock.sendMessage(jid, { text: `❌ Format waktu tidak valid!\n\nContoh benar:\n*.setwaktu 1 jam 30 menit*` });
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
            const jedaInput = args[1];

            if (jedaInput === undefined) {
                const helpText = `🚀 *MODE SPAM INSTAN (SEKARANG)*\n\n` +
                    `Gunakan perintah ini dengan memasukkan angka jeda per grup.\n\n` +
                    `*Cara Pakai:*\n` +
                    `• \`.spamsekarang 10\` (Jeda 10 detik per grup)\n` +
                    `• \`.spamsekarang 30\` (Jeda 30 detik per grup)\n` +
                    `• \`.spamsekarang 0\` (Tanpa jeda - *Beresiko Banned!*)\n\n` +
                    `_Pilih jeda yang aman ya kak!_`;
                await sock.sendMessage(jid, { text: helpText });
                return;
            }

            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi! Reply pesan dengan .setpesan atau .addpesan' });
                return;
            }

            const jedaAngka = parseInt(jedaInput);
            const customDelay = !isNaN(jedaAngka) ? jedaAngka * 1000 : 0;

            await sock.sendMessage(jid, { text: `🚀 *Mulai Spam Sekarang!*\n\nMemindai grup... Jeda per grup: ${jedaAngka === 0 ? 'Tanpa Jeda' : jedaAngka + ' detik'}.\nBot akan berjalan di background.` });

            // Run in background
            (async () => {
                const groups = (await getGroups()).slice().reverse();
                
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
                    
                    let messagesToSend = [];
                    if (doubleMessageMode && savedMessage && savedMessages.length > 0) {
                        messagesToSend.push(savedMessage);
                        messagesToSend.push(getNextMessageToUse());
                    } else {
                        messagesToSend.push(getNextMessageToUse());
                    }

                    let isAnySuccess = false;
                    for (let j = 0; j < messagesToSend.length; j++) {
                        const msgObj = messagesToSend[j];
                        if (j > 0) await new Promise(r => setTimeout(r, doubleMessageDelay));

                        sentMsgId = await sendWithRetry(group.id, msgObj.message, group.participants);

                        if (sentMsgId) {
                            isAnySuccess = true;
                            if (autoDeleteMs > 0) {
                                const targetGroupId = group.id;
                                const messageId = sentMsgId;
                                setTimeout(async () => {
                                    try {
                                        intentionalDeletions.set(messageId, Date.now());
                                        await activeSock.sendMessage(targetGroupId, { delete: { remoteJid: targetGroupId, fromMe: true, id: messageId } });
                                    } catch(e) {}
                                }, autoDeleteMs);
                            }
                            if (autoClearChat) {
                                try {
                                    const ts = Math.floor(Date.now() / 1000);
                                    await activeSock.chatModify({ delete: true, lastMessages: [{ key: { remoteJid: group.id, id: sentMsgId, fromMe: true }, messageTimestamp: ts }] }, group.id);
                                } catch(e) {}
                            }
                        }
                    }

                    if (isAnySuccess) {
                        successCount++;
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
            let statusText = `📊 *KONFIGURASI SPAM BOT MANGSEB*\n\n`;
            statusText += `Status Spam: ${isSpamming ? '🟢 BERJALAN' : '🔴 BERHENTI'}\n`;
            statusText += `Jadwal (Cron): ${cronExpression}\n`;
            statusText += `Jeda Antar Grup: ${sendDelayMs / 1000} detik\n`;
            statusText += `Hidetag (Mention): ${useHidetag ? '✅ ON' : '❌ OFF'}\n`;
            statusText += `Jam Tidur (Sleep): ${sleepTimeStart !== -1 ? `${sleepTimeStart}:00 - ${sleepTimeEnd}:00` : '❌ OFF (24 Jam)'}\n`;
            statusText += `Auto-Tarik Pesan: ${autoDeleteMs > 0 ? `${autoDeleteMs / 1000} detik` : '❌ OFF'}\n`;
            statusText += `Auto-Clear Chat: ${autoClearChat ? '✅ ON' : '❌ OFF'}\n`;
            statusText += `Grup Blacklist: ${blacklistedGroups.length} grup\n`;
            statusText += `Filter Kata Grup: ${blacklistKeywords.length > 0 ? blacklistKeywords.join(', ') : '❌ OFF'}\n`;
            statusText += `Rotasi Promosi: ${savedMessages.length > 1 ? `✅ Aktif (${savedMessages.length} pesan)` : '❌ OFF'}\n`;
            statusText += `Pesan Utama: ${savedMessage ? '✅ Ada' : '❌ Belum di-set'}\n\n`;
            
            statusText += `*SWGC (STORY):*\n`;
            statusText += `Auto SWGC: ${isAutoSwgc ? '🟢 ON' : '🔴 OFF'}\n`;
            statusText += `Jadwal SWGC: ${autoSwgcCronExpression}\n`;
            statusText += `Mode Pesan Story: ${useDedicatedSwgcMessage ? '✅ KHUSUS (Dedicated)' : '❌ BIASA (Ikut Utama)'}\n`;
            statusText += `Pesan Story: ${savedSwgcMessage ? '✅ Ada' : '❌ Belum di-set'}\n\n`;

            statusText += `*INTERAKTIF & BYPASS:*\n`;
            statusText += `Kotak Link: ${useInteractiveLink ? '✅ ON' : '❌ OFF'}\n`;
            if (useInteractiveLink) statusText += `Link Box: ${interactiveLink}\n`;
            statusText += `Edit Mode: ${editMode === 'auto' ? '🤖 AUTO' : (editMode === 'on' ? '✅ SELALU' : '❌ OFF')}\n`;
            statusText += `Anti-Link ZWS: ${useZws ? '✅ AKTIF' : '❌ OFF'}\n`;
            statusText += `Grup Ber-Bot: ${guardedGroups.length} grup\n`;
            statusText += `Link Scraper: ${linkScraper ? '✅ ON' : '❌ OFF'}\n\n`;
            
            statusText += `Ketik .menu untuk melihat daftar perintah.`;
            await sock.sendMessage(jid, { text: statusText });
        }

        if (command === '.interaktif') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                useInteractiveLink = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Kotak Link Interaktif diaktifkan!*\nSemua pesan spam akan ditempeli kotak klik di bagian atas.' });
            } else if (opt === 'off') {
                useInteractiveLink = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Kotak Link Interaktif dimatikan.*' });
            } else {
                await sock.sendMessage(jid, { text: `Status Kotak Interaktif: ${useInteractiveLink ? 'ON' : 'OFF'}\nGunakan: .interaktif on/off` });
            }
        }

        if (command === '.setlinkgc') {
            const link = args[1];
            if (!link || !link.includes('http')) return await sock.sendMessage(jid, { text: '❌ Masukkan link yang valid!\nContoh: .setlinkgc https://chat.whatsapp.com/xxx' });
            interactiveLink = link;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ *Link Interaktif diatur ke:*\n${link}` });
        }

        if (command === '.setjudullink') {
            const txt = args.slice(1).join(' ');
            if (!txt) return await sock.sendMessage(jid, { text: '❌ Masukkan judul!' });
            interactiveTitle = txt;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ *Judul Kotak Interaktif diatur ke:*\n${txt}` });
        }

        if (command === '.setisilink') {
            const txt = args.slice(1).join(' ');
            if (!txt) return await sock.sendMessage(jid, { text: '❌ Masukkan deskripsi!' });
            interactiveBody = txt;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ *Deskripsi Kotak Interaktif diatur ke:*\n${txt}` });
        }

        if (command === '.setgambarlink') {
            // Cara paling aman mengambil contextInfo dari berbagai tipe pesan
            const msgContent = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message?.viewOnceMessageV2?.message || m.message;
            const msgType = msgContent ? getContentType(msgContent) : null;
            const contextInfo = (msgType && msgContent[msgType]) ? msgContent[msgType].contextInfo : null;
                               
            const quotedMsg = contextInfo?.quotedMessage;
            if (!quotedMsg) return await sock.sendMessage(jid, { text: '❌ Balas (Reply) sebuah *GAMBAR* dengan perintah .setgambarlink' });

            // Cari imageMessage di dalam quotedMsg (bisa di root atau di dalam viewOnce)
            let imageMessage = quotedMsg.imageMessage;
            if (!imageMessage && quotedMsg.viewOnceMessage?.message?.imageMessage) imageMessage = quotedMsg.viewOnceMessage.message.imageMessage;
            if (!imageMessage && quotedMsg.viewOnceMessageV2?.message?.imageMessage) imageMessage = quotedMsg.viewOnceMessageV2.message.imageMessage;

            if (!imageMessage) {
                return await sock.sendMessage(jid, { text: '❌ Pesan yang Anda balas bukan sebuah *GAMBAR*!' });
            }

            try {
                const stream = await downloadContentFromMessage(imageMessage, 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                }
                
                interactiveThumbnail = buffer;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Gambar Kotak Klik Berhasil Diatur!*\nGambar ini akan muncul di setiap kotak promosi Anda.' });
            } catch (e) {
                console.error('[THUMBNAIL] Gagal set gambar:', e.message);
                await sock.sendMessage(jid, { text: '❌ Gagal mengunduh gambar. Silakan coba kirim ulang gambarnya.' });
            }
        }

        if (command === '.delgambarlink') {
            interactiveThumbnail = null;
            saveConfig();
            await sock.sendMessage(jid, { text: '🗑️ *Gambar Kotak Klik dihapus.* Kembali ke tampilan standar.' });
        }

        if (command === '.linkscraper') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                linkScraper = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Link Scraper diaktifkan!*\nBot akan memantau link Grup di semua chat (Kecuali grup LPM).' });
            } else if (opt === 'off') {
                linkScraper = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Link Scraper dimatikan!*' });
            } else {
                await sock.sendMessage(jid, { text: `Status Link Scraper: ${linkScraper ? 'ON' : 'OFF'}\nGunakan: .linkscraper on/off` });
            }
        }

        if (command === '.prioritymain') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                priorityMainMessage = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Prioritas Pesan Utama diaktifkan!*\nBot akan lebih sering mengirim pesan utama (.setpesan) dibanding pesan tambahan.' });
            } else if (opt === 'off') {
                priorityMainMessage = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Prioritas Pesan Utama dimatikan!*' });
            } else {
                await sock.sendMessage(jid, { text: `Status Prioritas: ${priorityMainMessage ? 'ON' : 'OFF'}\nGunakan: .prioritymain on/off` });
            }
        }

        if (command === '.setpriority') {
            const angka = parseInt(args[1]);
            if (!isNaN(angka) && angka >= 0 && angka <= 100) {
                mainMessagePriorityPercent = angka;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ *Persentase Prioritas diatur ke ${angka}%*\nBot akan mengirim pesan utama sebanyak ${angka}% dari total kiriman.` });
            } else {
                await sock.sendMessage(jid, { text: '❌ Masukkan angka 0-100!\nContoh: .setpriority 75' });
            }
        }

        if (command === '.doublemsg') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                doubleMessageMode = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Mode Double Pesan diaktifkan!*\nSetiap grup akan dikirim 2 pesan (1 Pesan Utama + 1 Pesan Rotasi).' });
            } else if (opt === 'off') {
                doubleMessageMode = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Mode Double Pesan dimatikan!*' });
            } else {
                await sock.sendMessage(jid, { text: `Status Double Msg: ${doubleMessageMode ? 'ON' : 'OFF'}\nGunakan: .doublemsg on/off` });
            }
        }

        if (command === '.setdoublejeda') {
            const angka = parseInt(args[1]);
            if (!isNaN(angka) && angka > 0) {
                doubleMessageDelay = angka * 1000;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ *Jeda Double Pesan diatur ke ${angka} detik.*` });
            } else {
                await sock.sendMessage(jid, { text: '❌ Masukkan angka detik!\nContoh: .setdoublejeda 5' });
            }
        }

        if (command === '.editmode') {
            const opt = args[1]?.toLowerCase();
            if (['on', 'off', 'auto'].includes(opt)) {
                editMode = opt;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ *Edit Mode diatur ke: ${opt.toUpperCase()}*\n${opt === 'auto' ? '_Bot akan otomatis pakai teknik Edit di grup yang ada penjaganya._' : ''}` });
            } else {
                await sock.sendMessage(jid, { text: '❌ Gunakan: .editmode on/off/auto' });
            }
        }

        if (command === '.usezws') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                useZws = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Zero Width Space diaktifkan!*\nLink akan disisipkan karakter transparan agar lolos bot antilink.' });
            } else if (opt === 'off') {
                useZws = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Zero Width Space dimatikan!*' });
            } else {
                await sock.sendMessage(jid, { text: '❌ Gunakan: .usezws on/off' });
            }
        }

        if (command === '.clearguarded') {
            guardedGroups = [];
            saveConfig();
            await sock.sendMessage(jid, { text: '✅ *Daftar grup terpantau bot telah direset.*' });
        }

        if (command === '.addguarded') {
            const groupsList = await getGroups();
            let input = args[1];
            let targetGroup = null;

            if (!input) return await sock.sendMessage(jid, { text: '❌ Masukkan nomor urut atau ID grup!\nContoh: .addguarded 1' });

            if (!isNaN(input)) {
                const idx = parseInt(input) - 1;
                if (idx >= 0 && idx < groupsList.length) targetGroup = groupsList[idx];
            } else {
                targetGroup = groupsList.find(g => g.id === input || g.id.includes(input));
            }

            if (targetGroup) {
                if (!guardedGroups.includes(targetGroup.id)) {
                    guardedGroups.push(targetGroup.id);
                    saveConfig();
                    await sock.sendMessage(jid, { text: `✅ Grup *${targetGroup.subject}* berhasil ditandai sebagai berpenjaga bot.` });
                } else {
                    await sock.sendMessage(jid, { text: `⚠️ Grup *${targetGroup.subject}* sudah ada di daftar.` });
                }
            } else {
                await sock.sendMessage(jid, { text: '❌ Grup tidak ditemukan.' });
            }
        }

        if (command === '.delguarded') {
            if (guardedGroups.length === 0) return await sock.sendMessage(jid, { text: '📋 Daftar grup berpenjaga kosong.' });
            
            const allGroups = await getGroups();
            const input = args[1];

            if (!input) {
                // Tampilkan Poll untuk memilih grup yang mau dihapus
                const options = guardedGroups.slice(0, 11).map(id => {
                    const g = allGroups.find(group => group.id === id);
                    return (g ? g.subject : id).substring(0, 50);
                });
                options.push('❌ BATAL');

                await sock.sendMessage(jid, {
                    poll: {
                        name: '🔓 *HAPUS DARI DAFTAR BERPENJAGA*\n(Pilih grup untuk dinormalkan kembali)',
                        values: options,
                        selectableCount: 1
                    }
                });
                return;
            }

            let targetId = input;
            if (!isNaN(input)) {
                const idx = parseInt(input) - 1;
                if (idx >= 0 && idx < guardedGroups.length) {
                    targetId = guardedGroups[idx];
                }
            }

            const index = guardedGroups.indexOf(targetId);
            if (index > -1) {
                guardedGroups.splice(index, 1);
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Berhasil menghapus grup dari daftar berpenjaga.` });
            } else {
                await sock.sendMessage(jid, { text: `⚠️ Grup tidak ditemukan di daftar berpenjaga.` });
            }
        }

        if (command === '.listguarded') {
            if (guardedGroups.length === 0) return await sock.sendMessage(jid, { text: '📋 Daftar grup berpenjaga kosong.' });
            const allGroups = await getGroups();
            
            const page = parseInt(args[1]) || 1;
            const perPage = 30;
            const totalPages = Math.ceil(guardedGroups.length / perPage);
            
            if (page > totalPages) return await sock.sendMessage(jid, { text: `❌ Halaman ${page} tidak tersedia.` });

            const start = (page - 1) * perPage;
            const currentGuarded = guardedGroups.slice(start, start + perPage);

            let txt = `📋 *GRUP BERPENJAGA (Hal ${page}/${totalPages})*\n\n`;
            currentGuarded.forEach((id, i) => {
                const group = allGroups.find(g => g.id === id);
                txt += `${start + i + 1}. ${group ? group.subject : id}\n`;
            });
            
            if (totalPages > 1) txt += `\n💡 Ketik \`.listguarded ${page + 1}\` untuk lanjut.`;
            await sock.sendMessage(jid, { text: txt });
        }

        if (command === '.setscrapertarget') {
            scraperTargetJid = jid;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ *Target Laporan Berhasil Diatur!*\n\nSemua temuan link scraper akan dikirim ke chat ini mulai sekarang.\nJID: ${jid}` });
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

        if (command === '.swgc') {
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                return await sock.sendMessage(jid, { text: '❌ Pesan promosi kosong! Setel dulu dengan .setpesan' });
            }

            await sock.sendMessage(jid, { text: '🚀 Memulai *SWGC (Story WA Group Chat)* ke semua grup...\nBot akan mengirim "Story" ke tiap grup.' });

            (async () => {
                const groups = await getGroups();
                let success = 0;
                let fail = 0;
                let skip = 0;

                // Logika Mode:
                let msgObj = null;
                if (useDedicatedSwgcMessage) {
                    msgObj = savedSwgcMessage;
                    if (!msgObj) {
                        return await sock.sendMessage(jid, { text: '❌ Mode Khusus SWGC AKTIF, tapi Anda belum set pesannya lewat .setpesanswgc' });
                    }
                } else {
                    msgObj = savedMessage;
                }

                if (!msgObj) return await sock.sendMessage(jid, { text: '❌ Tidak ada pesan promosi yang tersedia.' });

                const type = getContentType(msgObj.message);
                let mediaData = null;

                if (type === 'imageMessage' || type === 'videoMessage') {
                    try {
                        const stream = await downloadContentFromMessage(msgObj.message[type], type.replace('Message', ''));
                        let buf = Buffer.alloc(0);
                        for await(const chunk of stream) {
                            buf = Buffer.concat([buf, chunk]);
                        }
                        mediaData = {
                            type: type.replace('Message', ''),
                            text: processSpinText(msgObj.message[type].caption || ''),
                            buffer: buf,
                            mime: msgObj.message[type].mimetype
                        };
                    } catch (e) {
                        console.error('[SWGC] Gagal download media:', e.message);
                    }
                } else {
                    let text = "";
                    if (type === 'conversation') text = msgObj.message.conversation;
                    else if (type === 'extendedTextMessage') text = msgObj.message.extendedTextMessage.text;
                    
                    mediaData = {
                        type: 'text',
                        text: processSpinText(text),
                        buffer: null
                    };
                }

                if (!mediaData) return;

                // ── 1. Kirim ke Status WA Sendiri ──
                try {
                    console.log("[SWGC] Mengirim ke Status@broadcast...");
                    await sendStoryToGroup(sock, "status@broadcast", mediaData);
                } catch (e) {
                    console.error("[SWGC] Gagal kirim ke Status:", e.message);
                }

                // ── 2. Kirim ke Semua Grup ──
                for (const group of groups) {
                    if (blacklistedGroups.includes(group.id)) { skip++; continue; }
                    
                    const ok = await sendStoryToGroup(sock, group.id, mediaData);
                    if (ok) success++; else fail++;
                    
                    await new Promise(r => setTimeout(r, 2000)); // Jeda antar grup
                }

                await sock.sendMessage(jid, { text: `✅ *SWGC SELESAI*\n\n📺 Status WA: Terposting\n👥 Grup Berhasil: ${success}\n❌ Gagal: ${fail}\n⏭️ Dilewati: ${skip}` });
            })();
        }

        if (command === '.autoswgc') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                if (isAutoSwgc) return await sock.sendMessage(jid, { text: '⚠️ Auto SWGC sudah berjalan!' });
                if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                    return await sock.sendMessage(jid, { text: '❌ Setel pesan dulu dengan .setpesan' });
                }
                isAutoSwgc = true;
                saveConfig();
                startAutoSwgcJob();
                await sock.sendMessage(jid, { text: `✅ *Auto SWGC Aktif!*\nBot akan otomatis kirim story ke grup & status setiap: ${autoSwgcCronExpression}` });
            } else if (opt === 'off') {
                isAutoSwgc = false;
                saveConfig();
                stopAutoSwgcJob();
                await sock.sendMessage(jid, { text: '🛑 *Auto SWGC dimatikan.*' });
            } else {
                await sock.sendMessage(jid, { text: `Status Auto SWGC: ${isAutoSwgc ? 'ON' : 'OFF'}\nJadwal: ${autoSwgcCronExpression}\n\nGunakan: .autoswgc on/off` });
            }
        }

        if (command === '.setwaktuswgc') {
            const cronStr = args.slice(1).join(' ');
            if (!cronStr || !cron.validate(cronStr)) {
                return await sock.sendMessage(jid, { text: '❌ Masukkan format Cron yang valid!\nContoh (Tiap 15 menit): *.setwaktuswgc */15 * * * **' });
            }
            autoSwgcCronExpression = cronStr;
            saveConfig();
            await sock.sendMessage(jid, { text: `✅ Jadwal Auto SWGC diperbarui ke: ${cronStr}` });
            if (isAutoSwgc) {
                stopAutoSwgcJob();
                startAutoSwgcJob();
            }
        }

        if (command === '.setpesanswgc') {
            const quotedMsg = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quotedMsg) return await sock.sendMessage(jid, { text: '❌ Balas (Reply) pesan yang ingin dijadikan Story Khusus!' });
            
            savedSwgcMessage = { message: JSON.parse(JSON.stringify(quotedMsg)) };
            saveConfig();
            await sock.sendMessage(jid, { text: '✅ *Pesan Khusus SWGC Berhasil Disimpan!*\nBot akan menggunakan pesan ini untuk fitur Story/SWGC.' });
        }

        if (command === '.cekpesanswgc') {
            if (!savedSwgcMessage) return await sock.sendMessage(jid, { text: '📋 Belum ada pesan khusus SWGC. Bot saat ini menggunakan cadangan dari .setpesan' });
            await sock.sendMessage(jid, { text: '📋 *PESAN KHUSUS SWGC SAAT INI:*' });
            await sock.sendMessage(jid, { ...savedSwgcMessage });
        }

        if (command === '.delpesanswgc') {
            savedSwgcMessage = null;
            saveConfig();
            await sock.sendMessage(jid, { text: '🗑️ *Pesan khusus SWGC dihapus.*\nSekarang fitur SWGC akan kembali menggunakan pesan utama dari .setpesan' });
        }

        if (command === '.modeswgc') {
            const opt = args[1]?.toLowerCase();
            if (opt === 'on') {
                useDedicatedSwgcMessage = true;
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Mode Pesan Khusus SWGC diaktifkan!*\nStory akan menggunakan pesan dari .setpesanswgc' });
            } else if (opt === 'off') {
                useDedicatedSwgcMessage = false;
                saveConfig();
                await sock.sendMessage(jid, { text: '❌ *Mode Pesan Khusus SWGC dimatikan!*\nStory akan menggunakan pesan utama (.setpesan)' });
            } else {
                await sock.sendMessage(jid, { text: `Status Mode SWGC: ${useDedicatedSwgcMessage ? 'KHUSUS (ON)' : 'BIASA (OFF)'}\nGunakan: .modeswgc on/off` });
            }
        }
        
        if (command === '.menu' || command === '.help') {
            const menuText = `┏━━━━『 *MANGSEB BOT* 』━━━━┓
┃
┣━━『 *PENGELOLA PESAN* 』
┃ ⌬ *.setpesan* (Set pesan utama)
┃ ⌬ *.setpesanswgc* (Set pesan khusus story)
┃ ⌬ *.cekpesanswgc* (Lihat pesan story)
┃ ⌬ *.delpesanswgc* (Hapus pesan story)
┃ ⌬ *.modeswgc* <on/off> (Toggle pesan khusus)
┃ ⌬ *.addpesan* (Tambah rotasi pesan)
┃ ⌬ *.cekpesan* (Lihat daftar rotasi)
┃ ⌬ *.delpesan* <nomor/semua>
┃ ⌬ *.addvcard* <Nama|Nomor>
┃ ⌬ *.rotasipesan* <on/off>
┃ ⌬ *.prioritymain* <on/off>
┃ ⌬ *.setpriority* <0-100>
┃
┣━━『 *KONTROL SPAM* 』
┃ ⌬ *.startspam* (Mulai promosi)
┃ ⌬ *.stopspam* (Berhenti promosi)
┃ ⌬ *.spamsekarang* <jeda detik>
┃ ⌬ *.swgc* (Story WA Group Chat)
┃ ⌬ *.autoswgc* <on/off>
┃ ⌬ *.setwaktuswgc* <cron>
┃ ⌬ *.setwaktu* <angka> <jam/menit>
┃ ⌬ *.setjeda* <angka> <detik/menit>
┃ ⌬ *.teskirim* <urut/id_grup>
┃ ⌬ *.cekconfig* (Cek status bot)
┃
┣━━『 *FITUR BYPASS & SAFETY* 』
┃ ⌬ *.editmode* <on/off/auto>
┃ ⌬ *.usezws* <on/off> (Anti-Link)
┃ ⌬ *.sethidetag* <on/off>
┃ ⌬ *.setautodelete* <angka/off>
┃ ⌬ *.setsleep* <jam1> <jam2/off>
┃ ⌬ *.autoclear* <on/off>
┃
┣━━『 *MANAJEMEN GRUP* 』
┃ ⌬ *.listgrup* [halaman]
┃ ⌬ *.cekgrup* <nama>
┃ ⌬ *.blacklist* (Pilih grup via Poll)
┃ ⌬ *.unblacklist* (Hapus blacklist)
┃ ⌬ *.blacklistkata* <kata1, kata2>
┃ ⌬ *.cleangrup* (Keluar grup sampah)
┃ ⌬ *.listguarded* (Grup ber-bot)
┃ ⌬ *.addguarded* / *.delguarded*
┃ ⌬ *.clearguarded* (Reset sensor)
┃
┣━━『 *OWNER & TOOLS* 』
┃ ⌬ *.addowner* / *.delowner*
┃ ⌬ *.listowner* (Daftar pengelola)
┃ ⌬ *.addbotjaseb* <qr/pairing>
┃ ⌬ *.linkscraper* <on/off>
┃ ⌬ *.setscrapertarget*
┃ ⌬ *.pushkontak* (Japri massal)
┃
┗━━━━━━━━━━━━━━━━━━━━━━┛`;

            await sock.sendMessage(jid, { text: menuText });
        }

        if (command === '.teskirim') {
            if ((!savedMessage || !savedMessage.message) && savedMessages.length === 0) {
                return await sock.sendMessage(jid, { text: '❌ Anda belum mengatur pesan promosi! Setel dulu dengan .setpesan' });
            }

            const allGroups = await getGroups();
            
            let input = args[1]; 
            let targetGroup = null;

            if (input) {
                input = input.trim();
                // 1. Cek apakah input adalah nomor urut (angka)
                if (!isNaN(input)) {
                    const idx = parseInt(input) - 1;
                    if (idx >= 0 && idx < allGroups.length) {
                        targetGroup = allGroups[idx];
                    }
                } 
                // 2. Cek apakah input adalah JID langsung
                else {
                    targetGroup = allGroups.find(g => g.id === input || g.id.includes(input));
                }

                if (!targetGroup) {
                    return await sock.sendMessage(jid, { text: `❌ Grup tidak ditemukan.\nPastikan nomor urut atau ID grup benar.\n\n_Tip: Gunakan .listgrup untuk melihat daftar._` });
                }
            } else {
                // 3. Jika tidak ada input, cari grup pertama yang tidak di-blacklist
                targetGroup = allGroups.find(g => !blacklistedGroups.includes(g.id));
                if (!targetGroup) {
                    return await sock.sendMessage(jid, { text: '❌ Tidak ada grup yang tersedia (semua di-blacklist).' });
                }
            }

            const targetJid = targetGroup.id;
            const targetName = targetGroup.subject;

            await sock.sendMessage(jid, { text: `🔄 *UJI COBA PENGIRIMAN*\n\n🎯 *Target:* ${targetName}\n🆔 *ID:* ${targetJid}\n\n_Sedang mengirim pesan..._` });
            
            try {
                const msgObjToUse = getNextMessageToUse();
                // Gunakan sendWithRetry agar sama dengan logika saat spam berjalan
                const sentId = await sendWithRetry(targetJid, msgObjToUse.message, targetGroup.participants);
                
                if (sentId) {
                    await sock.sendMessage(jid, { text: `✅ *BERHASIL!*\nTes kirim ke grup *${targetName}* sukses.\n\n_Catatan: Jika grup ini berpenjaga, bot tadi otomatis menggunakan teknik Bypass (Edit Mode)._` });
                } else {
                    throw new Error("Gagal mendapatkan ID pesan setelah pengiriman.");
                }
            } catch (err) {
                console.error(`[TES] Gagal kirim ke ${targetName}:`, err);
                await sock.sendMessage(jid, { text: `❌ *GAGAL!*\nKesalahan: ${err.message}` });
            }
        }
    } catch (err) {
        console.error('[ERROR] Terjadi kesalahan saat memproses pesan:', err);
    }
});


    // LISTENER SENSOR BOT PENJAGA (Mendengar penghapusan pesan)
    sock.ev.on('messages.delete', async (item) => {
        console.log(`[SENSOR-DEBUG] Event messages.delete diterima. Jumlah kunci: ${item.keys?.length}`);
        if ('all' in item) return;
        for (const key of item.keys) {
            const msgId = key.id;
            const record = sentMessagesRecord.get(msgId);
            
            // Log setiap penghapusan yang mampir ke bot
            console.log(`[SENSOR-DEBUG] KeyID: ${msgId} | fromMe: ${key.fromMe} | Remote: ${key.remoteJid}`);
            
            if (record) {
                const groupId = record.groupId;
                console.log(`[SENSOR-MATCH] Cocok! Pesan kita di grup ${groupId} dihapus.`);
                
                if (!intentionalDeletions.has(msgId)) {
                    if (!guardedGroups.includes(groupId)) {
                        guardedGroups.push(groupId);
                        saveConfig();
                        console.log(`[SENSOR] ⚠️ Bot penjaga terdeteksi di ${groupId}.`);
                        if (spamOwnerJid) {
                            sock.sendMessage(spamOwnerJid, { text: `⚠️ *SENSOR BOT (DELETE)*\n\nBot penjaga terdeteksi di grup:\n*${groupId}*` }).catch(() => {});
                        }
                    }
                } else {
                    console.log(`[SENSOR-SKIP] Penghapusan diabaikan karena dilakukan oleh bot sendiri (Auto-Delete).`);
                }
            }
        }
    });

}

startBot();
