// See antivirus-required.test.ts for why the env poisoning happens at
// module load, in its own file.
process.env.CLAMAV_PORT = '1'; // nothing listens here
process.env.CLAMAV_TIMEOUT_MS = '1000';
process.env.ANTIVIRUS_REQUIRED = 'false';

import { describe, it, expect } from 'vitest';

describe('upload when clamd is unreachable, ANTIVIRUS_REQUIRED=false', () => {
  it('accepts the file unscanned instead of blocking every upload', async () => {
    const { buildServer } = await import('../src/server.js');
    const { prisma } = await import('../src/db.js');
    const { ensureBucket } = await import('../src/storage.js');
    const { authHeaders } = await import('./helpers/auth.js');

    const { cleanupScenario } = await import('./helpers/cleanup.js');

    await ensureBucket();
    const object = await prisma.constructionObject.create({ data: { name: 'AV unavailable, optional' } });

    try {
      const app = await buildServer();
      const boundary = '----avoptional';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="doc.pdf"\r\n`
          + 'Content-Type: application/pdf\r\n\r\n',
        ),
        Buffer.from('%PDF-1.7 accepted unscanned on purpose'),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/documents/upload?object_id=${object.id}`,
        headers: { ...(await authHeaders()), 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().accepted).toHaveLength(1);

      const stored = await prisma.fileRecord.findFirst({ where: { objectId: object.id } });
      expect(stored).not.toBeNull();

      await app.close();
    } finally {
      await cleanupScenario(object.id);
    }
  });
});
