/**
 * QRIS helper.
 *
 * QRIS pakai format EMVCo TLV (Tag-Length-Value).
 *  - Tag 01: Point of Initiation Method  "11" = static, "12" = dynamic
 *  - Tag 54: Transaction Amount (dalam rupiah, boleh desimal)
 *  - Tag 63: CRC16 (CCITT-FALSE, poly 0x1021, init 0xFFFF)
 *
 * Fungsi utama:
 *   - parseQris(str)          : parse jadi array {tag,len,value}
 *   - generateDynamicQris(static, amount) : buat QRIS dinamis dengan nominal
 *   - crc16(str)              : hitung CRC16 CCITT-FALSE (uppercase hex 4 char)
 */

/**
 * Hitung CRC16-CCITT-FALSE.
 * Poly 0x1021, init 0xFFFF, tanpa refleksi input/output, no xor out.
 * Return uppercase hex 4 karakter.
 */
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Parse string QRIS TLV menjadi array token.
 * Setiap token: { tag: "26", len: 37, value: "..." }
 * Tag 63 (CRC) sengaja di-skip supaya bisa kita re-generate.
 */
function parseQris(qris) {
  const tokens = [];
  let i = 0;
  while (i < qris.length) {
    if (i + 4 > qris.length) break;
    const tag = qris.substring(i, i + 2);
    const len = parseInt(qris.substring(i + 2, i + 4), 10);
    if (Number.isNaN(len)) {
      throw new Error(`QRIS parse error: invalid length at pos ${i}`);
    }
    const value = qris.substring(i + 4, i + 4 + len);
    tokens.push({ tag, len, value });
    i += 4 + len;
  }
  return tokens;
}

function buildToken({ tag, value }) {
  const len = value.length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

/**
 * Build QRIS dinamis dari static QRIS string + amount.
 *
 * @param {string} staticQris  Full static QRIS string (termasuk CRC di ujung).
 * @param {number|string} amount Rupiah (integer, tanpa desimal).
 * @returns {string} QRIS dinamis dengan CRC baru.
 */
function generateDynamicQris(staticQris, amount) {
  if (!staticQris || typeof staticQris !== 'string') {
    throw new Error('staticQris kosong / bukan string');
  }
  const amt = String(amount);
  if (!/^\d+$/.test(amt)) {
    throw new Error('amount harus integer positif');
  }

  // Buang CRC tag 63 di akhir (6304XXXX) supaya kita bisa rebuild.
  // Cari terakhir "6304" — CRC selalu 4 char di paling akhir.
  const crcIdx = staticQris.lastIndexOf('6304');
  const body = crcIdx >= 0 ? staticQris.substring(0, crcIdx) : staticQris;

  const tokens = parseQris(body);

  // Ubah tag 01 dari "11" (static) jadi "12" (dynamic).
  const t01 = tokens.find((t) => t.tag === '01');
  if (t01) {
    t01.value = '12';
    t01.len = 2;
  } else {
    tokens.unshift({ tag: '01', len: 2, value: '12' });
  }

  // Set / replace tag 54 = amount.
  const t54Idx = tokens.findIndex((t) => t.tag === '54');
  const t54 = { tag: '54', len: amt.length, value: amt };
  if (t54Idx >= 0) {
    tokens[t54Idx] = t54;
  } else {
    // Convention: tag 54 diletakkan setelah tag 53 (currency) atau sebelum 58 (country).
    const insertAt = tokens.findIndex((t) => parseInt(t.tag, 10) > 54);
    if (insertAt >= 0) tokens.splice(insertAt, 0, t54);
    else tokens.push(t54);
  }

  // Rakit ulang tanpa CRC.
  const rebuilt = tokens.map(buildToken).join('');
  const withCrcHeader = `${rebuilt}6304`;
  const crc = crc16(withCrcHeader);
  return withCrcHeader + crc;
}

/**
 * Generate unique code (1-999) untuk membedakan invoice dengan nominal sama.
 */
function generateUniqueCode() {
  return Math.floor(Math.random() * 999) + 1; // 1..999
}

module.exports = {
  crc16,
  parseQris,
  generateDynamicQris,
  generateUniqueCode,
};
