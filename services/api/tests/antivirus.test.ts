import { describe, it, expect } from 'vitest';
import { scanBuffer } from '../src/antivirus.js';

// The EICAR test string (https://www.eicar.org/) - not a real virus, every
// antivirus engine (including ClamAV) is built to flag it on purpose so its
// detection path can be exercised safely.
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');

describe('antivirus.scanBuffer', () => {
  it('flags the EICAR test string as infected, naming its signature', async () => {
    const result = await scanBuffer(EICAR);
    expect(result).toEqual({ outcome: 'infected', signature: 'Eicar-Test-Signature' });
  });

  it('reports an ordinary file as clean', async () => {
    const result = await scanBuffer(Buffer.from('%PDF-1.7 nothing suspicious here\n'));
    expect(result).toEqual({ outcome: 'clean' });
  });
});
