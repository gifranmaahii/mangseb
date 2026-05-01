const fs = require('fs');

// LZString decompress logic from the decoded file
function decompress(compressed) {
    if (compressed == null) return "";
    if (compressed == "") return null;
    let dictionary = [], next, en = 4, w, bits, resb, maxpower, power, c, 
        data = {val: compressed.charCodeAt(0) - 32, position: 16384, index: 1};
    
    for (let i = 0; i < 3; i++) dictionary[i] = i;
    
    bits = 0; maxpower = Math.pow(2, 2); power = 1;
    while (power != maxpower) {
        resb = data.val & data.position;
        data.position >>= 1;
        if (data.position == 0) {
            data.position = 16384;
            data.val = compressed.charCodeAt(data.index++) - 32;
        }
        bits |= (resb > 0 ? 1 : 0) * power;
        power <<= 1;
    }
    
    switch (next = bits) {
        case 0:
            bits = 0; maxpower = Math.pow(2, 8); power = 1;
            while (power != maxpower) {
                resb = data.val & data.position;
                data.position >>= 1;
                if (data.position == 0) {
                    data.position = 16384;
                    data.val = compressed.charCodeAt(data.index++) - 32;
                }
                bits |= (resb > 0 ? 1 : 0) * power;
                power <<= 1;
            }
            c = String.fromCharCode(bits);
            break;
        case 1:
            bits = 0; maxpower = Math.pow(2, 16); power = 1;
            while (power != maxpower) {
                resb = data.val & data.position;
                data.position >>= 1;
                if (data.position == 0) {
                    data.position = 16384;
                    data.val = compressed.charCodeAt(data.index++) - 32;
                }
                bits |= (resb > 0 ? 1 : 0) * power;
                power <<= 1;
            }
            c = String.fromCharCode(bits);
            break;
        case 2: return "";
    }
    
    dictionary[3] = c;
    w = c;
    let result = [c];
    
    while (true) {
        if (data.index > compressed.length) return "";
        bits = 0; maxpower = Math.pow(2, en); power = 1;
        while (power != maxpower) {
            resb = data.val & data.position;
            data.position >>= 1;
            if (data.position == 0) {
                data.position = 16384;
                data.val = compressed.charCodeAt(data.index++) - 32;
            }
            bits |= (resb > 0 ? 1 : 0) * power;
            power <<= 1;
        }
        
        switch (c = bits) {
            case 0:
                bits = 0; maxpower = Math.pow(2, 8); power = 1;
                while (power != maxpower) {
                    resb = data.val & data.position;
                    data.position >>= 1;
                    if (data.position == 0) {
                        data.position = 16384;
                        data.val = compressed.charCodeAt(data.index++) - 32;
                    }
                    bits |= (resb > 0 ? 1 : 0) * power;
                    power <<= 1;
                }
                dictionary[next++] = String.fromCharCode(bits);
                c = next - 1;
                en--;
                break;
            case 1:
                bits = 0; maxpower = Math.pow(2, 16); power = 1;
                while (power != maxpower) {
                    resb = data.val & data.position;
                    data.position >>= 1;
                    if (data.position == 0) {
                        data.position = 16384;
                        data.val = compressed.charCodeAt(data.index++) - 32;
                    }
                    bits |= (resb > 0 ? 1 : 0) * power;
                    power <<= 1;
                }
                dictionary[next++] = String.fromCharCode(bits);
                c = next - 1;
                en--;
                break;
            case 2: return result.join("");
        }
        
        if (en == 0) {
            en = Math.pow(2, en);
            en = 4;
        }
        
        let entry = "";
        if (dictionary[c]) {
            entry = dictionary[c];
        } else {
            if (c === next) {
                entry = w + w.charAt(0);
            } else {
                return null;
            }
        }
        result.push(entry);
        dictionary[next++] = w + entry.charAt(0);
        en--;
        w = entry;
        
        if (en == 0) {
            en = Math.pow(2, en);
            en = 4;
        }
    }
}

async function run() {
    const content = fs.readFileSync('C:\\Users\\gifra\\OneDrive\\Desktop\\BUAT BOT\\BOT WA SPAM PROMOSI GRUP\\decoded_ndikz.js', 'utf8');
    const match = content.match(/NdikzOneMq\[NdikzOnebm\[18\]\]="([^"]+)"/);
    if (!match) return;
    
    // The decompression in the file is complex. Let's try to find if we can just see the strings.
    // Wait, the strings might be in an array already.
    // In index.js (decoded_final.js), I saw an array _0x1d741d.
    // In ndikz.js, it might be similar.
}
run();
