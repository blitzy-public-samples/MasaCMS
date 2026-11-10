// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAILPIT_CONFIRM_ATTEMPTS,
  MAILPIT_CONFIRM_INTERVAL_MS,
  createMailpitDeliveryStatus,
  mailpitSearchUrl,
} from '../../src/domain/delivery-status.js';

const timer = vi.hoisted(() => ({ delay: vi.fn(async (_ms: number) => undefined) }));

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: timer.delay,
}));

const BASE = 'http://127.0.0.1:8025';
const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SEARCH_URL = `${BASE}/api/v1/search?query=${encodeURIComponent(`message-id:${MESSAGE_ID}@opt2.local`)}`;

type Reply = () => Response | Promise<Response>;

/** Stubs global fetch with `replies` in order, repeating the last; returns the requested URLs. */
function scriptFetch(...replies: [...Reply[], Reply]): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      urls.push(String(input));
      return replies[Math.min(urls.length, replies.length) - 1]!();
    }),
  );
  return urls;
}

/** Sleep that resolves at once and records each requested wait. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
}

const found = (id: unknown): Reply => () => Response.json({ messages: [{ ID: id }] });
const empty: Reply = () => Response.json({ messages: [], messages_count: 0 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('constants', () => {
  it('allows 10 lookups 500 ms apart', () => {
    expect(MAILPIT_CONFIRM_ATTEMPTS).toBe(10);
    expect(MAILPIT_CONFIRM_INTERVAL_MS).toBe(500);
  });
});

describe('mailpitSearchUrl', () => {
  it('builds the fixture search query', () => {
    expect(mailpitSearchUrl(BASE, MESSAGE_ID)).toBe(SEARCH_URL);
    expect(mailpitSearchUrl(BASE, MESSAGE_ID)).toBe(`${BASE}/api/v1/search?query=message-id%3A${MESSAGE_ID}%40opt2.local`);
  });

  it.each(['/', '///'])('strips a trailing %j', (suffix) => {
    expect(mailpitSearchUrl(`${BASE}${suffix}`, MESSAGE_ID)).toBe(SEARCH_URL);
  });
});

describe('createMailpitDeliveryStatus', () => {
  it.each([1, 5, 10])('finds the message on lookup %i', async (k) => {
    const urls = scriptFetch(...Array.from({ length: k - 1 }, () => empty), found(`MP-${k}`));
    const { sleep, waits } = recordingSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: `${BASE}/`, sleep }).confirm(MESSAGE_ID)).resolves.toBe(`MP-${k}`);
    expect(urls).toEqual(Array.from({ length: k }, () => SEARCH_URL));
    expect(waits).toEqual(Array.from({ length: k - 1 }, () => 500));
  });

  it('returns null after 10 misses', async () => {
    const urls = scriptFetch(empty);
    const { sleep, waits } = recordingSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBeNull();
    expect(urls).toEqual(Array.from({ length: 10 }, () => SEARCH_URL));
    expect(waits).toEqual(Array.from({ length: 9 }, () => 500));
    expect(timer.delay).not.toHaveBeenCalled();
  });

  it('cancels a non-2xx body and retries', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const urls = scriptFetch(
      () => new Response(body, { status: 503 }),
      () => new Response(null, { status: 404 }),
      found('MP-3'),
    );
    const { sleep, waits } = recordingSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-3');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(3);
    expect(waits).toEqual([500, 500]);
  });

  it('retries after a rejected fetch', async () => {
    const urls = scriptFetch(() => Promise.reject(new TypeError('fetch failed')), found('MP-2'));
    const { sleep, waits } = recordingSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-2');
    expect(urls).toEqual([SEARCH_URL, SEARCH_URL]);
    expect(waits).toEqual([500]);
  });

  it.each<[string, Reply]>([
    ['no messages key', () => Response.json({})],
    ['an empty list', empty],
    ['a null body', () => Response.json(null)],
    ['a message without ID', () => Response.json({ messages: [{}] })],
    ['an empty-string ID', found('')],
    ['a non-string ID', found(42)],
    ['a non-JSON body', () => new Response('not json', { status: 200 })],
  ])('treats %s as a miss', async (_label, miss) => {
    const urls = scriptFetch(miss, found('MP-2'));
    const { sleep, waits } = recordingSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-2');
    expect(urls).toHaveLength(2);
    expect(waits).toEqual([500]);
  });

  it('waits 500 ms on the default timer', async () => {
    const urls = scriptFetch(empty, found('MP-2'));

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE }).confirm(MESSAGE_ID)).resolves.toBe('MP-2');
    expect(urls).toHaveLength(2);
    expect(timer.delay).toHaveBeenCalledTimes(1);
    expect(timer.delay).toHaveBeenCalledWith(500);
  });
});
