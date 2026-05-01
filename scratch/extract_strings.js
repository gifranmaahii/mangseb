const fs = require('fs');

// Mocking NdikzOneHK (LZString)
const NdikzOneHK = (function() {
    var f = String.fromCharCode;
    var keyStr = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
    return {
        decompressFromUTF16: function(compressed) {
            if (compressed == null) return "";
            if (compressed == "") return null;
            return this._decompress(compressed.length, 16384, function(index) {
                return compressed.charCodeAt(index) - 32;
            });
        },
        _decompress: function(length, resetParam, getNextVal) {
            var dictionary = [], next, en = 4, w, bits, resb, maxpower, power, c, data = {val: getNextVal(0), position: resetParam, index: 1};
            for (var i = 0; i < 3; i++) dictionary[i] = i;
            bits = 0; maxpower = Math.pow(2, 2); power = 1;
            while (power != maxpower) {
                resb = data.val & data.position;
                data.position >>= 1;
                if (data.position == 0) {
                    data.position = resetParam;
                    data.val = getNextVal(data.index++);
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
                            data.position = resetParam;
                            data.val = getNextVal(data.index++);
                        }
                        bits |= (resb > 0 ? 1 : 0) * power;
                        power <<= 1;
                    }
                    c = f(bits);
                    break;
                case 1:
                    bits = 0; maxpower = Math.pow(2, 16); power = 1;
                    while (power != maxpower) {
                        resb = data.val & data.position;
                        data.position >>= 1;
                        if (data.position == 0) {
                            data.position = resetParam;
                            data.val = getNextVal(data.index++);
                        }
                        bits |= (resb > 0 ? 1 : 0) * power;
                        power <<= 1;
                    }
                    c = f(bits);
                    break;
                case 2: return "";
            }
            dictionary[3] = c; w = c; var result = [c];
            while (true) {
                if (data.index > length) return "";
                bits = 0; maxpower = Math.pow(2, en); power = 1;
                while (power != maxpower) {
                    resb = data.val & data.position;
                    data.position >>= 1;
                    if (data.position == 0) {
                        data.position = resetParam;
                        data.val = getNextVal(data.index++);
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
                                data.position = resetParam;
                                data.val = getNextVal(data.index++);
                            }
                            bits |= (resb > 0 ? 1 : 0) * power;
                            power <<= 1;
                        }
                        dictionary[next++] = f(bits); c = next - 1; en--;
                        break;
                    case 1:
                        bits = 0; maxpower = Math.pow(2, 16); power = 1;
                        while (power != maxpower) {
                            resb = data.val & data.position;
                            data.position >>= 1;
                            if (data.position == 0) {
                                data.position = resetParam;
                                data.val = getNextVal(data.index++);
                            }
                            bits |= (resb > 0 ? 1 : 0) * power;
                            power <<= 1;
                        }
                        dictionary[next++] = f(bits); c = next - 1; en--;
                        break;
                    case 2: return result.join("");
                }
                if (en == 0) { en = Math.pow(2, en); en = 4; /* simplified for extraction */ }
                // This is a complex logic, but let's try to grab the string from the file
            }
        }
    };
})();

async function extractStrings() {
    const content = fs.readFileSync('C:\\Users\\gifra\\OneDrive\\Desktop\\BUAT BOT\\BOT WA SPAM PROMOSI GRUP\\decoded_ndikz.js', 'utf8');
    // Find the compressed string
    const match = content.match(/NdikzOneMq\[NdikzOnebm\[18\]\]="([^"]+)"/);
    if (!match) {
        console.log("No compressed string found");
        return;
    }
    const compressed = match[1];
    
    // Actually, I can just run the code since it's already in the file.
    // But I'll try to find common patterns.
    
    console.log("Compressed string length:", compressed.length);
}

extractStrings();
