// Section 9.6: a local stand-in for ИАИС «РиН» on the offline verification
// stand. Plain Node (no dependencies to install/build) so the image stays a
// one-file COPY. Exposes:
//
//   POST /api/v1/inspection/:process_id  - the real target endpoint. Stores
//     the payload to DATA_DIR and logs it, or answers 503 while an admin-set
//     failure budget is still open (see /admin/config below) - this is how
//     the demo shows the api's own retry ladder (RIN_MOCK_FAIL_FIRST /
//     POST /admin/config) without needing a second, flaky real dependency.
//   GET  /admin/received?process_id=...  - every payload stored for that
//     process, newest first - what the e2e script and a human demo both read
//     back to prove the transfer actually arrived.
//   POST /admin/config  - body {"fail_first": N} (re)sets how many of the
//     next inspection calls answer 503, without restarting the container -
//     RIN_MOCK_FAIL_FIRST only sets the value the container boots with.
//   GET  /health  - compose's own healthcheck target.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || '/data';
fs.mkdirSync(DATA_DIR, { recursive: true });

let remainingFailures = Number(process.env.RIN_MOCK_FAIL_FIRST || 0);

function log(fields) {
  process.stdout.write(`${JSON.stringify({
    level: 'INFO', timestamp: new Date().toISOString(), service: 'rin-mock', request_id: null, user_id: null,
    ...fields,
  })}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Content-Length': payload.length });
  res.end(payload);
}

function safeProcessId(raw) {
  // The process id only ever needs to be safe as a filename prefix - it is
  // never parsed back into anything.
  return raw.replace(/[^a-zA-Z0-9-]/g, '_');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  const inspectionMatch = url.pathname.match(/^\/api\/v1\/inspection\/([^/]+)$/);
  if (req.method === 'POST' && inspectionMatch) {
    const processId = inspectionMatch[1];
    const body = await readBody(req);

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      log({ message: 'rin-mock: configured failure', process_id: processId, remaining_failures: remainingFailures });
      return sendJson(res, 503, { error: 'MOCK_FAILURE', remaining_failures: remainingFailures });
    }

    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'INVALID_JSON' });
    }

    const fileName = `${safeProcessId(processId)}-${Date.now()}-${crypto.randomUUID()}.json`;
    fs.writeFileSync(path.join(DATA_DIR, fileName), JSON.stringify(parsed, null, 2));
    log({
      message: 'rin-mock: inspection result received', process_id: processId,
      protocol_id: parsed.protocol_id, findings: Array.isArray(parsed.findings) ? parsed.findings.length : null,
    });
    return sendJson(res, 200, { status: 'RECEIVED', process_id: processId });
  }

  if (req.method === 'GET' && url.pathname === '/admin/received') {
    const processId = url.searchParams.get('process_id');
    const files = fs.readdirSync(DATA_DIR)
      .filter((f) => !processId || f.startsWith(`${safeProcessId(processId)}-`))
      .sort()
      .reverse();
    const items = files.map((f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')));
    return sendJson(res, 200, { items });
  }

  if (req.method === 'POST' && url.pathname === '/admin/config') {
    const body = await readBody(req);
    try {
      const config = JSON.parse(body.toString('utf8') || '{}');
      if (typeof config.fail_first === 'number') remainingFailures = config.fail_first;
    } catch {
      return sendJson(res, 400, { error: 'INVALID_JSON' });
    }
    log({ message: 'rin-mock: admin config applied', remaining_failures: remainingFailures });
    return sendJson(res, 200, { remaining_failures: remainingFailures });
  }

  return sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, () => {
  log({ message: `rin-mock listening on ${PORT}`, remaining_failures: remainingFailures });
});
