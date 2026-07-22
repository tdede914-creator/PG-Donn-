# Third-Party License Attribution

## OrderKuota API — MIT License

Node.js adapter `src/providers/orderkuota.js` merupakan **port dari PHP wrapper**:
[tdede914-creator/orderkuota-api](https://github.com/tdede914-creator/orderkuota-api) (fork dari [yuf1dev/orderkuota-api](https://github.com/yuf1dev/orderkuota-api)).

Original license text preserved below.

---

```
MIT License

Copyright (c) 2023 YuF1Dev
Copyright (c) 2026 tdede914-creator (fork with bug fixes and additions)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Ubahan pada port Node.js

Struktur & flow sesuai PHP asli. Endpoint, headers, dan payload format identik
supaya kompatibel dengan OrderKuota API. Perbedaan yang diperkenalkan:

- Ganti `curl` (PHP) → `axios` (Node.js).
- Ganti class-based → module.exports (functional).
- Tambah `testConnection()` untuk feedback UI dashboard.
- Tambah `normalize()` untuk konversi response ke format `{ externalId, amount,
  occurredAt, raw }` yang seragam dengan adapter lain (OkConnect, DANA Bisnis).
- Verbose logging via `console.log` untuk debugging.
- Handle HTTP 469 dengan pesan spesifik.
