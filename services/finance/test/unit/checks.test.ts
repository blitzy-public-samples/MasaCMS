// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Check order of the finance fixture edit through `app.inject`, against legacy-fixtures/cfml api.cfm, lib/auth.cfc, lib/envelope.cfc and modules/finance.cfc. */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { GATE_WAIT_MS } from '@opt2/platform/migration-kit';
import { TENANT_A } from '@opt2/platform/testing';
import { FIXTURE_CHECK_ORDER, type FixtureCheckStep } from '../../src/legacy/checks.js';
import { FIXTURE_ERROR_MAP, type FixtureErrorType } from '../../src/legacy/envelope.js';
import { FIXTURE_PREFIX } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { programBindingRow, recordRow } from '../helpers/records.js';

type Injected = Awaited<ReturnType<TestApp['app']['inject']>>;

const PREPARER = 'finance.preparer';
const APPROVER = 'finance.approver';
const SYSTEM_USER = 'system-user';
const UNKNOWN_SITE = 'unknown-site';
/** A well-formed CF UUID no tenant holds. */
const MISSING_ID = '00000000-0000-0000-0000000000000000';
const RECORD_UNIT = 'finance.record';
const VALID_EDIT = { title: 'Q2 travel, revised', amount: '99.99', period: '2026-06' } as const;

/** What a failure injection changes in one edit; `session` is the caller: a user token, identity's anonymous token, or no token. */
interface Probe {
  action: string;
  /** Path segments after the action; two more leave api.cfm's five-segment grammar. */
  extra: string;
  site: string;
  siteid?: string;
  session: 'user' | 'anonymous' | 'none';
  roles: readonly string[];
  knownRecord: boolean;
  state: string;
  body: Readonly<Record<string, unknown>>;
}

/** A preparer of tenant-a editing an IN-PROGRESS record with valid fields: it passes every check. */
const BASELINE: Readonly<Probe> = Object.freeze({
  action: 'edit',
  extra: '',
  site: TENANT_A.siteId,
  session: 'user',
  roles: [PREPARER],
  knownRecord: true,
  state: 'IN-PROGRESS',
  body: VALID_EDIT,
});

// Each injection changes fields no other one changes, so any two compose by spreading.
const FAILURES: Readonly<Record<FixtureCheckStep, Partial<Probe>>> = Object.freeze({
  path: { extra: '/extra/segment' },
  // The gateway mints the token for the requested site, so the token and siteid name the same unknown site.
  site: { site: UNKNOWN_SITE, siteid: UNKNOWN_SITE },
  login: { session: 'anonymous' },
  role: { roles: [SYSTEM_USER] },
  existence: { knownRecord: false },
  validation: { body: { ...VALID_EDIT, amount: '1e3' } },
  state: { state: 'APPROVED' },
});

/** The error-map row and message the fixture answers a failed step with; a path outside the grammar has no fixture envelope. */
const ANSWERS: Readonly<Record<Exclude<FixtureCheckStep, 'path'>, { type: FixtureErrorType; message?: string }>> = Object.freeze({
  site: { type: 'invalidParameters' },
  login: { type: 'authorization' },
  role: { type: 'forbidden' },
  existence: { type: 'notFound' },
  validation: { type: 'invalidParameters' },
  // usp_finance_transition returns the transition table's error, which finance.cfc raises as the conflict message.
  state: { type: 'conflict', message: 'illegalTransition' },
});

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp({ seed: { program_binding: [programBindingRow(TENANT_A.siteId)] } });
});

afterAll(async () => {
  await t?.app.close();
});

beforeEach(() => {
  t.csrf.answer(true);
});

/** Seeds a record for the probe, sends the baseline edit with `overrides` applied, and returns the response with the writes it committed. */
async function send(overrides: Partial<Probe> = {}): Promise<{ res: Injected; writes: readonly unknown[]; id: string }> {
  const probe: Probe = { ...BASELINE, ...overrides };
  const id = cfUuid();
  t.db.seed('record', [recordRow({ id, state: probe.state })]);
  t.db.clear();
  const headers =
    probe.session === 'anonymous'
      ? await headersFor({ roles: [] }, { site: probe.site, sub: '' })
      : await headersFor({ roles: probe.roles }, { site: probe.site });
  if (probe.session === 'none') delete headers.authorization;
  const query = probe.siteid === undefined ? '' : `?siteid=${probe.siteid}`;
  const res = await t.app.inject({
    method: 'POST',
    url: `${FIXTURE_PREFIX}/records/${probe.knownRecord ? id : MISSING_ID}/${probe.action}${probe.extra}${query}`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: probe.body,
  });
  return { res, writes: t.db.writes(), id };
}

/** The envelope.cfc `fail` body of `type` for `method`; an empty message answers the type's default. */
function failBody(type: FixtureErrorType, method: string, message?: string): Record<string, unknown> {
  const { code, message: fallback } = FIXTURE_ERROR_MAP[type];
  return { apiversion: 'v1', method, error: { code, message: message ?? fallback } };
}

/** Asserts the fixture answered `type` (with `message`, if given) for `method` and committed nothing. */
function expectFailure(sent: { res: Injected; writes: readonly unknown[] }, type: FixtureErrorType, method: string, message?: string): void {
  expect([sent.res.statusCode, sent.res.json()]).toStrictEqual([FIXTURE_ERROR_MAP[type].status, failBody(type, method, message)]);
  expect(sent.writes).toStrictEqual([]);
}

/** Asserts the answer of the earliest failed `step`. */
function expectStepAnswer(step: FixtureCheckStep, sent: { res: Injected; writes: readonly unknown[] }): void {
  if (step === 'path') {
    // No route serves a path outside the grammar, and no cut-over entry sends one to finance, so service-kit's 404 answers it.
    expect(sent.res.statusCode).toBe(404);
    expect(sent.writes).toStrictEqual([]);
    return;
  }
  const { type, message } = ANSWERS[step];
  expectFailure(sent, type, 'finance.records.edit', message);
}

describe('finance fixture check order', () => {
  it('orders the checks as api.cfm path and site, then auth.cfc login and role, then finance.cfc existence, validation and state', () => {
    expect(FIXTURE_CHECK_ORDER).toEqual(['path', 'site', 'login', 'role', 'existence', 'validation', 'state']);
  });

  it('answers the baseline edit 200 with the edited record, so each injection fails one check only', async () => {
    const { res, writes, id } = await send();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      method: 'finance.records.edit',
      data: { record_id: id, title: VALID_EDIT.title, amount: '99.9900', state: 'IN-PROGRESS', version: 2 },
    });
    expect(writes).not.toHaveLength(0);
  });

  it.each(FIXTURE_CHECK_ORDER)('answers a failed %s check alone with its fixture error, writing nothing', async (step) => {
    expectStepAnswer(step, await send(FAILURES[step]));
  });

  const pairs = FIXTURE_CHECK_ORDER.flatMap((earlier, i) => FIXTURE_CHECK_ORDER.slice(i + 1).map((later) => [earlier, later] as const));

  it.each(pairs)('answers the %s failure when the later %s check fails too', async (earlier, later) => {
    expectStepAnswer(earlier, await send({ ...FAILURES[earlier], ...FAILURES[later] }));
  });

  it('answers a caller without a user token 401, as requireLogin answers a session without a login', async () => {
    expectFailure(await send({ session: 'none' }), 'authorization', 'finance.records.edit');
  });

  it('answers 404 for a resource finance.cfc does not dispatch, writing nothing', async () => {
    t.db.clear();
    const headers = await headersFor({ roles: [PREPARER] });
    const res = await t.app.inject({ method: 'POST', url: `${FIXTURE_PREFIX}/nosuchresource`, headers, payload: VALID_EDIT });

    expect(res.statusCode).toBe(404);
    expect(t.db.writes()).toStrictEqual([]);
  });
});

describe('finance.cfc action dispatch, between the site check and the record checks', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType]>([
    ['alone', {}, 'notFound'],
    ['after an unknown site', FAILURES.site, 'invalidParameters'],
    ['before invalid fields', FAILURES.validation, 'notFound'],
    ['before an APPROVED record', FAILURES.state, 'notFound'],
  ])('answers an unknown action %s with the earlier failure', async (_case, overrides, type) => {
    expectFailure(await send({ ...overrides, action: 'archive' }), type, 'finance.records.archive');
  });
});

describe('the lifecycle role check of usp_finance_transition, after the record checks', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType, string?]>([
    ['alone', {}, 'forbidden'],
    ['after a missing record', FAILURES.existence, 'notFound'],
    ['after invalid fields', FAILURES.validation, 'invalidParameters'],
    ['after an illegal state', FAILURES.state, 'conflict', 'illegalTransition'],
  ])('answers an approver editing %s with the earlier failure', async (_case, overrides, type, message) => {
    expectFailure(await send({ ...overrides, roles: [APPROVER] }), type, 'finance.records.edit', message);
  });
});

describe('the requireCsrf check of auth.cfc requireAny, between the role check and the record checks', () => {
  it.each<[string, Partial<Probe>, FixtureErrorType, boolean]>([
    ['alone', {}, 'invalidTokens', true],
    ['after an unknown site', FAILURES.site, 'invalidParameters', false],
    ['after a role-less caller', FAILURES.role, 'forbidden', false],
    ['before a missing record', FAILURES.existence, 'invalidTokens', true],
    ['before invalid fields', FAILURES.validation, 'invalidTokens', true],
  ])('answers a rejected token %s with the earlier failure', async (_case, overrides, type, consulted) => {
    t.csrf.answer(false);
    const before = t.csrf.calls.length;

    expectFailure(await send(overrides), type, 'finance.records.edit');
    expect(t.csrf.calls.length - before).toBe(consulted ? 1 : 0);
  });
});

describe('a closed finance.record gate', () => {
  afterAll(() => {
    t.db.setGate(RECORD_UNIT, 'open');
  });

  it('holds a valid edit for the gate budget, then answers the legacy 503, writing nothing', async () => {
    t.db.setGate(RECORD_UNIT, 'closed');
    // Only Date is faked: the gate polls on real timers, and each step moves its deadline clock on by a second.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const started = Date.now();
      let settled = false;
      const pending = send().finally(() => {
        settled = true;
      });
      while (!settled) {
        await sleep(25);
        vi.setSystemTime(Date.now() + 1_000);
      }
      const { res, writes } = await pending;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ apiversion: 'v1', error: { code: 'server_error', message: 'Unhandled Exception' } });
      expect(Date.now() - started).toBeGreaterThanOrEqual(GATE_WAIT_MS);
      expect(writes).toStrictEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
