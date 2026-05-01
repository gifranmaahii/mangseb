const fs = require('fs');

async function multiDecode() {
    try {
        const content = fs.readFileSync('C:\\Users\\gifra\\.gemini\\antigravity\\brain\\0d175047-b4b0-4df9-814d-ed0452855b30\\.system_generated\\steps\\353\\content.md', 'utf8');
        const match = content.match(/let encoded = "([^"]+)"/);
        if (!match) return;

        let data = match[1];
        let iterations = 0;
        
        while (iterations < 10) {
            try {
                // Try Base64 decode
                let decoded = Buffer.from(data, 'base64').toString('utf8');
                
                // If it looks like base64 still, continue. 
                // If it contains JS keywords, stop.
                if (decoded.includes('const ') || decoded.includes('let ') || decoded.includes('require(') || decoded.includes('function')) {
                    data = decoded;
                    break;
                }
                
                // Check if it's the specific format used in the eval
                // eval(decodeURIComponent(escape(atob(encoded))))
                // which is basically atob(data) then some string conversion
                
                data = decoded;
                iterations++;
            } catch (e) {
                break;
            }
        }

        fs.writeFileSync('C:\\Users\\gifra\\OneDrive\\Desktop\\BUAT BOT\\BOT WA SPAM PROMOSI GRUP\\decoded_final.js', data);
        console.log(`Decoded after ${iterations} iterations`);
    } catch (e) {
        console.error(e);
    }
}

multiDecode();
