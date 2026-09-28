// The outbound half of section 9.6: POST /api/v1/inspection/{process_id} on
// ИАИС «РиН» (or, on the verification stand, deploy/rin-mock). Written
// against Node's own http/https modules rather than a fetch()-based library:
// mTLS (section 12.10 "Подписание запросов к ИАИС «РиН»" via УКЭП client
// certificates) is a plain https.Agent option on this API, and the stand's
// RIN_BASE_URL is plain HTTP by default (offline demo, no certificate chain
// to hand out) - both are one code path here instead of two.
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

export type RinSendResult =
  | { outcome: 'success'; statusCode: number }
  // 5xx, 408, 429 and network/timeout errors - section 9.6's "до 3 повторных
  // попыток" applies.
  | { outcome: 'retryable_failure'; statusCode?: number; error: string }
  // Any other 4xx: the payload itself is what ИАИС «РиН» rejected, and
  // retrying an unchanged payload cannot fix that.
  | { outcome: 'permanent_failure'; statusCode: number; error: string };

let cachedAgent: https.Agent | undefined | null = null;

// Built once and reused: reading the certificate files on every send would
// be needless I/O for a client identity that never changes while the
// process is running. Returns undefined (and caches that) when no
// certificate is configured - the documented demo mode, see config.ts.
function getHttpsAgent(): https.Agent | undefined {
  if (cachedAgent !== null) return cachedAgent ?? undefined;
  if (!config.rin.clientCert || !config.rin.clientKey) {
    cachedAgent = undefined;
    return undefined;
  }
  cachedAgent = new https.Agent({
    cert: readFileSync(config.rin.clientCert),
    key: readFileSync(config.rin.clientKey),
    ca: config.rin.ca ? readFileSync(config.rin.ca) : undefined,
  });
  return cachedAgent;
}

// Exposed for tests only: a client certificate can be added/removed between
// test cases, and the cache above must not carry a stale Agent across them.
export function resetHttpsAgentCache(): void {
  cachedAgent = null;
}

function isRetryableStatus(statusCode: number): boolean {
  return statusCode >= 500 || statusCode === 408 || statusCode === 429;
}

export async function postInspectionResult(processId: string, payload: unknown): Promise<RinSendResult> {
  const url = new URL(`/api/v1/inspection/${processId}`, config.rin.baseUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = Buffer.from(JSON.stringify(payload));

  return new Promise((resolve) => {
    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
        agent: isHttps ? getHttpsAgent() : undefined,
        timeout: config.rin.requestTimeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 200 && statusCode < 300) {
            resolve({ outcome: 'success', statusCode });
          } else if (isRetryableStatus(statusCode)) {
            resolve({ outcome: 'retryable_failure', statusCode, error: `HTTP ${statusCode}` });
          } else {
            resolve({ outcome: 'permanent_failure', statusCode, error: `HTTP ${statusCode}` });
          }
        });
      },
    );
    // A timeout leaves the socket open without ever calling back on its own -
    // it must be destroyed explicitly, which then raises 'error' below.
    req.on('timeout', () => req.destroy(new Error(`timeout after ${config.rin.requestTimeoutMs}ms`)));
    req.on('error', (err) => resolve({ outcome: 'retryable_failure', error: err.message }));
    req.write(body);
    req.end();
  });
}
