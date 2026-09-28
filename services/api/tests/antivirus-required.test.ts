// A dedicated file rather than a case inside upload.test.ts: config.ts reads
// CLAMAV_PORT once, at import time, and vitest gives each test file its own
// module registry - so poisoning it here (before anything transitively
// imports config.ts) never disturbs the real clamd calls every other file
// makes.
process.env.CLAMAV_PORT = '1'; // nothing listens here
process.env.CLAMAV_TIMEOUT_MS = '1000';

import { describe, it, expect } from 'vitest';

describe('upload when clamd is unreachable, ANTIVIRUS_REQUIRED=true (default)', () => {
  it('rejects the file as ANTIVIRUS_UNAVAILABLE rather than storing it unscanned', async () => {
    const { buildServer } = await import('../src/server.js');
    const { prisma } = await import('../src/db.js');
    const { ensureBucket } = await import('../src/storage.js');
    const { authHeaders } = await import('./helpers/auth.js');

    await ensureBucket();
    const object = await prisma.constructionObject.create({ data: { name: 'AV unavailable, required' } });

    const app = await buildServer();
    const boundary = '----avrequired';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="doc.pdf"\r\n`
        + 'Content-Type: application/pdf\r\n\r\n',
      ),
      Buffer.from('%PDF-1.7 never scanned'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/documents/upload?object_id=${object.id}`,
      headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().rejected[0]).toMatchObject({
      reason: 'ANTIVIRUS_UNAVAILABLE',
      message: 'Антивирусная проверка недоступна, повторите загрузку позже',
    });

    // Nothing reached storage - the whole point of ANTIVIRUS_REQUIRED=true.
    const stored = await prisma.fileRecord.findFirst({ where: { objectId: object.id } });
    expect(stored).toBeNull();

    await app.close();
  });
});
