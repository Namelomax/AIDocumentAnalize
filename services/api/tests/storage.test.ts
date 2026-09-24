import { describe, it, expect, beforeAll } from 'vitest';
import { sha256, storageKeyFor, ensureBucket, putObject, getObject } from '../src/storage.js';

describe('storage', () => {
  beforeAll(async () => { await ensureBucket(); });

  it('computes a lowercase 64-char sha256', () => {
    const hash = sha256(Buffer.from('hello'));
    expect(hash).toHaveLength(64);
    expect(hash).toBe(hash.toLowerCase());
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('shards the storage key by the first four hex characters', () => {
    expect(storageKeyFor('abcdef0123')).toBe('documents/ab/cd/abcdef0123');
  });

  it('round-trips an object through minio', async () => {
    const body = Buffer.from('%PDF-1.7 test');
    const key = storageKeyFor(sha256(body));
    await putObject(key, body, 'application/pdf');
    const back = await getObject(key);
    expect(back.equals(body)).toBe(true);
  });
});
