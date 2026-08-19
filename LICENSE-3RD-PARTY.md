# Third-Party Attribution

Payment gateway ini menggunakan beberapa kode yang di-port/inspirasi dari
project open source berikut. License MIT preserved.

---

## 1. yuf1dev/orderkuota-api (PHP)

Adapter `src/providers/orderkuota.js` (dan turunannya: `orderkuota_balance.js`)
merupakan port ke Node.js dari:
- Original: https://github.com/yuf1dev/orderkuota-api (Oct 2023 API compliance)
- Fork: https://github.com/tdede914-creator/orderkuota-api (bug fixes + additions)
- License: MIT

Copyright (c) 2023 YuF1Dev  
Copyright (c) 2026 tdede914-creator (fork with fixes)  
Copyright (c) 2026 (this Node.js port)

## 2. WJayadana/jywa-orkut (TypeScript)

Adapter `src/providers/orderkuota_jywa.js` merupakan port dari:
- Original: https://github.com/WJayadana/jywa-orkut
- Fork: https://github.com/tdede914-creator/jywa-orkut
- License: MIT
- Endpoint discovery: `/api/v2/qris/mutasi/{tokenId}` + full payload fields

Copyright (c) WJayadana  
Copyright (c) 2026 tdede914-creator (fork)  
Copyright (c) 2026 (Node.js port with adapter interface)

## 3. Zeppelin OrderKuota

Adapter `src/providers/zeppelin_orderkuota.js` merupakan client untuk service:
- Service: https://zeppelin-api.vercel.app (middleware pihak ketiga)
- Repo client reference: https://github.com/tdede914-creator/zeppelin-orderkuota

Bukan port kode Zeppelin server itu sendiri (yang proprietary). Kita cuma
consume API mereka.

## 4. yono99/dana-api-gateway (JavaScript)

Adapter `src/providers/dana_bisnis.js` (session management + auto-refresh token +
fetch/normalize transaksi) merupakan port ke provider-interface PG-Donn dari:
- Original: https://github.com/yono99/dana-api-gateway
- License: MIT

Catatan: endpoint DANA di adapter ini configurable & perlu diverifikasi
pengguna (bukan API publik resmi DANA). Lihat `DANA-SETUP.md`.

Copyright (c) yono99  
Copyright (c) 2026 (Node.js port dengan adapter interface + configurable endpoint)

---

## MIT License (full text)

```
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
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
```
