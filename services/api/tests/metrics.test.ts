import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server.js';

describe('GET /metrics', () => {
  it('exposes http_request_duration_seconds labelled by route pattern, not the raw URL', async () => {
    const app = await buildServer();

    const checkId = randomUUID();
    // No Authorization header: the auth hook (auth/plugin.ts) rejects this
    // with 401 before the handler ever runs, but the route still matched -
    // onResponse (server.ts) records it regardless of the eventual status.
    await app.inject({ method: 'POST', url: `/api/v1/findings/${checkId}/verdict` });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');

    const body = res.body;
    expect(body).toContain('http_request_duration_seconds');
    // The route pattern, never the uuid that was actually requested - a raw
    // URL per label would make the metric's cardinality unbounded.
    expect(body).toContain('route="/api/v1/findings/:check_id/verdict"');
    expect(body).not.toContain(checkId);

    // Default process metrics (CPU seconds, memory) that HighCpu and the
    // Grafana dashboard both read.
    expect(body).toContain('process_cpu_seconds_total');
    expect(body).toContain('process_resident_memory_bytes');

    await app.close();
  });

  it('is not reachable through the web container - only /api/ is proxied', async () => {
    // services/web/nginx.conf forwards only location /api/ to the api
    // container; /metrics falls through to location / (the SPA's own
    // try_files), so nginx never proxies it anywhere near the api service.
    // This is a static assertion on that config rather than a live curl,
    // since the web container is not part of this test run.
    const nginxConf = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../web/nginx.conf', import.meta.url), 'utf-8'),
    );
    const locationBlocks = nginxConf.match(/location [^{]+\{[^}]*\}/g) ?? [];
    for (const block of locationBlocks) {
      if (block.includes('proxy_pass')) {
        expect(block.startsWith('location /api/')).toBe(true);
      }
    }
  });
});
