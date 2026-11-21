// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAILPIT_CONFIRM_ATTEMPTS,
  MAILPIT_CONFIRM_BUDGET_MS,
  MAILPIT_CONFIRM_INTERVAL_MS,
  MAILPIT_LOOKUP_TIMEOUT_MS,
  createMailpitDeliveryStatus,
  mailpitSearchUrl,
} from '../../src/domain/delivery-status.js';
import { buildTestApp, fakeMailpitFetch, fakeSleep, headersFor, type TestApp } from '../helpers/app.js';

const timer = vi.hoisted(() => ({ delay: vi.fn<(ms: number) => Promise<void>>(async () => undefined) }));

vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: timer.delay,
}));

const BASE = 'http://127.0.0.1:8025';
const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SEARCH_URL = `${BASE}/api/v1/search?query=${encodeURIComponent(`message-id:${MESSAGE_ID}@opt2.local`)}`;

type Reply = (init?: RequestInit) => Response | Promise<Response>;

/** Stubs global fetch with `replies` in order, repeating the last; returns the requested URLs. */
function scriptFetch(...replies: [...Reply[], Reply]): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      return replies[Math.min(urls.length, replies.length) - 1]!(init);
    }),
  );
  return urls;
}

const found = (id: unknown): Reply => () => Response.json({ messages: [{ ID: id }] });
const empty: Reply = () => Response.json({ messages: [], messages_count: 0 });
/** Never settles until the request's signal aborts, then rejects with its reason. */
const pending: Reply = (init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as DOMException), { once: true });
  });

/** Fakes setTimeout and performance.now, and makes each AbortSignal.timeout signal abort on that clock; returns the spy. */
function controlledClock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return controller.signal;
  });
}

/** Runs `confirm` while the controlled clock fires every timer; resolves to its answer and the clock time it took. */
async function onClock(confirm: () => Promise<string | null>): Promise<{ id: string | null; ms: number }> {
  const started = performance.now();
  const settled = confirm().then((id) => ({ id, ms: performance.now() - started }));
  await vi.runAllTimersAsync();
  return settled;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('constants', () => {
  it('allows 10 lookups 500 ms apart', () => {
    expect(MAILPIT_CONFIRM_ATTEMPTS).toBe(10);
    expect(MAILPIT_CONFIRM_INTERVAL_MS).toBe(500);
  });

  it('bounds each lookup to 2 s within a 10 s budget', () => {
    expect(MAILPIT_LOOKUP_TIMEOUT_MS).toBe(2000);
    expect(MAILPIT_CONFIRM_BUDGET_MS).toBe(10_000);
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
    const mailpit = fakeMailpitFetch({ [MESSAGE_ID]: { foundOnTry: k, mailpitId: `MP-${k}` } }, { baseUrl: BASE });
    vi.stubGlobal('fetch', mailpit.fetch);
    const { sleep, delays } = fakeSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: `${BASE}/`, sleep }).confirm(MESSAGE_ID)).resolves.toBe(`MP-${k}`);
    expect(mailpit.urls).toEqual(Array.from({ length: k }, () => SEARCH_URL));
    expect(delays).toEqual(Array.from({ length: k - 1 }, () => 500));
  });

  it('returns null after 10 misses', async () => {
    const mailpit = fakeMailpitFetch({ [MESSAGE_ID]: 'never' }, { baseUrl: BASE });
    vi.stubGlobal('fetch', mailpit.fetch);
    const { sleep, delays } = fakeSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBeNull();
    expect(mailpit.urls).toEqual(Array.from({ length: MAILPIT_CONFIRM_ATTEMPTS }, () => SEARCH_URL));
    expect(delays).toEqual(Array.from({ length: MAILPIT_CONFIRM_ATTEMPTS - 1 }, () => MAILPIT_CONFIRM_INTERVAL_MS));
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
    const { sleep, delays: waits } = fakeSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-3');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(urls).toHaveLength(3);
    expect(waits).toEqual([500, 500]);
  });

  it('retries after a rejected fetch', async () => {
    const urls = scriptFetch(() => Promise.reject(new TypeError('fetch failed')), found('MP-2'));
    const { sleep, delays: waits } = fakeSleep();

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
    const { sleep, delays: waits } = fakeSleep();

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

  it('gives each lookup its own 2 s deadline signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    scriptFetch(empty, empty, found('MP-3'));
    const { sleep } = fakeSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-3');
    expect(timeout.mock.calls).toEqual([[2000], [2000], [2000]]);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
    calls.forEach(([input, init], i) => {
      expect(input).toBe(SEARCH_URL);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal).toBe(timeout.mock.results[i]!.value);
    });
    expect(new Set(calls.map(([, init]) => init?.signal)).size).toBe(3);
  });

  it('counts a fetch still pending at its deadline as a miss', async () => {
    const timeout = controlledClock();
    const urls = scriptFetch(pending, found('MP-2'));
    const { sleep, delays: waits } = fakeSleep();

    await expect(onClock(() => createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID))).resolves.toEqual({
      id: 'MP-2',
      ms: MAILPIT_LOOKUP_TIMEOUT_MS,
    });
    expect(urls).toEqual([SEARCH_URL, SEARCH_URL]);
    expect(waits).toEqual([500]);
    expect(timeout.mock.calls).toEqual([[MAILPIT_LOOKUP_TIMEOUT_MS], [MAILPIT_LOOKUP_TIMEOUT_MS]]);
  });
});

describe('createMailpitDeliveryStatus budget on a virtual monotonic clock', () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  it.each<[string, number, number, number[], number]>([
    ['stalled lookups and 500 ms pauses', Infinity, 500, [2000, 2000, 2000, 2000], 4],
    ['stalled lookups and instant pauses', Infinity, 0, [2000, 2000, 2000, 2000, 2000], 5],
    ['1200 ms misses and 500 ms pauses', 1200, 500, [2000, 2000, 2000, 2000, 2000, 1000], 6],
    ['instant misses and 500 ms pauses', 0, 500, Array.from({ length: 10 }, () => 2000), 9],
  ])('spends one budget on %s', async (_label, answerMs, pauseMs, limits, pauses) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    // Each lookup advances the clock by its answer time, or by its own limit when the answer comes later.
    const urls = scriptFetch(async () => {
      const limit = timeout.mock.calls.at(-1)![0];
      now += Math.min(answerMs, limit);
      if (answerMs >= limit) throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return Response.json({ messages: [] });
    });
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      now += pauseMs;
    };

    await expect(createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID)).resolves.toBeNull();
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual(limits);
    expect(urls).toHaveLength(limits.length);
    expect(waits).toEqual(Array.from({ length: pauses }, () => MAILPIT_CONFIRM_INTERVAL_MS));
    expect(now).toBeLessThanOrEqual(MAILPIT_CONFIRM_BUDGET_MS);
  });
});

describe('createMailpitDeliveryStatus against a stalled Mailpit on a controlled clock', () => {
  /** A late hit sends either the whole reply or only its body `lateMs` after the request. */
  type Behaviour = 'no-headers' | 'partial-body' | 'hit' | { lateMs: number; part: 'reply' | 'body' };
  const JSON_TYPE = { 'content-type': 'application/json' };
  const utf8 = new TextEncoder();
  let timeout: ReturnType<typeof controlledClock>;

  beforeEach(() => {
    timeout = controlledClock();
  });

  /** A 200 whose body sends `head` now and `tail` with its end `lateMs` later; an abort first errors it with the signal's reason, as undici does. */
  function streamed(signal: AbortSignal, head: string, tail?: { text: string; lateMs: number }): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(utf8.encode(head));
        const timer =
          tail &&
          setTimeout(() => {
            controller.enqueue(utf8.encode(tail.text));
            controller.close();
          }, tail.lateMs);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(body, { status: 200, headers: JSON_TYPE });
  }

  /** Scripts fetch as a Mailpit stand-in answering request n by `behaviours[n]`, repeating the last; returns the requested URLs. */
  function standIn(...behaviours: Behaviour[]): string[] {
    const replies = behaviours.map(
      (behaviour): Reply =>
        (init) => {
          const signal = init!.signal!;
          const hit = JSON.stringify({ messages: [{ ID: `MP-${urls.length}` }] });
          if (behaviour === 'no-headers') return pending(init);
          if (behaviour === 'partial-body') return streamed(signal, '{"messages":[');
          if (behaviour === 'hit') return new Response(hit, { status: 200, headers: JSON_TYPE });
          if (behaviour.part === 'body') return streamed(signal, hit.slice(0, 1), { text: hit.slice(1), lateMs: behaviour.lateMs });
          return new Promise<Response>((resolve, reject) => {
            const timer = setTimeout(() => resolve(new Response(hit, { status: 200, headers: JSON_TYPE })), behaviour.lateMs);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(signal.reason as DOMException);
              },
              { once: true },
            );
          });
        },
    );
    const urls = scriptFetch(...replies.slice(0, -1), replies.at(-1)!);
    return urls;
  }

  it.each<Behaviour>(['no-headers', 'partial-body'])('treats a %s stall as a miss and finds the third reply', async (stall) => {
    const urls = standIn(stall, stall, 'hit');
    const { sleep, delays: waits } = fakeSleep();

    await expect(onClock(() => createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID))).resolves.toEqual({
      id: 'MP-3',
      ms: 2 * MAILPIT_LOOKUP_TIMEOUT_MS,
    });
    expect(urls).toEqual([SEARCH_URL, SEARCH_URL, SEARCH_URL]);
    expect(waits).toEqual([500, 500]);
    expect(timeout.mock.calls).toEqual([[MAILPIT_LOOKUP_TIMEOUT_MS], [MAILPIT_LOOKUP_TIMEOUT_MS], [MAILPIT_LOOKUP_TIMEOUT_MS]]);
  });

  it.each<[number, 'reply' | 'body']>([
    [500, 'reply'],
    [1000, 'reply'],
    [1000, 'body'],
  ])('finds a hit whose %i ms late %s arrives within the first lookup', async (lateMs, part) => {
    const urls = standIn({ lateMs, part });
    const { sleep, delays: waits } = fakeSleep();

    await expect(onClock(() => createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID))).resolves.toEqual({ id: 'MP-1', ms: lateMs });
    expect(urls).toEqual([SEARCH_URL]);
    expect(waits).toEqual([]);
    expect(timeout.mock.calls).toEqual([[MAILPIT_LOOKUP_TIMEOUT_MS]]);
  });

  it('stops stalled lookups once less than a whole second of the budget remains', async () => {
    const urls = standIn(...Array.from({ length: 10 }, (_, i): Behaviour => (i % 2 === 0 ? 'no-headers' : 'partial-body')));
    const { sleep, delays: waits } = fakeSleep();

    await expect(onClock(() => createMailpitDeliveryStatus({ baseUrl: BASE, sleep }).confirm(MESSAGE_ID))).resolves.toEqual({
      id: null,
      ms: MAILPIT_CONFIRM_BUDGET_MS,
    });
    const limits = timeout.mock.calls.map(([ms]) => ms);
    expect(limits).toEqual(Array.from({ length: 5 }, () => MAILPIT_LOOKUP_TIMEOUT_MS));
    expect(urls.length).toBeLessThan(MAILPIT_CONFIRM_ATTEMPTS);
    expect(urls).toEqual(limits.map(() => SEARCH_URL));
    expect(waits).toEqual(limits.map(() => MAILPIT_CONFIRM_INTERVAL_MS));
    expect(limits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAILPIT_CONFIRM_BUDGET_MS);
  });
});

describe('fixture send confirmed through the Mailpit adapter', () => {
  const MESSAGES = '/legacy-fixtures/cfml/api.cfm/communications/messages?siteid=tenant-a';
  const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630120000000' };
  const SENDER_ID = '11111111-2222-3333-4444555566667777';
  const RECIPIENT = 'member1@tenant-a.example';

  interface SendBody {
    method: string;
    data: { message_id: string; state: string; history: { status: string; detail: string; mailpit_id: string }[] };
  }

  let built: Pick<TestApp, 'app'> | undefined;

  afterEach(async () => {
    await built?.app.close();
    built = undefined;
  });

  // A message Mailpit never shows is recorded failed (mailpit-not-found), as communications.cfc sendMessage records it.
  it('records failed mailpit-not-found after 10 empty searches', async () => {
    const urls = scriptFetch(empty);
    const { sleep, delays } = fakeSleep();
    const ctx = await buildTestApp({ deliveryStatus: createMailpitDeliveryStatus({ baseUrl: BASE, sleep }) });
    built = ctx;

    const res = await ctx.app.inject({
      method: 'POST',
      url: MESSAGES,
      headers: { ...(await headersFor('communications.sender', { sub: SENDER_ID })), ...CSRF_HEADERS },
      payload: { to: RECIPIENT, subject: 'Hello', bodyText: 'Hi' },
    });

    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<SendBody>();
    expect(body).not.toHaveProperty('error');
    expect(body).toMatchObject({ method: 'communications.messages', data: { to_address: RECIPIENT, state: 'failed' } });
    const messageId = body.data.message_id;
    expect(body.data.history.map(({ status, detail, mailpit_id }) => [status, detail, mailpit_id])).toEqual([
      ['queued', '', ''],
      ['sent', '', ''],
      ['failed', 'mailpit-not-found', ''],
    ]);

    expect(ctx.db.rows('message')).toMatchObject([{ message_id: messageId, state: 'failed' }]);
    expect(ctx.db.rows('delivery_status').map(({ status, detail, mailpit_id }) => [status, detail, mailpit_id])).toEqual([
      ['queued', null, null],
      ['sent', null, null],
      ['failed', 'mailpit-not-found', null],
    ]);
    expect(ctx.mail.sent.map((mail) => mail.to)).toEqual([RECIPIENT]);
    expect(urls).toEqual(Array.from({ length: MAILPIT_CONFIRM_ATTEMPTS }, () => mailpitSearchUrl(BASE, messageId)));
    expect(urls[0]).toBe(`${BASE}/api/v1/search?query=message-id%3A${messageId}%40opt2.local`);
    expect(delays).toEqual(Array.from({ length: MAILPIT_CONFIRM_ATTEMPTS - 1 }, () => MAILPIT_CONFIRM_INTERVAL_MS));
  });
});
