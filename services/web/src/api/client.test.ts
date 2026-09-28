import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchNotifications, markAllNotificationsRead, markNotificationRead, parseUploadOutcome, splitComposite,
} from './client';

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

// The response-reading half of uploadPackage/uploadToProcess (Plan: their
// own XMLHttpRequest wiring is not unit-tested here, same precedent
// uploadPackage set before дозагрузка existed - no jsdom/XHR in this
// project's vitest environment).
describe('parseUploadOutcome', () => {
  it('reads a 201 (fresh upload) as success', () => {
    const body = { process_id: 'p-1', accepted: [{ file_id: 'f-1', file_name: 'a.pdf', sha256: 'x' }], rejected: [] };
    const result = parseUploadOutcome(201, JSON.stringify(body), [201]);
    expect(result).toEqual({ ok: true, body });
  });

  it('reads a 202 (дозагрузка accepted) as success', () => {
    const body = { process_id: 'p-1', accepted: [{ file_id: 'f-1', file_name: 'a.pdf', sha256: 'x' }], rejected: [] };
    const result = parseUploadOutcome(202, JSON.stringify(body), [202]);
    expect(result).toEqual({ ok: true, body });
  });

  it('a 201 is not success for a дозагрузка scoped to 202', () => {
    const result = parseUploadOutcome(201, '{}', [202]);
    expect(result.ok).toBe(false);
  });

  it('reads a 422 (every file rejected) as success regardless of which statuses were asked for', () => {
    const body = { accepted: [], rejected: [{ file_name: 'a.txt', reason: 'UNSUPPORTED_FORMAT', message: 'x' }] };
    const result = parseUploadOutcome(422, JSON.stringify(body), [202]);
    expect(result).toEqual({ ok: true, body });
  });

  it('reads a 409 as failure with the server message and code', () => {
    const result = parseUploadOutcome(
      409, JSON.stringify({ error: 'PROCESS_PARSING', message: 'Идёт обработка пакета' }), [202],
    );
    expect(result).toEqual({
      ok: false, status: 409, message: 'Идёт обработка пакета', code: 'PROCESS_PARSING',
    });
  });

  it('falls back to a generic message for a body with no message', () => {
    const result = parseUploadOutcome(500, '', [202]);
    expect(result).toEqual({ ok: false, status: 500, message: 'Ошибка загрузки (500)', code: undefined });
  });

  it('falls back to an empty body on unparseable JSON, still failing cleanly', () => {
    const result = parseUploadOutcome(500, 'not json', [202]);
    expect(result.ok).toBe(false);
  });
});

describe('notifications', () => {
  const originalFetch = globalThis.fetch;
  const originalSessionStorage = globalThis.sessionStorage;

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', fakeStorage());
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.stubGlobal('sessionStorage', originalSessionStorage);
  });

  it('fetchNotifications GETs the list with the unread count', async () => {
    const responseBody = {
      items: [{
        id: 'n-1', kind: 'PROCESS_READY', title: 'Протокол готов к проверке',
        body: 'Готов.', process_id: 'p-1', object_id: 'o-1',
        created_at: '2026-09-28T09:00:00.000Z', read_at: null,
      }],
      unread_count: 1,
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchNotifications();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/v1/notifications');
    expect(init?.method ?? 'GET').toBe('GET');
    expect(result).toEqual(responseBody);
  });

  it('markNotificationRead POSTs to /api/v1/notifications/:id/read', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ id: 'n-1', read_at: '2026-09-28T09:05:00.000Z' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await markNotificationRead('n-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/notifications/n-1/read');
    expect(init.method).toBe('POST');
    expect(result).toEqual({ id: 'n-1', read_at: '2026-09-28T09:05:00.000Z' });
  });

  it('markAllNotificationsRead POSTs to /api/v1/notifications/read-all', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ updated: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await markAllNotificationsRead();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/notifications/read-all');
    expect(init.method).toBe('POST');
    expect(result).toEqual({ updated: 3 });
  });

  it('throws an ApiError when the server rejects a read-all request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(markAllNotificationsRead()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});
