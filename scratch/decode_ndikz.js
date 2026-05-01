const fs = require('fs');

async function decodeNdikz() {
    try {
        const content = fs.readFileSync('C:\\Users\\gifra\\.gemini\\antigravity\\brain\\0d175047-b4b0-4df9-814d-ed0452855b30\\.system_generated\\steps\\413\\content.md', 'utf8');
        const match = content.match(/let encoded = "([^"]+)"/);
        if (!match) return;

        let data = match[1];
        let iterations = 0;
        
        while (iterations < 10) {
            try {
                let decoded = Buffer.from(data, 'base64').toString('utf8');
                if (decoded.includes('const ') || decoded.includes('let ') || decoded.includes('require(')) {
                    data = decoded;
                    break;
                }
                data = decoded;
                iterations++;
            } catch (e) {
                break;
            }
        }

        fs.writeFileSync('C:\\Users\\gifra\\OneDrive\\Desktop\\BUAT BOT\\BOT WA SPAM PROMOSI GRUP\\decoded_ndikz.js', data);
        console.log(`Decoded ndikz after ${iterations} iterations`);
    } catch (e) {
        console.error(e);
    }
}

decodeNdikz();
