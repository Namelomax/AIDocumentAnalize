import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { splitComposite } from './client';

// api()/splitComposite() read the session through sessionStorage
// (Plan 7, Task 4's own token layer) - stubbed here with a plain in-memory
// implementation since this suite runs in vitest's default (non-browser)
// environment, which has no sessionStorage of its own.
function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => store.clear(),
    key: () => null,
    get length() { return store.size; },
  } as Storage;
}

describe('splitComposite', () => {
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = globalThis.sessionStorage;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeStorage());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.stubGlobal('sessionStorage', originalSessionStorage);
  });

  it('POSTs to /api/v1/findings/:id/split and returns the atoms', async () => {
    const responseBody = {
      atoms: [
        { id: 'atom-1', finding_status: 'CANDIDATE' },
        { id: 'atom-2', finding_status: 'CANDIDATE' },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await splitComposite('composite-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/findings/composite-1/split');
    expect(init.method).toBe('POST');
    expect(result).toEqual(responseBody);
  });

  it('throws an ApiError carrying the server message on failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'NOT_A_COMPOSITE', message: 'Не является составным кандидатом' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(splitComposite('atom-1')).rejects.toMatchObject({
      status: 409,
      code: 'NOT_A_COMPOSITE',
      message: 'Не является составным кандидатом',
    });
  });
});
