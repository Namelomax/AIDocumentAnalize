import { describe, it, expect } from 'vitest';

// A dedicated file rather than a case inside antivirus.test.ts: vitest gives
// each test file its own module registry, so process.env can be poisoned
// before config.ts (imported transitively by antivirus.ts) ever reads it,
// without disturbing CLAMAV_HOST/PORT for every other file's real clamd
// calls.
describe('antivirus.scanBuffer when clamd is unreachable', () => {
  it('reports outcome "unavailable" rather than throwing or hanging', async () => {
    process.env.CLAMAV_PORT = '1'; // nothing listens here
    process.env.CLAMAV_TIMEOUT_MS = '1000';
    const { scanBuffer } = await import('../src/antivirus.js');

    const result = await scanBuffer(Buffer.from('anything'));

    expect(result.outcome).toBe('unavailable');
    if (result.outcome === 'unavailable') {
      expect(result.error).toBeTruthy();
    }
  });
});
