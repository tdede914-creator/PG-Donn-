/**
 * OkConnect adapter — session cookie scraper.
 *
 * BACKGROUND:
 * - OrderKuota di laptop cuma punya riwayat "Pencairan QRIS" (bukan transaksi
 *   masuk).
 * - Riwayat transaksi masuk QRIS ada di dashboard OkConnect di halaman
 *   /mutasi/index/{page}.
 * - OkConnect tidak lagi provide API key public. Cara terbaik yang tersisa:
 *   pakai session cookie dari browser (login sekali di laptop → grab cookie).
 *
 * Format `credentials` (JSON di kolom Provider.credentials):
 * {
 *   "sessionCookie": "abcdef123456...",       // value cookie `ci_session`
 *   "cookieName":    "ci_session",            // opsional, default ci_session
 *   "mutasiUrl":     "https://okeconnect.com/mutasi/index", // opsional
 *   "maxPages":      1,                       // opsional, 1 = page terbaru saja
 *   "extraCookies":  "cf_clearance=xxx; other=yyy" // opsional, kalau ada cookie tambahan
 * }
 *
 * CARA GRAB COOKIE (dari laptop, sekali saja):
 *   1. Login ke https://okeconnect.com di Chrome laptop
 *   2. Tekan F12 → tab Application → Storage → Cookies → https://okeconnect.com
 *   3. Cari cookie bernama `ci_session` → copy VALUE-nya
 *   4. Kirim value itu ke HP kamu (WhatsApp diri sendiri, dsb)
 *   5. Paste di dashboard PG → Providers → Credentials
 *
 * Cookie ini biasanya awet berhari-hari sampai kamu logout manual.
 */

const axios = require('axios');
const cheerio = require('cheerio');

async function fetchMutations(provider) {
  let creds;
  try {
    creds = JSON.parse(provider.credentials || '{}');
  } catch (e) {
    throw new Error(`Provider ${provider.name}: credentials JSON invalid`);
  }

  const sessionCookie = creds.sessionCookie;
  if (!sessionCookie) {
    throw new Error(
      `Provider ${provider.name}: field "sessionCookie" wajib diisi (value cookie ci_session dari browser).`,
    );
  }
  const cookieName = creds.cookieName || 'ci_session';
  const mutasiUrl = (creds.mutasiUrl || 'https://okeconnect.com/mutasi/index').replace(/\/$/, '');
  const maxPages = Math.max(1, Math.min(5, parseInt(creds.maxPages || 1, 10) || 1));

  let cookieHeader = `${cookieName}=${sessionCookie}`;
  if (creds.extraCookies) cookieHeader += `; ${creds.extraCookies}`;

  const allMutations = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${mutasiUrl}/${page}`;
    let res;
    try {
      res = await axios.get(url, {
        headers: {
          Cookie: cookieHeader,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
        },
        // Ikutin redirect. Kalau session expired biasanya redirect ke /login.
        maxRedirects: 5,
        timeout: 20000,
        validateStatus: (s) => s >= 200 && s < 400,
      });
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status}`
        : err.message;
      throw new Error(`OkConnect fetch gagal (${provider.name}, page ${page}): ${msg}`);
    }

    // Deteksi session expired: kalau HTML final adalah halaman login.
    const finalUrl = res.request?.res?.responseUrl || res.config?.url || '';
    if (/\/login|\/auth/i.test(finalUrl)) {
      throw new Error(
        `OkConnect: session expired atau cookie invalid. Login ulang di laptop lalu grab cookie ci_session yang baru.`,
      );
    }

    const html = String(res.data || '');
    if (/name=["']password["']/i.test(html) && !/mutasi/i.test(html)) {
      throw new Error(
        `OkConnect: response adalah halaman login (cookie invalid/expired). Ambil ulang ci_session dari laptop.`,
      );
    }

    const pageMutations = parseMutasiHtml(html);
    if (pageMutations.length === 0 && page === 1) {
      // Tidak ada baris data → mungkin format berubah, kasih hint.
      // Tapi jangan throw, karena bisa saja user memang belum ada transaksi.
    }
    allMutations.push(...pageMutations);
  }

  return allMutations;
}

/**
 * Parse HTML tabel mutasi OkConnect.
 *
 * Struktur umum tabel OK (best-effort, adaptif):
 *   <table>
 *     <thead>...Tanggal | Keterangan | Kredit | Debit | Saldo | Status...</thead>
 *     <tbody>
 *       <tr><td>2026-07-21 12:34:56</td><td>Transfer QRIS ...</td>
 *           <td>Rp 10.001</td><td>-</td><td>...</td><td>Success</td></tr>
 *     </tbody>
 *   </table>
 *
 * Adapter membaca setiap row, deteksi kolom "kredit" (nominal > 0) berarti
 * transaksi masuk. Nomor referensi diambil dari deskripsi atau kombinasi
 * tanggal+nominal (untuk dedup).
 */
function parseMutasiHtml(html) {
  const $ = cheerio.load(html);
  const rows = [];

  // Cari tabel yang paling mungkin adalah tabel mutasi: yang punya paling banyak <tr>.
  let bestTable = null;
  let bestCount = 0;
  $('table').each((_, tbl) => {
    const count = $(tbl).find('tbody tr').length;
    if (count > bestCount) {
      bestCount = count;
      bestTable = tbl;
    }
  });
  if (!bestTable) return [];

  // Deteksi index kolom dari header (fleksibel).
  const headerCells = $(bestTable).find('thead th, thead td').toArray().map((el) =>
    normalize($(el).text()),
  );
  const findCol = (regexes) =>
    headerCells.findIndex((h) => regexes.some((rx) => rx.test(h)));
  const idxDate = findCol([/tanggal/i, /waktu/i, /date/i, /time/i]);
  const idxDesc = findCol([/keterangan/i, /deskripsi/i, /note/i, /descr/i]);
  const idxKredit = findCol([/kredit|credit|masuk|in/i]);
  const idxDebit = findCol([/debit|keluar|out/i]);
  const idxNominal = findCol([/nominal|amount|jumlah/i]);
  const idxStatus = findCol([/status/i]);
  const idxRef = findCol([/reff|referensi|reference|id|no\.?/i]);

  $(bestTable)
    .find('tbody tr')
    .each((_, tr) => {
      const cells = $(tr)
        .find('td')
        .toArray()
        .map((el) => normalize($(el).text()));
      if (cells.length === 0) return;

      const dateStr = idxDate >= 0 ? cells[idxDate] : cells[0];
      const desc = idxDesc >= 0 ? cells[idxDesc] : cells[1] || '';
      const status = idxStatus >= 0 ? cells[idxStatus] : '';
      const refFromCol = idxRef >= 0 ? cells[idxRef] : '';

      // Deteksi nominal kredit (masuk).
      let amount = 0;
      if (idxKredit >= 0) {
        amount = toInt(cells[idxKredit]);
        // Kalau kredit kosong tapi debit ada, ini transaksi keluar -> skip.
        if (amount === 0 && idxDebit >= 0 && toInt(cells[idxDebit]) > 0) return;
      } else if (idxNominal >= 0) {
        amount = toInt(cells[idxNominal]);
        // Kalau ada indikator jenis di kolom lain, filter yang bukan CR di sini.
      } else {
        // Fallback: cari kolom yang berupa angka > 0 selain saldo.
        for (const c of cells) {
          const n = toInt(c);
          if (n > 0) { amount = n; break; }
        }
      }
      if (amount <= 0) return;

      // Filter status: cuma yang sukses.
      if (status && !/success|sukses|berhasil|ok/i.test(status)) return;

      const occurredAt = parseIndoDate(dateStr);
      const externalId = refFromCol
        || (desc.match(/\b(\d{6,})\b/)?.[1])
        || `${dateStr}|${amount}|${desc}`.slice(0, 120);

      rows.push({
        externalId,
        amount,
        occurredAt,
        raw: { date: dateStr, desc, status, refFromCol, cells },
      });
    });

  return rows;
}

function normalize(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function toInt(s) {
  const digits = String(s || '').replace(/[^0-9]/g, '');
  if (!digits) return 0;
  return parseInt(digits, 10) || 0;
}

/**
 * Parse tanggal Indonesia yang umum di OK: "2026-07-21 12:34:56", "21/07/2026 12:34",
 * "21-07-2026 12:34:56", "21 Jul 2026 12:34", dll. Fallback: new Date().
 */
function parseIndoDate(s) {
  if (!s) return new Date();
  const str = String(s).trim();
  // yyyy-mm-dd hh:mm[:ss]
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(
      Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 7, +m[5], +(m[6] || 0)),
    ); // treat as WIB (UTC+7)
  }
  // dd/mm/yyyy hh:mm[:ss]
  m = str.match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    return new Date(
      Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 7, +m[5], +(m[6] || 0)),
    );
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? new Date() : d;
}

async function testConnection(provider) {
  try {
    const mutations = await fetchMutations(provider);
    const sample = mutations.slice(0, 3).map((m) => ({
      externalId: m.externalId,
      amount: m.amount,
      occurredAt: m.occurredAt,
    }));
    return {
      ok: true,
      message:
        `Berhasil scrape OkConnect. Ditemukan ${mutations.length} transaksi masuk terbaru.` +
        (mutations.length === 0
          ? ' (Belum ada data — coba pastikan akun kamu memang sudah pernah terima QRIS, atau naikkan maxPages.)'
          : ''),
      sample,
    };
  } catch (err) {
    const msg = err.message || String(err);
    let hint = '';
    if (/session expired|cookie invalid|halaman login/i.test(msg)) {
      hint =
        ' — Solusi: login ulang di https://okeconnect.com di laptop → F12 → Application → Cookies → copy value ci_session yang baru.';
    } else if (/JSON invalid/i.test(msg)) {
      hint = ' — Format credentials bukan JSON valid. Klik tombol "Isi template" lalu ganti value cookie-nya.';
    } else if (/ENOTFOUND|ECONNREFUSED|timeout|ETIMEDOUT/i.test(msg)) {
      hint = ' — VPS ga bisa akses okeconnect.com. Cek koneksi internet VPS.';
    } else if (/sessionCookie/i.test(msg)) {
      hint = ' — Isi field "sessionCookie" dengan value cookie ci_session dari browser.';
    }
    return { ok: false, message: msg + hint };
  }
}

module.exports = { fetchMutations, testConnection, parseMutasiHtml };
