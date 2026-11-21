// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Mailpit search contract of the delivery-status adapter: real fetch and deadlines against a loopback Mailpit stand-in. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAILPIT_CONFIRM_ATTEMPTS,
  MAILPIT_CONFIRM_BUDGET_MS,
  MAILPIT_CONFIRM_INTERVAL_MS,
  MAILPIT_LOOKUP_TIMEOUT_MS,
  createMailpitDeliveryStatus,
} from '../../src/domain/delivery-status.js';
import { fakeSleep } from '../helpers/app.js';

const MESSAGE_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';
const SEARCH_PATH = `/api/v1/search?query=${encodeURIComponent(`message-id:${MESSAGE_ID}@opt2.local`)}`;

describe('createMailpitDeliveryStatus against a stalled Mailpit', () => {
  /** A late hit sends either the whole reply or only its body `lateMs` after the request. */
  type Behaviour = 'no-headers' | 'partial-body' | 'hit' | { lateMs: number; part: 'reply' | 'body' };
  const JSON_TYPE = { 'content-type': 'application/json' };
  const servers: Server[] = [];

  /** Starts a 127.0.0.1 Mailpit stand-in answering request n by `behaviours[n]`, repeating the last. */
  async function startMailpit(...behaviours: Behaviour[]): Promise<{ origin: string; paths: string[] }> {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      const behaviour = behaviours[Math.min(paths.length, behaviours.length) - 1];
      const hit = JSON.stringify({ messages: [{ ID: `MP-${paths.length}` }] });
      if (behaviour === 'no-headers') return;
      if (typeof behaviour === 'object') {
        if (behaviour.part === 'body') res.writeHead(200, JSON_TYPE).write(hit.slice(0, 1));
        setTimeout(() => {
          if (behaviour.part === 'reply') res.writeHead(200, JSON_TYPE).end(hit);
          else res.end(hit.slice(1));
        }, behaviour.lateMs);
        return;
      }
      res.writeHead(200, JSON_TYPE);
      if (behaviour === 'partial-body') res.write('{"messages":[');
      else res.end(hit);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, paths };
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each<Behaviour>(['no-headers', 'partial-body'])('treats a %s stall as a miss and finds the third reply', async (stall) => {
    const { origin, paths } = await startMailpit(stall, stall, 'hit');
    const { sleep, delays: waits } = fakeSleep();

    await expect(createMailpitDeliveryStatus({ baseUrl: origin, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-3');
    expect(paths).toEqual([SEARCH_PATH, SEARCH_PATH, SEARCH_PATH]);
    expect(waits).toEqual([500, 500]);
  });

  it.each<[number, 'reply' | 'body']>([
    [500, 'reply'],
    [1000, 'reply'],
    [1000, 'body'],
  ])('finds a hit whose %i ms late %s arrives within the first lookup', async (lateMs, part) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { origin, paths } = await startMailpit({ lateMs, part });
    const { sleep, delays: waits } = fakeSleep();
    const started = performance.now();

    await expect(createMailpitDeliveryStatus({ baseUrl: origin, sleep }).confirm(MESSAGE_ID)).resolves.toBe('MP-1');
    expect(performance.now() - started).toBeGreaterThanOrEqual(lateMs - 5);
    expect(paths).toEqual([SEARCH_PATH]);
    expect(waits).toEqual([]);
    expect(timeout.mock.calls).toEqual([[MAILPIT_LOOKUP_TIMEOUT_MS]]);
  });

  it('stops stalled lookups once less than a whole second of the budget remains', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const stalls = Array.from({ length: 10 }, (_, i): Behaviour => (i % 2 === 0 ? 'no-headers' : 'partial-body'));
    const { origin, paths } = await startMailpit(...stalls);
    const { sleep, delays: waits } = fakeSleep();
    const started = performance.now();

    await expect(createMailpitDeliveryStatus({ baseUrl: origin, sleep }).confirm(MESSAGE_ID)).resolves.toBeNull();
    const limits = timeout.mock.calls.map(([ms]) => ms);
    expect(performance.now() - started).toBeGreaterThan(MAILPIT_CONFIRM_BUDGET_MS - 1000);
    expect(paths.length).toBeLessThan(MAILPIT_CONFIRM_ATTEMPTS);
    expect(paths).toEqual(limits.map(() => SEARCH_PATH));
    expect(waits).toEqual(limits.map(() => MAILPIT_CONFIRM_INTERVAL_MS));
    expect(limits.every((ms) => ms === 1000 || ms === MAILPIT_LOOKUP_TIMEOUT_MS)).toBe(true);
    expect(limits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(MAILPIT_CONFIRM_BUDGET_MS);
  });
});
