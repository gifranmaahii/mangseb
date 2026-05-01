const fs = require('fs');
const path = require('path');

// I'll read the file content from where I saw it or just use the logic if I had the string.
// Since I can't easily copy 4MB into a prompt, I'll try to read the file if it's in the workspace or download it.
// Wait, I don't have the repo locally. I only viewed it via read_url_content (which view_file used on a cached version?).
// Actually, view_file showed the content of a local path: C:\Users\gifra\.gemini\antigravity\brain\0d175047-b4b0-4df9-814d-ed0452855b30\.system_generated\steps\353\content.md
// That file contains the source of index.js.

async function decode() {
    try {
        const content = fs.readFileSync('C:\\Users\\gifra\\.gemini\\antigravity\\brain\\0d175047-b4b0-4df9-814d-ed0452855b30\\.system_generated\\steps\\353\\content.md', 'utf8');
        const match = content.match(/let encoded = "([^"]+)"/);
        if (!match) {
            console.log("No encoded string found");
            return;
        }
        const encoded = match[1];
        const decoded = Buffer.from(encoded, 'base64').toString('utf8');
        // The script uses eval(decodeURIComponent(escape(atob(encoded))))
        // which is essentially just base64 decoding in many cases, but let's check.
        // Actually, sometimes it's nested.
        fs.writeFileSync('C:\\Users\\gifra\\OneDrive\\Desktop\\BUAT BOT\\BOT WA SPAM PROMOSI GRUP\\decoded_repo.js', decoded);
        console.log("Decoded to decoded_repo.js");
    } catch (e) {
        console.error(e);
    }
}

decode();
