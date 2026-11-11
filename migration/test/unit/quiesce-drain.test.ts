// Unit tests for the drain barrier, using an in-memory owners client, service client, unit catalog and stepping clock.
import { setTimeout as delay } from 'node:timers/promises';

import type { InboxCounts, PositionResponse } from '@opt2/platform/migration-kit';
import type { Clock, ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { QUEUE_CONTROL_PREFIX, outboxSweepQueue } from '@opt2/platform/tasks';
import { businessClock } from '@opt2/platform/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { UnknownUnitError } from '../../src/owners/index.js';
import type { DataOwner, OwnersClient, UnitCatalog } from '../../src/owners/index.js';
import {
  DEFAULT_DRAIN_POLL_MS,
  DrainTimeoutError,
  awaitDrained,
  isDrained,
  ownerDrainCounts,
} from '../../src/quiesce/drain.js';
import type { AwaitDrainedOptions, DrainContext, DrainResult, DrainRole, OwnerDrainCounts } from '../../src/quiesce/drain.js';

vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(() => Promise.resolve()) };
});

const CONFIG = loadConfig();
const TENANT_A = '0b0c4f7e-3f7a-4c1e-9a55-1d2b3c4d5e6f';
const TENANT_B = '1c1d5a8f-4a8b-4d2f-8b66-2e3c4d5e6f70';
const EVENT_A = 'a0000000-0000-4000-8000-00000000000a';
const EVENT_B = 'b0000000-0000-4000-8000-00000000000b';
const EVENT_C = 'c0000000-0000-4000-8000-00000000000c';
const UNIT_OWNERS: Record<string, DataOwner> = {
  'people.person': 'people',
  'timesheets.day': 'timesheets',
  'timesheets.week': 'timesheets',
};

/** Position call the owners fake received. */
interface PositionCall {
  owner: DataOwner;
  eventIds: readonly string[] | undefined;
}

const outbox = (unpublished: number, held = 0): NonNullable<PositionResponse['outbox']> => ({ tenants: [], unpublished, held });
const inbox = (receipts?: Record<string, string[]>): InboxCounts => ({
  total: 3,
  bySubscription: { 'timesheets.people.person.archived.v1': 3 },
  ...(receipts === undefined ? {} : { receipts }),
});
const answer = (owner: string, parts: Partial<Pick<PositionResponse, 'outbox' | 'inbox'>> = {}): PositionResponse => ({
  owner,
  position: '4242',
  outbox: null,
  inbox: null,
  ...parts,
});
const counts = (owner: string, unpublished = 0, held = 0, pendingReceipts = 0): OwnerDrainCounts => ({
  owner,
  unpublished,
  held,
  pendingReceipts,
});
const ensureRequest = (service: string): ServiceRequest => ({
  service,
  method: 'POST',
  path: `${QUEUE_CONTROL_PREFIX}/${outboxSweepQueue(service)}/ensure`,
  json: {},
  userToken: null,
});

/** Clock that stands still at noon of the business date until `advance` moves it. */
function steppingClock(start = businessClock().now().getTime()): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

/** Owners client answering `position` from each owner's queue, repeating its last answer; reading another member fails the test. */
function fakeOwners(answers: Partial<Record<DataOwner, (PositionResponse | Error)[]>>): { owners: OwnersClient; calls: PositionCall[] } {
  const calls: PositionCall[] = [];
  const position = (owner: DataOwner, eventIds?: readonly string[]): Promise<PositionResponse> => {
    calls.push({ owner, eventIds });
    const queue = answers[owner] ?? [];
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) return Promise.reject(new Error(`no position answer for ${owner}`));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  const owners = new Proxy({} as OwnersClient, {
    get(_target, member) {
      if (member !== 'position') throw new Error(`owners.${String(member)} was read`);
      return position;
    },
  });
  return { owners, calls };
}

/** Service client answering every request with `status` and recording it. */
function fakeClient(status = 200): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      return Promise.resolve({ status, headers: {}, body: undefined } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return { client, calls };
}

// The drain reads only ownerOf, so reading any other member fails the test.
const CATALOG = new Proxy({} as UnitCatalog, {
  get(_target, member) {
    if (member !== 'ownerOf') throw new Error(`catalog.${String(member)} was read`);
    return (unitId: string): DataOwner => {
      const owner = UNIT_OWNERS[unitId];
      if (owner === undefined) throw new UnknownUnitError(unitId);
      return owner;
    };
  },
});

/** Drain context with the real config and the unit-map catalog; client and clock default to a 200 client and a stepping clock. */
function context(owners: OwnersClient, client: ServiceClient = fakeClient().client, clock: Clock = steppingClock()): DrainContext {
  return { config: CONFIG, clock, catalog: CATALOG, owners, client };
}

afterEach(() => {
  vi.mocked(delay).mockClear();
});

describe('ownerDrainCounts', () => {
  it.each([
    ['zero everywhere for an owner without outbox or inbox', answer('reporting'), counts('reporting')],
    ['the outbox unpublished and held rows', answer('people', { outbox: outbox(3, 2) }), counts('people', 3, 2)],
    ['no pending receipt for an inbox answer without receipts', answer('timesheets', { inbox: inbox() }), counts('timesheets')],
    ['no pending receipt for empty receipts', answer('timesheets', { inbox: inbox({}) }), counts('timesheets')],
    [
      'each asked event id mapped to no tenant as one pending receipt',
      answer('timesheets', { outbox: outbox(0, 1), inbox: inbox({ [EVENT_A]: [], [EVENT_B]: [TENANT_A, TENANT_B], [EVENT_C]: [] }) }),
      counts('timesheets', 0, 1, 2),
    ],
  ])('counts %s', (_label, position, expected) => {
    expect(ownerDrainCounts(expected.owner, position)).toStrictEqual(expected);
  });

  it('names the owner it was asked for, not the one the answer carries', () => {
    expect(ownerDrainCounts('people', answer('identity')).owner).toBe('people');
  });
});

describe('isDrained', () => {
  const PRODUCER: DrainRole = { producer: true, consumer: false };
  const CONSUMER: DrainRole = { producer: false, consumer: true };
  const BOTH: DrainRole = { producer: true, consumer: true };
  const NEITHER: DrainRole = { producer: false, consumer: false };

  it.each([
    [true, 'a producer', counts('people', 0, 0, 5), PRODUCER],
    [false, 'a producer', counts('people', 1), PRODUCER],
    [false, 'a producer', counts('people', 0, 1), PRODUCER],
    [true, 'a consumer', counts('people', 4, 2, 0), CONSUMER],
    [false, 'a consumer', counts('people', 0, 0, 1), CONSUMER],
    [true, 'a producer and consumer', counts('people'), BOTH],
    [false, 'a producer and consumer', counts('people', 0, 0, 1), BOTH],
    [false, 'a producer and consumer', counts('people', 1), BOTH],
    [false, 'a producer and consumer', counts('people', 0, 1), BOTH],
    [true, 'neither role', counts('people', 1, 1, 1), NEITHER],
  ])('returns %s for %s with counts %j', (expected, _label, drainCounts, role) => {
    expect(isDrained(drainCounts, role)).toBe(expected);
  });
});

describe('awaitDrained', () => {
  it('polls every configured data owner as producer and consumer when neither owners nor units are given', async () => {
    const { owners, calls } = fakeOwners(Object.fromEntries(CONFIG.dataOwners.map((owner) => [owner, [answer(owner)]])));
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const result = await awaitDrained(context(owners), { eventIds: [EVENT_A], timeoutMs: 1000, sleep });

    expect(result).toStrictEqual<DrainResult>({ owners: CONFIG.dataOwners.map((owner) => counts(owner)), polls: 1, elapsedMs: 0 });
    expect(calls).toStrictEqual(CONFIG.dataOwners.map((owner) => ({ owner, eventIds: [EVENT_A] })));
    expect(sleep).not.toHaveBeenCalled();
  });

  it('passes eventIds only to consumers and polls each owner once per round, producers first, then consumers in unit order', async () => {
    const { owners, calls } = fakeOwners({
      identity: [answer('identity')],
      people: [answer('people', { inbox: inbox({ [EVENT_A]: [TENANT_A] }) })],
      timesheets: [answer('timesheets', { inbox: inbox({ [EVENT_A]: [TENANT_A] }) })],
    });
    const options: AwaitDrainedOptions = {
      owners: ['identity', 'people'],
      consumersWriting: ['timesheets.day', 'people.person', 'timesheets.week'],
      eventIds: [EVENT_A],
      timeoutMs: 1000,
    };

    const result = await awaitDrained(context(owners), options);

    expect(calls).toStrictEqual([
      { owner: 'identity', eventIds: undefined },
      { owner: 'people', eventIds: [EVENT_A] },
      { owner: 'timesheets', eventIds: [EVENT_A] },
    ]);
    expect(result.owners).toStrictEqual([counts('identity'), counts('people'), counts('timesheets')]);
  });

  it('asks consumers for no receipts when eventIds is absent', async () => {
    const { owners, calls } = fakeOwners({ people: [answer('people', { inbox: inbox() })] });

    await awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['people.person'], timeoutMs: 1000 });

    expect(calls).toStrictEqual([{ owner: 'people', eventIds: undefined }]);
  });

  it('polls until every owner is drained, sleeping pollIntervalMs between rounds, and reports the rounds and elapsed time', async () => {
    const clock = steppingClock();
    const { owners, calls } = fakeOwners({
      people: [answer('people', { outbox: outbox(2) }), answer('people', { outbox: outbox(1) }), answer('people', { outbox: outbox(0) })],
      timesheets: [
        answer('timesheets', { inbox: inbox({ [EVENT_A]: [] }) }),
        answer('timesheets', { inbox: inbox({ [EVENT_A]: [TENANT_A] }) }),
      ],
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>((ms) => {
      clock.advance(ms);
      return Promise.resolve();
    });

    const result = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people'],
      consumersWriting: ['timesheets.day'],
      eventIds: [EVENT_A],
      timeoutMs: 10_000,
      pollIntervalMs: 250,
      sleep,
    });

    expect(result).toStrictEqual<DrainResult>({ owners: [counts('people'), counts('timesheets')], polls: 3, elapsedMs: 500 });
    expect(sleep.mock.calls).toStrictEqual([[250], [250]]);
    expect(calls.map((call) => call.owner)).toStrictEqual(['people', 'timesheets', 'people', 'timesheets', 'people', 'timesheets']);
  });

  it('ensures the outbox sweep chain once per drain for each sweep producer with unpublished or held rows', async () => {
    const { client, calls } = fakeClient();
    const { owners } = fakeOwners({
      identity: [answer('identity', { outbox: outbox(1) }), answer('identity', { outbox: outbox(0) })],
      people: [answer('people', { outbox: outbox(0, 2) }), answer('people', { outbox: outbox(0) })],
      'programs-sites': [answer('programs-sites', { outbox: outbox(0) })],
      finance: [answer('finance', { outbox: outbox(3) }), answer('finance', { outbox: outbox(0) })],
      timesheets: [answer('timesheets', { outbox: outbox(5), inbox: inbox({ [EVENT_A]: [TENANT_A] }) })],
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    const result = await awaitDrained(context(owners, client), {
      owners: ['identity', 'people', 'programs-sites', 'finance'],
      consumersWriting: ['timesheets.day'],
      eventIds: [EVENT_A],
      timeoutMs: 1000,
      sleep,
    });

    expect(calls).toStrictEqual([ensureRequest('identity'), ensureRequest('people')]);
    expect(result.polls).toBe(2);
    expect(result.owners).toContainEqual(counts('timesheets', 5));
  });

  it('propagates a failed sweep ensure before sleeping or polling again', async () => {
    const { client, calls } = fakeClient(503);
    const { owners, calls: positions } = fakeOwners({ people: [answer('people', { outbox: outbox(1) })] });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(awaitDrained(context(owners, client), { owners: ['people'], timeoutMs: 1000, sleep })).rejects.toThrow(
      'Queue control ensure of people-outbox-sweep on people answered HTTP 503',
    );
    expect(calls).toStrictEqual([ensureRequest('people')]);
    expect(positions).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('propagates an owner position failure at once', async () => {
    const failure = new Error('people answered HTTP 503');
    const { owners } = fakeOwners({ identity: [answer('identity')], people: [failure] });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(awaitDrained(context(owners), { owners: ['identity', 'people'], timeoutMs: 1000, sleep })).rejects.toBe(failure);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects with UnknownUnitError for an unknown consumer unit before polling any owner', async () => {
    const { owners, calls } = fakeOwners({ people: [answer('people')] });

    await expect(
      awaitDrained(context(owners), { owners: ['people'], consumersWriting: ['people.nothing'], timeoutMs: 1000 }),
    ).rejects.toThrow(UnknownUnitError);
    expect(calls).toStrictEqual([]);
  });

  it('throws DrainTimeoutError naming each undrained owner with the counts of its roles once timeoutMs has passed', async () => {
    const clock = steppingClock();
    const { owners, calls } = fakeOwners({
      people: [answer('people', { outbox: outbox(2, 1), inbox: inbox({ [EVENT_A]: [], [EVENT_B]: [TENANT_A] }) })],
      identity: [answer('identity', { outbox: outbox(1) })],
      communications: [answer('communications', { outbox: outbox(0) })],
      timesheets: [answer('timesheets', { outbox: outbox(4), inbox: inbox({ [EVENT_A]: [TENANT_B], [EVENT_B]: [] }) })],
    });
    const sleep = vi.fn<(ms: number) => Promise<void>>((ms) => {
      clock.advance(ms);
      return Promise.resolve();
    });

    const failure = await awaitDrained(context(owners, fakeClient().client, clock), {
      owners: ['people', 'identity', 'communications'],
      consumersWriting: ['people.person', 'timesheets.day'],
      eventIds: [EVENT_A, EVENT_B],
      timeoutMs: 1000,
      pollIntervalMs: 400,
      sleep,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DrainTimeoutError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      name: 'DrainTimeoutError',
      message:
        'drain timed out after 1000 ms: people(unpublished=2, held=1, pendingReceipts=1), identity(unpublished=1, held=0), ' +
        'timesheets(pendingReceipts=1)',
      timeoutMs: 1000,
      owners: [counts('people', 2, 1, 1), counts('identity', 1), counts('timesheets', 4, 0, 1)],
    });
    expect(sleep.mock.calls).toStrictEqual([[400], [400], [400]]);
    expect(calls).toHaveLength(4 * 4);
  });

  it('throws DrainTimeoutError after the first round without sleeping when timeoutMs is zero', async () => {
    const { owners, calls } = fakeOwners({ finance: [answer('finance', { outbox: outbox(1) })] });
    const sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());

    await expect(awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 0, sleep })).rejects.toThrow(
      new DrainTimeoutError(0, [{ counts: counts('finance', 1), role: { producer: true, consumer: true } }]),
    );
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('sleeps DEFAULT_DRAIN_POLL_MS (1000 ms) on node timers when neither pollIntervalMs nor sleep is given', async () => {
    const { owners } = fakeOwners({ finance: [answer('finance', { outbox: outbox(1) }), answer('finance', { outbox: outbox(0) })] });

    const result = await awaitDrained(context(owners), { owners: ['finance'], timeoutMs: 60_000 });

    expect(DEFAULT_DRAIN_POLL_MS).toBe(1000);
    expect(delay).toHaveBeenCalledExactlyOnceWith(DEFAULT_DRAIN_POLL_MS);
    expect(result.polls).toBe(2);
  });
});
