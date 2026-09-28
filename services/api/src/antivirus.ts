// Customer's ТЗ p.29, "Антивирусная защита: все загружаемые файлы проходят
// антивирусную проверку перед сохранением в хранилище". Talks to clamd's own
// INSTREAM protocol directly over a plain TCP socket - a well-known,
// four-command wire format (RFC-free, documented in clamd's own man page)
// not worth a dependency for: send "zINSTREAM\0", then the file as a series
// of <4-byte big-endian length><chunk> pairs, terminated by a zero-length
// chunk, then read back one line of text.
import { Socket } from 'node:net';
import { config } from './config.js';

export type ScanResult =
  | { outcome: 'clean' }
  | { outcome: 'infected'; signature: string }
  // clamd could not be reached, or answered something this module cannot
  // parse - documents/ingest.ts decides what to do with this from
  // config.antivirus.required, not this module.
  | { outcome: 'unavailable'; error: string };

// clamd's own default StreamMaxLength is 25 MiB, but that limits the file
// clamd will accept, not the chunk size the wire format uses to get there -
// any chunk size works as long as sender and reader agree on the length
// prefix, and this one keeps a single write() call from having to build a
// second copy of a 60 MiB buffer.
const CHUNK_BYTES = 1024 * 1024;

// Every INSTREAM response is one line ending "OK", "<signature> FOUND", or
// "<message> ERROR" (clamd/clamd_othercmds.md), each null-terminated instead
// of newline-terminated the way the rest of the protocol's replies are.
function parseResponse(raw: string): ScanResult {
  const text = raw.replace(/\0/g, '').trim();
  if (text.endsWith('OK')) return { outcome: 'clean' };
  const found = text.match(/^stream:\s*(.+?)\s+FOUND$/);
  if (found) return { outcome: 'infected', signature: found[1] };
  return { outcome: 'unavailable', error: text || 'empty response from clamd' };
}

export async function scanBuffer(body: Buffer): Promise<ScanResult> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    let response = Buffer.alloc(0);

    const finish = (result: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(config.antivirus.timeoutMs);
    socket.on('timeout', () => finish({ outcome: 'unavailable', error: 'clamd request timed out' }));
    // Node's own connect() tries every resolved address (IPv6 first) and
    // wraps every failure into an AggregateError whose own .message is
    // empty - the real reason is one level down, in .errors.
    socket.on('error', (err) => {
      const detail = err instanceof AggregateError
        ? err.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')
        : err.message;
      finish({ outcome: 'unavailable', error: detail || err.message || String(err) });
    });

    socket.connect(config.antivirus.port, config.antivirus.host, () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < body.length; offset += CHUNK_BYTES) {
        const chunk = body.subarray(offset, offset + CHUNK_BYTES);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(chunk.length, 0);
        socket.write(size);
        socket.write(chunk);
      }
      // The zero-length chunk is INSTREAM's own end-of-stream marker, sent
      // even for an empty file so clamd always has something to answer.
      socket.write(Buffer.alloc(4));
    });

    socket.on('data', (chunk) => {
      response = Buffer.concat([response, chunk]);
    });

    socket.on('end', () => finish(parseResponse(response.toString('utf8'))));
  });
}
