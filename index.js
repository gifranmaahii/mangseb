const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    getContentType, 
    makeCacheableSignalKeyStore, 
    jidDecode, 
    downloadContentFromMessage, 
    generateForwardMessageContent, 
    generateWAMessageFromContent, 
    prepareWAMessageMedia,
    proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const cron = require('node-cron');
const { exec } = require('child_process');

const configFile = process.argv[2] ? `./config_${process.argv[2]}.json` : './config.json';

let savedMessage = null;
let savedSwgcMessage = null; // Pesan khusus untuk SWGC
let useDedicatedSwgcMessage = false; // Toggle pakai pesan khusus SWGC
let savedMessages = []; // Untuk Multi-Pesan (Rotasi)
let spamJob = null;
let cronExpression = '0 * * * *'; // Default setiap jam
let ownerNumbers = ['6283173972057@s.whatsapp.net']; // Nomor owner (dengan @s.whatsapp.net)
let jedaSpam = 5000; // Jeda antar grup (ms)
let blacklistedGroups = []; 
let useHidetag = false;
let autoDeleteTime = null; // off by default
let sleepStart = null; 
let sleepEnd = null;
let autoClearChat = false;
let blacklistKata = []; 
let editMode = 'off'; // on, off, auto
let useZws = false; // Zero Width Space bypass
let linkScraper = false;
let scraperTargetJid = null;
let isAutoSwgc = false;
let autoSwgcCronExpression = '*/30 * * * *'; // Default 30 menit
let autoSwgcJob = null;

let useInteractiveLink = false; // Toggle Kotak Link Interaktif
let interactiveLink = '';
let interactiveTitle = 'GABUNG GRUP BOT';
let interactiveBody = 'Klik di sini untuk bergabung!';

// Cache untuk deteksi bot penjaga
let sentMessagesRecord = new Map(); // ID Pesan -> { groupId, timestamp }
let intentionalDeletions = new Map(); // ID Pesan -> timestamp
let guardedGroups = []; // List JID grup yang terdeteksi ada bot penjaga
let rotationIndex = 0; // Index untuk rotasi pesan
let useRotation = false; // Status rotasi pesan
let priorityOnMain = false; // Jika ON, pesan utama selalu dikirim dulu baru rotasi
let priorityWeight = 100; // Persentase kemungkinan pesan utama muncul (0-100)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function loadConfig() {
    try {
        if (!fs.existsSync(configFile)) return;
        const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
        savedMessage = config.savedMessage || null;
        savedMessages = config.savedMessages || [];
        cronExpression = config.cronExpression || '0 * * * *';
        ownerNumbers = config.ownerNumbers || ['6283173972057@s.whatsapp.net'];
        jedaSpam = config.jedaSpam || 5000;
        blacklistedGroups = config.blacklistedGroups || [];
        useHidetag = config.useHidetag || false;
        autoDeleteTime = config.autoDeleteTime || null;
        sleepStart = config.sleepStart || null;
        sleepEnd = config.sleepEnd || null;
        autoClearChat = config.autoClearChat || false;
        blacklistKata = config.blacklistKata || [];
        editMode = config.editMode || 'off';
        useZws = config.useZws || false;
        linkScraper = config.linkScraper || false;
        scraperTargetJid = config.scraperTargetJid || null;
        useRotation = config.useRotation || false;
        priorityOnMain = config.priorityOnMain || false;
        priorityWeight = config.priorityWeight !== undefined ? config.priorityWeight : 100;
        guardedGroups = config.guardedGroups || [];
        isAutoSwgc = config.isAutoSwgc || false;
        autoSwgcCronExpression = config.autoSwgcCronExpression || '*/30 * * * *';
        savedSwgcMessage = config.savedSwgcMessage || null;
        useDedicatedSwgcMessage = config.useDedicatedSwgcMessage || false;
        
        useInteractiveLink = config.useInteractiveLink || false;
        interactiveLink = config.interactiveLink || '';
        interactiveTitle = config.interactiveTitle || 'GABUNG GRUP BOT';
        interactiveBody = config.interactiveBody || 'Klik di sini untuk bergabung!';
    } catch (e) {
        console.error('Error loading config:', e);
    }
}

function saveConfig() {
    fs.writeFileSync(configFile, JSON.stringify({
        savedMessage,
        savedMessages,
        cronExpression,
        ownerNumbers,
        jedaSpam,
        blacklistedGroups,
        useHidetag,
        autoDeleteTime,
        sleepStart,
        sleepEnd,
        autoClearChat,
        blacklistKata,
        editMode,
        useZws,
        linkScraper,
        scraperTargetJid,
        useRotation,
        priorityOnMain,
        priorityWeight,
        guardedGroups,
        isAutoSwgc,
        autoSwgcCronExpression,
        savedSwgcMessage,
        useDedicatedSwgcMessage,
        useInteractiveLink,
        interactiveLink,
        interactiveTitle,
        interactiveBody
    }, null, 2));
}

loadConfig();

let activeSock = null;

// Fungsi Helper untuk memproses Spin Text {Halo|Hai|Permisi}
function processSpinText(text) {
    if (!text) return text;
    return text.replace(/\{([^{}]+)\}/g, (match, options) => {
        const choices = options.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
    });
}

// Fungsi untuk menentukan pesan mana yang akan dikirim (Utama vs Rotasi)
function getNextMessageToUse() {
    // 1. Jika tidak ada rotasi, gunakan pesan utama
    if (!useRotation || savedMessages.length === 0) {
        return savedMessage;
    }

    // 2. Jika Priority Main aktif, gunakan bobot kemungkinan
    if (priorityOnMain && savedMessage) {
        const roll = Math.floor(Math.random() * 100);
        if (roll < priorityWeight) {
            return savedMessage;
        }
    }

    // 3. Ambil dari rotasi
    const msg = savedMessages[rotationIndex];
    rotationIndex = (rotationIndex + 1) % savedMessages.length;
    return msg;
}

/**
 * Fungsi Pengiriman Pesan dengan Logika Bypass & Interaktif
 */
async function sendWithRetry(jid, message, participants, retries = 0) {
    if (!activeSock) return null;
    const groupId = jid;
    
    try {
        // Cek apakah grup ini berpenjaga
        const isGuarded = guardedGroups.includes(groupId);
        const isNewsletterBypass = (editMode === 'on' || (editMode === 'auto' && isGuarded));
        
        let messageId = activeSock.generateMessageTag();
        let finalMessage = JSON.parse(JSON.stringify(message));

        // INJEKSI KOTAK LINK INTERAKTIF (External Ad Reply)
        if (useInteractiveLink && interactiveLink) {
            const mType = getContentType(finalMessage);
            if (!finalMessage.contextInfo) finalMessage.contextInfo = {};
            
            finalMessage.contextInfo.externalAdReply = {
                title: interactiveTitle,
                body: interactiveBody,
                sourceUrl: interactiveLink,
                mediaType: 1,
                showAdAttribution: true,
                renderLargerThumbnail: true,
                thumbnail: finalMessage.jpegThumbnail || null
            };

            // Untuk media, pastikan contextInfo ada di dalam objek medianya juga
            if (mType !== 'conversation' && mType !== 'extendedTextMessage' && finalMessage[mType]) {
                finalMessage[mType].contextInfo = finalMessage.contextInfo;
            }
        }

        const type = getContentType(finalMessage);
        let sentMsgId = null;

        // --- LOGIKA BYPASS SALURAN (VIEW CHANNEL LOOK) ---
        if (isNewsletterBypass) {
            const newsletterJid = linkScraper ? scraperTargetJid : (ownerNumbers[0] + '@s.whatsapp.net');
            const newsletterName = "Bot Upload Channel/Saluran WA";
            const serverMsgId = 1;

            if (!finalMessage.contextInfo) finalMessage.contextInfo = {};
            finalMessage.contextInfo.forwardingScore = 999;
            finalMessage.contextInfo.isForwarded = true;
            finalMessage.contextInfo.forwardedNewsletterMessageInfo = {
                newsletterJid: newsletterJid,
                serverMessageId: serverMsgId,
                newsletterName: newsletterName
            };

            const sent = await activeSock.sendMessage(jid, finalMessage, { messageId: messageId });
            sentMsgId = sent.key.id;
        } else {
            // Pengiriman Normal (Mungkin dengan Edit Mode jika terdeteksi link)
            const originalContent = finalMessage.conversation || finalMessage[type]?.caption || finalMessage.extendedTextMessage?.text || "";
            const linkRegex = /(https:\/\/chat\.whatsapp\.com\/[^\s\n]+|https:\/\/whatsapp\.com\/channel\/[^\s\n]+)/g;

            if (isGuarded && linkRegex.test(originalContent)) {
                // Gunakan Edit Mode karena ada link di grup berpenjaga
                const safeContent = originalContent.replace(linkRegex, '').trim() || "Promosi Terbaru:";
                let placeholderMsg = JSON.parse(JSON.stringify(finalMessage));
                if (placeholderMsg.conversation) placeholderMsg.conversation = safeContent;
                else if (placeholderMsg[type]?.caption) placeholderMsg[type].caption = safeContent;
                else if (placeholderMsg.extendedTextMessage) placeholderMsg.extendedTextMessage.text = safeContent;

                const firstMsg = await activeSock.sendMessage(jid, placeholderMsg);
                if (firstMsg?.key) {
                    setTimeout(async () => {
                        try {
                            await activeSock.sendMessage(jid, { edit: firstMsg.key, ...finalMessage });
                        } catch (e) {}
                    }, 5000);
                    sentMsgId = firstMsg.key.id;
                }
            } else {
                // Kirim apa adanya
                const sent = await activeSock.sendMessage(jid, finalMessage, { messageId: messageId });
                sentMsgId = sent.key.id;
            }
        }

        if (sentMsgId) {
            sentMessagesRecord.set(sentMsgId, { groupId, timestamp: Date.now() });
        }
        return sentMsgId;

    } catch (err) {
        console.error(`[SEND-ERROR] Gagal kirim ke ${jid}:`, err.message);
        if (retries < 2) {
            await new Promise(r => setTimeout(r, 2000));
            return await sendWithRetry(jid, message, participants, retries + 1);
        }
        return null;
    }
}

/**
 * Fitur SWGC (Story WA Group Chat)
 */
async function sendStoryToGroup(jid, message, participants) {
    if (!activeSock) return;
    try {
        const type = getContentType(message);
        let mediaData = null;
        let mediaType = null;

        if (type === 'imageMessage') {
            mediaData = await downloadContentFromMessage(message.imageMessage, 'image');
            mediaType = 'image';
        } else if (type === 'videoMessage') {
            mediaData = await downloadContentFromMessage(message.videoMessage, 'video');
            mediaType = 'video';
        }

        const BG_COLORS = ['#25D366', '#128C7E', '#075E54', '#34B7F1', '#1DA1F2', '#E1306C', '#833AB4', '#F56040', '#F77737', '#FCAF45', '#FFDC80', '#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF', '#C0C0C0', '#808080', '#800000', '#808000', '#008000', '#800080', '#008080', '#000080'];
        const randomColor = BG_COLORS[Math.floor(Math.random() * BG_COLORS.length)];

        let storyMsg = {};
        if (mediaData) {
            const prepared = await prepareWAMessageMedia({ [mediaType]: mediaData }, { upload: activeSock.waUploadToServer });
            storyMsg = {
                groupStatusMessageV2: {
                    [mediaType + 'Message']: {
                        ...prepared[mediaType + 'Message'],
                        caption: processSpinText(message[type].caption || "")
                    }
                }
            };
        } else {
            const text = message.conversation || message.extendedTextMessage?.text || "";
            storyMsg = {
                groupStatusMessageV2: {
                    textMessage: {
                        text: processSpinText(text),
                        font: Math.floor(Math.random() * 5),
                        backgroundArgb: parseInt(randomColor.replace('#', 'FF'), 16)
                    }
                }
            };
        }

        await activeSock.relayMessage(jid, storyMsg, { participants: { jid: participants } });
    } catch (err) {
        console.error(`[SWGC-ERROR] Gagal ke ${jid}:`, err.message);
    }
}

async function runAutoSwgcCycle() {
    if (!activeSock) return;
    console.log('[AUTO-SWGC] Memulai siklus story otomatis...');
    
    try {
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

        if (!msgObj) return;

        const groups = (await activeSock.groupFetchAllParticipating());
        const jids = Object.keys(groups);

        // 1. Post ke Status Sendiri
        await activeSock.sendMessage('status@broadcast', msgObj.message);
        console.log('[AUTO-SWGC] Berhasil post ke Status Sendiri.');

        // 2. Kirim ke semua Grup
        for (const gid of jids) {
            if (blacklistedGroups.includes(gid)) continue;
            const participants = groups[gid].participants.map(p => p.id);
            await sendStoryToGroup(gid, msgObj.message, participants);
            await new Promise(r => setTimeout(r, 3000));
        }
        console.log('[AUTO-SWGC] Siklus selesai.');
    } catch (err) {
        console.error('[AUTO-SWGC] Error:', err.message);
    }
}

function startAutoSwgcJob() {
    if (autoSwgcJob) autoSwgcJob.stop();
    autoSwgcJob = cron.schedule(autoSwgcCronExpression, runAutoSwgcCycle);
}

function stopAutoSwgcJob() {
    if (autoSwgcJob) autoSwgcJob.stop();
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['MANGSEB', 'Safari', '1.0.0'],
    });

    activeSock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('Koneksi terputus, reconnecting...', shouldReconnect);
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('Bot berhasil terkoneksi!');
            if (isAutoSwgc) startAutoSwgcJob();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.message) return;
            const jid = msg.key.remoteJid;
            const fromMe = msg.key.fromMe;

            // Hanya proses perintah dari owner
            if (!ownerNumbers.includes(jid) && !fromMe) return;

            const content = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            if (!content.startsWith('.')) return;

            const args = content.split(' ');
            const command = args[0].toLowerCase();

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
┃ ⌬ *.interaktif* <on/off> (Kotak Klik)
┃ ⌬ *.setlinkgc* <link>
┃ ⌬ *.setjudullink* / *.setisilink*
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
┃ ⌬ *.setautodelete* <angka/off>
┃ ⌬ *.setsleep* <jam1> <jam2/off>
┃
┣━━『 *MANAJEMEN GRUP* 』
┃ ⌬ *.listgrup* [halaman]
┃ ⌬ *.blacklist* (Pilih via Poll)
┃ ⌬ *.unblacklist* (Hapus blacklist)
┃ ⌬ *.blacklistkata* <kata1, kata2>
┃
┣━━『 *OWNER & TOOLS* 』
┃ ⌬ *.addowner* / *.delowner*
┃ ⌬ *.listowner* (Daftar pengelola)
┃ ⌬ *.addbotjaseb* <qr/pairing>
┃
┗━━━━━━━━━━━━━━━━━━━━━━┛`;
                await sock.sendMessage(jid, { text: menuText });
            }

            if (command === '.setpesan') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) return await sock.sendMessage(jid, { text: '❌ Balas (Reply) pesan yang ingin dijadikan iklan!' });
                savedMessage = { message: JSON.parse(JSON.stringify(quotedMsg)) };
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Pesan Utama Berhasil Disimpan!*' });
            }

            if (command === '.setpesanswgc') {
                const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
                if (!quotedMsg) return await sock.sendMessage(jid, { text: '❌ Balas (Reply) pesan khusus story!' });
                savedSwgcMessage = { message: JSON.parse(JSON.stringify(quotedMsg)) };
                saveConfig();
                await sock.sendMessage(jid, { text: '✅ *Pesan Khusus SWGC Disimpan!*' });
            }

            if (command === '.modeswgc') {
                const opt = args[1]?.toLowerCase();
                if (opt === 'on') { useDedicatedSwgcMessage = true; saveConfig(); await sock.sendMessage(jid, { text: '✅ Mode Khusus SWGC Aktif.' }); }
                else if (opt === 'off') { useDedicatedSwgcMessage = false; saveConfig(); await sock.sendMessage(jid, { text: '❌ Mode Khusus SWGC Mati.' }); }
            }

            if (command === '.interaktif') {
                const opt = args[1]?.toLowerCase();
                if (opt === 'on') { useInteractiveLink = true; saveConfig(); await sock.sendMessage(jid, { text: '✅ Kotak Link Interaktif Aktif.' }); }
                else if (opt === 'off') { useInteractiveLink = false; saveConfig(); await sock.sendMessage(jid, { text: '❌ Kotak Link Interaktif Mati.' }); }
            }

            if (command === '.setlinkgc') {
                const link = args[1];
                if (!link) return await sock.sendMessage(jid, { text: '❌ Sertakan link!' });
                interactiveLink = link;
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Link diatur ke: ${link}` });
            }

            if (command === '.setjudullink') {
                interactiveTitle = args.slice(1).join(' ') || 'GABUNG GRUP BOT';
                saveConfig();
                await sock.sendMessage(jid, { text: `✅ Judul diatur.` });
            }

            if (command === '.startspam') {
                if (spamJob) return await sock.sendMessage(jid, { text: '⚠️ Spam sudah berjalan!' });
                spamJob = cron.schedule(cronExpression, async () => {
                    const groups = await sock.groupFetchAllParticipating();
                    const jids = Object.keys(groups);
                    for (const gid of jids) {
                        if (blacklistedGroups.includes(gid)) continue;
                        const msgObj = getNextMessageToUse();
                        if (msgObj) await sendWithRetry(gid, msgObj.message, groups[gid].participants.map(p => p.id));
                        await new Promise(r => setTimeout(r, jedaSpam));
                    }
                });
                await sock.sendMessage(jid, { text: '🚀 *Spam Promosi Dimulai!*' });
            }

            if (command === '.stopspam') {
                if (spamJob) { spamJob.stop(); spamJob = null; await sock.sendMessage(jid, { text: '🛑 *Spam Berhenti.*' }); }
                else { await sock.sendMessage(jid, { text: '⚠️ Spam memang tidak jalan.' }); }
            }

            if (command === '.swgc') {
                await sock.sendMessage(jid, { text: '🚀 Memulai SWGC...' });
                const groups = await sock.groupFetchAllParticipating();
                const jids = Object.keys(groups);
                const msgObj = useDedicatedSwgcMessage ? (savedSwgcMessage || savedMessage) : savedMessage;
                if (!msgObj) return;

                for (const gid of jids) {
                    if (blacklistedGroups.includes(gid)) continue;
                    await sendStoryToGroup(gid, msgObj.message, groups[gid].participants.map(p => p.id));
                    await new Promise(r => setTimeout(r, 2000));
                }
                await sock.sendMessage(jid, { text: '✅ SWGC Selesai.' });
            }

            if (command === '.autoswgc') {
                const opt = args[1]?.toLowerCase();
                if (opt === 'on') { isAutoSwgc = true; startAutoSwgcJob(); saveConfig(); await sock.sendMessage(jid, { text: '✅ Auto SWGC Aktif.' }); }
                else if (opt === 'off') { isAutoSwgc = false; stopAutoSwgcJob(); saveConfig(); await sock.sendMessage(jid, { text: '❌ Auto SWGC Mati.' }); }
            }

            if (command === '.cekconfig') {
                let statusText = `📊 *STATUS BOT MANGSEB*\n\n`;
                statusText += `Auto Spam: ${spamJob ? '🟢 JALAN' : '🔴 MATI'}\n`;
                statusText += `Jadwal: ${cronExpression}\n`;
                statusText += `Jeda: ${jedaSpam / 1000} detik\n`;
                statusText += `Rotasi Pesan: ${useRotation ? '✅ ON' : '❌ OFF'}\n\n`;
                statusText += `*SWGC (STORY):*\n`;
                statusText += `Auto SWGC: ${isAutoSwgc ? '🟢 ON' : '🔴 OFF'}\n`;
                statusText += `Jadwal SWGC: ${autoSwgcCronExpression}\n\n`;
                statusText += `*KOTAK INTERAKTIF:*\n`;
                statusText += `Status: ${useInteractiveLink ? '✅ ON' : '❌ OFF'}\n`;
                statusText += `Link: ${interactiveLink}\n`;
                await sock.sendMessage(jid, { text: statusText });
            }
            
            if (command === '.teskirim') {
                const groups = await sock.groupFetchAllParticipating();
                const gid = args[1] || Object.keys(groups)[0];
                const msgObj = getNextMessageToUse();
                if (msgObj) {
                    await sock.sendMessage(jid, { text: `🔄 Mencoba kirim ke: ${groups[gid]?.subject || gid}` });
                    const sentId = await sendWithRetry(gid, msgObj.message, groups[gid]?.participants.map(p => p.id));
                    if (sentId) await sock.sendMessage(jid, { text: '✅ Berhasil tes kirim.' });
                    else await sock.sendMessage(jid, { text: '❌ Gagal tes kirim.' });
                }
            }

        } catch (err) {
            console.error('Error in upsert:', err);
        }
    });
}

startBot();
