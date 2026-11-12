// SYNTHETIC: finance - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Finance fixture checks against legacy-fixtures/cfml api.cfm, lib/auth.cfc resolveSite and programFor, and modules/finance.cfc recordFields. */
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { AuthDenial, type UserClaims } from '@opt2/platform/auth';
import { TenantMismatchError, tenantIdForSite, type MetadataTx, type QueryResult, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { FINANCE_ACTIONS } from '../../src/domain/lifecycle.transitions.js';
import { FixtureApiError } from '../../src/legacy/envelope.js';
import {
  FIXTURE_CHECK_ORDER,
  fixtureDenialOverride,
  requireFinanceAction,
  requireProgram,
  requireRecordInput,
  resolveFixtureSite,
  runFixtureChecks,
  validateRecordInput,
  type RecordField,
} from '../../src/legacy/checks.js';
import type { ProgramBindingRow } from '../../src/repo/tables.js';

const REGISTERED = [TENANT_A.siteId, TENANT_B.siteId, 'default'] as const;
const INVALID_PARAMETERS = { type: 'invalidParameters', message: 'invalidParameters: Invalid parameters' };
const VALID = { title: 'Q2 travel', amount: '1234.5', period: '2026-06' } as const;

/** Rows of a fake pg result. */
function result<R extends Record<string, unknown>>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

/** A registry reader over `sites` answering the two `tenant_registry` lookups of the checks, and the statements it ran. */
function registry(sites: readonly string[] = REGISTERED): { source: MetadataTx; statements: string[] } {
  const statements: string[] = [];
  const answer = (sql: string, value: unknown): QueryResult<Record<string, unknown>> => {
    if (sql.includes('lower(site_id) = lower($1)')) {
      const lower = String(value).toLowerCase();
      return result(sites.filter((site) => site.toLowerCase() === lower).map((site) => ({ tenant_id: tenantIdForSite(site) })));
    }
    if (sql.includes('WHERE tenant_id = $1')) {
      return result(sites.filter((site) => tenantIdForSite(site) === value).map((site) => ({ site_id: site })));
    }
    throw new Error(`unexpected registry statement: ${sql}`);
  };
  const query = (text: string | { text: string }, values: unknown[] = []): Promise<QueryResult<Record<string, unknown>>> => {
    const sql = typeof text === 'string' ? text : text.text;
    statements.push(sql);
    return Promise.resolve().then(() => answer(sql, values[0]));
  };
  const source = { kind: 'metadata', schema: 'finance', query, onCommit: () => undefined } as unknown as MetadataTx;
  return { source, statements };
}

/** Verified claims of a `site` session; the tenant is the site's unless `tid` is given. */
function claims(site: string, tid: string = tenantIdForSite(site === '' ? 'default' : site)): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: '11111111-2222-3333-4444555566667777',
    sid: 'session-1',
    tid,
    site,
    roles: ['finance.preparer'],
    s2: false,
    epoch: 1,
    iat: 1_782_820_800,
    exp: 1_782_824_400,
  };
}

/** The error `fn` throws; fails the test when it returns. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

/** A tenant transaction of `tenantId` whose every statement answers `rows`, and the statements it ran. */
function tenantTx(tenantId: string, rows: ProgramBindingRow[]): { tx: TenantTx; statements: string[] } {
  const statements: string[] = [];
  const query = (text: string | { text: string }): Promise<QueryResult<ProgramBindingRow>> => {
    statements.push(typeof text === 'string' ? text : text.text);
    return Promise.resolve(result(rows));
  };
  const tx = { kind: 'tenant', tenantId, schema: 'finance', query, onCommit: () => undefined } as unknown as TenantTx;
  return { tx, statements };
}

describe('FIXTURE_CHECK_ORDER', () => {
  it('orders the checks as api.cfm, then finance.cfc with auth.cfc, runs them, and is frozen', () => {
    expect(FIXTURE_CHECK_ORDER).toStrictEqual(['path', 'site', 'login', 'role', 'existence', 'validation', 'state']);
    expect(Object.isFrozen(FIXTURE_CHECK_ORDER)).toBe(true);
  });
});

describe('resolveFixtureSite', () => {
  it.each([
    ['a registered siteid', { siteid: TENANT_B.siteId }, TENANT_A.siteId, REGISTERED, TENANT_B.siteId],
    ['a case-variant siteid, as its registered id', { SiteID: 'TENANT-B' }, TENANT_A.siteId, REGISTERED, TENANT_B.siteId],
    ['the last spelling of siteid', { siteid: TENANT_A.siteId, SITEID: TENANT_B.siteId }, TENANT_A.siteId, REGISTERED, TENANT_B.siteId],
    ['an empty siteid, as the token site', { siteid: '' }, TENANT_A.siteId, REGISTERED, TENANT_A.siteId],
    ['a null siteid, as the token site', { siteid: null }, TENANT_A.siteId, REGISTERED, TENANT_A.siteId],
    ['no siteid, as the token site', {}, TENANT_B.siteId, REGISTERED, TENANT_B.siteId],
    ['no siteid and no token site, as default', {}, '', REGISTERED, 'default'],
  ])('resolves %s with the token tenant', async (_case, params, tokenSite, sites, siteId) => {
    const ctx = { claims: claims(tokenSite), registry: registry(sites).source };

    await expect(resolveFixtureSite(params, ctx)).resolves.toStrictEqual({ siteId, tenantId: ctx.claims.tid });
  });

  it.each([
    ['an unregistered siteid', { siteid: 'nosuch' }, TENANT_A.siteId, REGISTERED],
    ['a complex siteid', { siteid: [TENANT_A.siteId] }, TENANT_A.siteId, REGISTERED],
    ['a struct siteid', { siteid: { id: TENANT_A.siteId } }, TENANT_A.siteId, REGISTERED],
    ['a numeric siteid', { siteid: 5 }, TENANT_A.siteId, REGISTERED],
    ['no siteid beside an unregistered token site', {}, 'retired-site', REGISTERED],
    ['no siteid and no token site without a registered default', {}, '', [TENANT_A.siteId, TENANT_B.siteId]],
  ])('throws invalidParameters for %s instead of falling back', async (_case, params, tokenSite, sites) => {
    const promise = resolveFixtureSite(params, { claims: claims(tokenSite), registry: registry(sites).source });

    await expect(promise).rejects.toBeInstanceOf(FixtureApiError);
    await expect(promise).rejects.toMatchObject(INVALID_PARAMETERS);
  });
});

describe('fixtureDenialOverride', () => {
  it.each([
    ['missing credential', AuthDenial.unauthenticated('missing-credential')],
    ['invalid token', AuthDenial.invalidToken()],
    ['expired token', AuthDenial.expiredToken()],
    ['site mismatch', AuthDenial.siteMismatch()],
  ])('keeps a %s denial without reading the registry, even for an unregistered token site', async (_case, denial) => {
    const { source, statements } = registry();

    await expect(fixtureDenialOverride(denial, { claims: claims('retired-site'), registry: source })).resolves.toBe(denial);
    expect(statements).toStrictEqual([]);
  });

  it('keeps a role denial of a request without user claims', async () => {
    const denial = AuthDenial.forbidden();
    const { source, statements } = registry();

    await expect(fixtureDenialOverride(denial, { registry: source })).resolves.toBe(denial);
    expect(statements).toStrictEqual([]);
  });

  it.each([
    ['its registered id', TENANT_A.siteId],
    ['a case variant of its registered id', 'Tenant-A'],
  ])('keeps a role denial whose token site is %s', async (_case, site) => {
    const denial = AuthDenial.forbidden();

    await expect(fixtureDenialOverride(denial, { claims: claims(site), registry: registry().source })).resolves.toBe(denial);
  });

  it('answers a role denial of an unregistered token site with invalidParameters, as resolveSite raises before requireAny', async () => {
    const answer = await fixtureDenialOverride(AuthDenial.forbidden(), { claims: claims('retired-site'), registry: registry().source });

    expect(answer).toBeInstanceOf(FixtureApiError);
    expect(answer).toMatchObject(INVALID_PARAMETERS);
  });
});

describe('requireProgram', () => {
  const binding: ProgramBindingRow = {
    tenant_id: TENANT_A.tenantId,
    site_id: TENANT_A.siteId,
    legacy_program_id: 1,
    updated_at: new Date(Date.UTC(2026, 5, 30, 12)),
  };

  it("returns the tenant's Program_<id> binding", async () => {
    const { tx, statements } = tenantTx(TENANT_A.tenantId, [binding]);

    await expect(requireProgram(tx, TENANT_A.tenantId)).resolves.toBe(binding);
    expect(statements).toHaveLength(1);
  });

  it('throws invalidParameters for a tenant without a binding, as programFor does', async () => {
    const { tx } = tenantTx(TENANT_A.tenantId, []);
    const promise = requireProgram(tx, TENANT_A.tenantId);

    await expect(promise).rejects.toBeInstanceOf(FixtureApiError);
    await expect(promise).rejects.toMatchObject(INVALID_PARAMETERS);
  });

  it("throws TenantMismatchError without querying when the transaction is another tenant's", async () => {
    const { tx, statements } = tenantTx(TENANT_A.tenantId, [binding]);

    await expect(requireProgram(tx, TENANT_B.tenantId)).rejects.toMatchObject({
      name: 'TenantMismatchError',
      expected: TENANT_B.tenantId,
      actual: TENANT_A.tenantId,
    });
    await expect(requireProgram(tx, TENANT_B.tenantId)).rejects.toBeInstanceOf(TenantMismatchError);
    expect(statements).toStrictEqual([]);
  });
});

describe.each(['create', 'edit'] as const)('validateRecordInput in %s mode', (mode) => {
  it.each([
    ['the three fields', VALID, { title: 'Q2 travel', amount: 12_345_000n, period: '2026-06' }],
    [
      'fields keyed ignoring case, the last spelling winning',
      { Title: 'first', TITLE: 'Second', AMOUNT: '-0.0001', Period: '2026-12' },
      { title: 'Second', amount: -1n, period: '2026-12' },
    ],
    ['an untrimmed title and a trimmed amount', { ...VALID, title: '  padded  ', amount: ' 7 ' }, { title: '  padded  ', amount: 70_000n, period: '2026-06' }],
    ['a 255-character title', { ...VALID, title: 'x'.repeat(255) }, { title: 'x'.repeat(255), amount: 12_345_000n, period: '2026-06' }],
    ['a JSON number title as CFML renders it', { ...VALID, title: 2026 }, { title: '2026', amount: 12_345_000n, period: '2026-06' }],
    ['a 15-digit amount with four decimals', { ...VALID, amount: '999999999999999.9999' }, { title: 'Q2 travel', amount: 9_999_999_999_999_999_999n, period: '2026-06' }],
  ])('accepts %s', (_case, input, value) => {
    expect(validateRecordInput(input, mode)).toStrictEqual({ ok: true, value });
  });

  it.each<[string, Record<string, unknown>, RecordField]>([
    ['a missing title', { amount: VALID.amount, period: VALID.period }, 'title'],
    ['a null title', { ...VALID, title: null }, 'title'],
    ['an empty title', { ...VALID, title: '' }, 'title'],
    ['a title of spaces and control characters', { ...VALID, title: ' \t\u0000\r\n' }, 'title'],
    ['a 256-character title', { ...VALID, title: 'x'.repeat(256) }, 'title'],
    ['a padded title over 255 characters', { ...VALID, title: ` ${'x'.repeat(255)}` }, 'title'],
    ['an array title', { ...VALID, title: ['Q2 travel'] }, 'title'],
    ['a struct title', { ...VALID, title: { text: 'Q2 travel' } }, 'title'],
    ['an invalid title before an invalid amount and period', { title: ' ', amount: 'x', period: 'y' }, 'title'],
    ['a missing amount', { title: VALID.title, period: VALID.period }, 'amount'],
    ['an empty amount', { ...VALID, amount: '' }, 'amount'],
    ['a JSON number amount', { ...VALID, amount: 1234.5 }, 'amount'],
    ['an amount with five decimals', { ...VALID, amount: '1.23456' }, 'amount'],
    ['an amount with 16 integer digits', { ...VALID, amount: '1234567890123456' }, 'amount'],
    ['a grouped amount', { ...VALID, amount: '1,234.50' }, 'amount'],
    ['an exponent amount', { ...VALID, amount: '1e3' }, 'amount'],
    ['an invalid amount before an invalid period', { ...VALID, amount: '+1', period: '2026-13' }, 'amount'],
    ['a missing period', { title: VALID.title, amount: VALID.amount }, 'period'],
    ['a thirteenth month', { ...VALID, period: '2026-13' }, 'period'],
    ['a month zero', { ...VALID, period: '2026-00' }, 'period'],
    ['a one-digit month', { ...VALID, period: '2026-6' }, 'period'],
    ['a full date', { ...VALID, period: '2026-06-30' }, 'period'],
    ['a padded JSON period', { ...VALID, period: ' 2026-06' }, 'period'],
    ['a JSON number period', { ...VALID, period: 202606 }, 'period'],
    ['a JSON true period', { ...VALID, period: true }, 'period'],
    ['a JSON false period', { ...VALID, period: false }, 'period'],
    ['an array period', { ...VALID, period: ['2026-06'] }, 'period'],
  ])('rejects %s as invalidParameters naming the first invalid field', (_case, input, field) => {
    expect(validateRecordInput(input, mode)).toStrictEqual({ ok: false, type: 'invalidParameters', message: 'Invalid parameters', field });
  });
});

describe.each(['create', 'edit'] as const)('requireRecordInput in %s mode', (mode) => {
  /** requireRecordInput in this block's mode; it has no overload for a mode union. */
  const required = (input: Record<string, unknown>): unknown =>
    mode === 'create' ? requireRecordInput(input, 'create') : requireRecordInput(input, 'edit');

  it('returns the validated fields', () => {
    expect(required(VALID)).toStrictEqual({ title: 'Q2 travel', amount: 12_345_000n, period: '2026-06' });
  });

  it('throws invalidParameters with the default message for the first invalid field', () => {
    const error = thrownBy(() => required({ ...VALID, amount: 'twelve' }));

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ ...INVALID_PARAMETERS, detail: 'Invalid parameters' });
  });
});

describe('requireFinanceAction', () => {
  it.each([
    ['submit', 'submit'],
    ['APPROVE', 'approve'],
    ['Reject', 'reject'],
    ['reSubmit', 'resubmit'],
    ['EDIT', 'edit'],
  ])('reads the :action segment %s as %s, lower-cased as api.cfm reads it', (segment, action) => {
    expect(requireFinanceAction(segment)).toBe(action);
  });

  it('accepts every lifecycle action', () => {
    expect(FINANCE_ACTIONS.map((action) => requireFinanceAction(action))).toStrictEqual([...FINANCE_ACTIONS]);
  });

  it.each([['versions'], ['attachments'], [''], ['submit '], ['approved'], ['re-submit']])(
    'throws notFound for the segment %j',
    (segment) => {
      const error = thrownBy(() => requireFinanceAction(segment));

      expect(error).toBeInstanceOf(FixtureApiError);
      expect(error).toMatchObject({ type: 'notFound', message: 'notFound: Not Found' });
    },
  );
});

describe('runFixtureChecks', () => {
  it('runs the handler steps one at a time in check order, handing each a copy of the earlier results', async () => {
    const events: string[] = [];
    const received: Record<string, unknown> = {};
    /** A step that records its start and a snapshot of its argument, overwrites `path` in that argument, and resolves to `value` a turn later. */
    const step = <R>(name: string, value: R) => async (done: object): Promise<R> => {
      events.push(`${name}:start`);
      received[name] = { ...done };
      Object.assign(done, { path: 'overwritten' });
      await setImmediate();
      events.push(`${name}:end`);
      return value;
    };

    const results = await runFixtureChecks({
      path: async () => {
        events.push('path:start');
        await setImmediate();
        events.push('path:end');
        return 'P';
      },
      site: step('site', { siteId: TENANT_A.siteId }),
      existence: step('existence', 42),
      validation: step('validation', true),
      state: step('state', 'IN-PROGRESS'),
    });

    expect(events).toStrictEqual(
      ['path', 'site', 'existence', 'validation', 'state'].flatMap((name) => [`${name}:start`, `${name}:end`]),
    );
    expect(received).toStrictEqual({
      site: { path: 'P' },
      existence: { path: 'P', site: { siteId: TENANT_A.siteId } },
      validation: { path: 'P', site: { siteId: TENANT_A.siteId }, existence: 42 },
      state: { path: 'P', site: { siteId: TENANT_A.siteId }, existence: 42, validation: true },
    });
    expect(results).toStrictEqual({ path: 'P', site: { siteId: TENANT_A.siteId }, existence: 42, validation: true, state: 'IN-PROGRESS' });
  });

  it('leaves the result of a step that was not given undefined', async () => {
    const seen: unknown[] = [];

    const results = await runFixtureChecks({
      site: (done) => {
        seen.push({ ...done });
        return Promise.resolve(TENANT_B.siteId);
      },
      validation: (done) => {
        seen.push({ ...done });
        return Promise.resolve('fields');
      },
    });

    expect(seen).toStrictEqual([{ path: undefined }, { path: undefined, site: TENANT_B.siteId, existence: undefined }]);
    expect(results).toStrictEqual({ path: undefined, site: TENANT_B.siteId, existence: undefined, validation: 'fields', state: undefined });
  });

  it('resolves every result undefined when no step is given', async () => {
    await expect(runFixtureChecks({})).resolves.toStrictEqual({
      path: undefined,
      site: undefined,
      existence: undefined,
      validation: undefined,
      state: undefined,
    });
  });

  it('propagates the first failure and runs no later step', async () => {
    const ran: string[] = [];
    const failure = new FixtureApiError('notFound');

    /** A step that records `name` and settles as `settle` does. */
    const step = <R>(name: string, settle: () => Promise<R>) => (): Promise<R> => {
      ran.push(name);
      return settle();
    };

    const promise = runFixtureChecks({
      path: step('path', () => Promise.resolve('P')),
      site: step('site', () => Promise.reject(failure)),
      existence: step('existence', () => Promise.reject(new FixtureApiError('invalidParameters'))),
      validation: step('validation', () => Promise.resolve()),
      state: step('state', () => Promise.resolve()),
    });

    await expect(promise).rejects.toBe(failure);
    expect(ran).toStrictEqual(['path', 'site']);
  });
});
