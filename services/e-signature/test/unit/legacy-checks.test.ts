// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** E-signature fixture checks against legacy-fixtures/cfml api.cfm, lib/auth.cfc resolveSite and modules/esignature.cfc. */
import { describe, expect, expectTypeOf, it } from 'vitest';
import { AuthDenial, type UserClaims } from '@opt2/platform/auth';
import { tenantIdForSite, type MetadataTx, type QueryResult } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B } from '@opt2/platform/testing';
import { FixtureApiError, toFixtureError } from '../../src/legacy/envelope.js';
import type { CreateRequestInput, SignInput, SuppliedAuditEntry } from '../../src/domain/signing.js';
import {
  FIXTURE_CHECK_ORDER,
  fixtureDenialOverride,
  resolveFixtureSite,
  runFixtureChecks,
  validateCreateInput,
  validateSignInput,
  validateSuppliedChain,
  type FixtureCheckStep,
} from '../../src/legacy/checks.js';

const REGISTERED = [TENANT_A.siteId, TENANT_B.siteId, 'default'] as const;
const INVALID = { ok: false, type: 'invalidParameters', message: 'Invalid parameters' };

/** Rows of a fake pg result. */
function result<R extends Record<string, unknown>>(rows: R[]): QueryResult<R> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

/** A registry reader over `sites` answering the two `tenant_registry` lookups of the checks. */
function registry(sites: readonly string[] = REGISTERED): MetadataTx {
  const answer = (sql: string, value: unknown): QueryResult<Record<string, unknown>> => {
    if (sql.includes('lower(site_id) = lower($1)')) {
      const lower = String(value).toLowerCase();
      return result(sites.filter((s) => s.toLowerCase() === lower).map((s) => ({ tenant_id: tenantIdForSite(s) })));
    }
    if (sql.includes('WHERE tenant_id = $1')) {
      return result(sites.filter((s) => tenantIdForSite(s) === value).map((s) => ({ site_id: s })));
    }
    throw new Error(`unexpected ${sql}`);
  };
  const query = (text: string | { text: string }, values: unknown[] = []) =>
    Promise.resolve(answer(typeof text === 'string' ? text : text.text, values[0]));
  return { kind: 'metadata', schema: 'esignature', query, onCommit: () => undefined } as unknown as MetadataTx;
}

/** Verified claims of a `site` token; the tenant is the site's unless overridden. */
function claims(site: string, overrides: Partial<UserClaims> = {}): UserClaims {
  return {
    iss: 'opt2-local-identity',
    aud: 'opt2-local',
    sub: 'A1B2C3D4-0000-0000-0000000000000001',
    sid: 's',
    tid: tenantIdForSite(site === '' ? 'default' : site),
    site,
    roles: ['esignature.signer'],
    s2: false,
    epoch: 1,
    iat: 1,
    exp: 2,
    ...overrides,
  };
}

/** The error `p` rejects with; fails the test when it resolves. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

describe('FIXTURE_CHECK_ORDER', () => {
  it('is api.cfm then esignature.cfc order', () => {
    expect(FIXTURE_CHECK_ORDER).toEqual(['path', 'site', 'login', 'role', 'existence', 'validation', 'state']);
    expect(Object.isFrozen(FIXTURE_CHECK_ORDER)).toBe(true);
  });
});

describe('resolveFixtureSite', () => {
  it.each([
    [{ siteid: 'tenant-a' }, 'tenant-a', 'tenant-a'],
    [{ SITEID: 'TENANT-A' }, 'tenant-a', 'tenant-a'],
    [{}, 'tenant-a', 'tenant-a'],
    [{ siteid: '' }, 'tenant-b', 'tenant-b'],
    [{}, '', 'default'],
  ])('%j with token site %s -> %s', async (params, site, expected) => {
    const c = claims(site);
    await expect(resolveFixtureSite(params, c, registry())).resolves.toEqual({ siteId: expected, tenantId: c.tid });
  });

  it.each([[{ siteid: 'nope' }], [{ siteid: { a: 1 } }], [{ siteid: ['tenant-a'] }]])('unknown or complex %j -> invalidParameters', async (params) => {
    const err = await rejection(resolveFixtureSite(params, claims('tenant-a'), registry()));
    expect(err).toBeInstanceOf(FixtureApiError);
    expect((err as FixtureApiError).type).toBe('invalidParameters');
    expect((err as FixtureApiError).message).toBe('Invalid parameters');
  });

  it('token site unregistered -> invalidParameters', async () => {
    const err = await rejection(resolveFixtureSite({}, claims('tenant-a'), registry(['default'])));
    expect((err as FixtureApiError).type).toBe('invalidParameters');
  });

  it('registered site of another tenant -> site mismatch 403', async () => {
    const err = await rejection(resolveFixtureSite({ siteid: 'tenant-b' }, claims('tenant-a'), registry()));
    expect(err).toBeInstanceOf(AuthDenial);
    expect((err as AuthDenial).statusCode).toBe(403);
    expect((err as AuthDenial).reason).toBe('site-mismatch');
    expect(toFixtureError(err, { method: 'esignature.requests', params: {} }).status).toBe(403);
  });

  it('default fallback that is not the token tenant -> mismatch', async () => {
    const err = await rejection(resolveFixtureSite({}, claims('', { tid: tenantIdForSite('tenant-a') }), registry()));
    expect((err as AuthDenial).reason).toBe('site-mismatch');
  });

  it('tenant compare ignores case of tid', async () => {
    const c = claims('tenant-a');
    const upper = { ...c, tid: c.tid.toUpperCase() };
    await expect(resolveFixtureSite({}, upper, registry())).resolves.toEqual({ siteId: 'tenant-a', tenantId: upper.tid });
  });
});

describe('fixtureDenialOverride', () => {
  it('keeps non-forbidden denials and denials without claims', async () => {
    const d = AuthDenial.unauthenticated('missing-credential');
    expect(await fixtureDenialOverride(d, { claims: claims('tenant-a'), registry: registry() })).toBe(d);
    const f = AuthDenial.forbidden();
    expect(await fixtureDenialOverride(f, { registry: registry() })).toBe(f);
    const m = AuthDenial.siteMismatch();
    expect(await fixtureDenialOverride(m, { claims: claims('tenant-a'), registry: registry() })).toBe(m);
  });
  it('unregistered token site -> invalidParameters', async () => {
    const r = await fixtureDenialOverride(AuthDenial.forbidden(), { claims: claims('tenant-a'), registry: registry(['default']) });
    expect(r).toBeInstanceOf(FixtureApiError);
    expect((r as FixtureApiError).type).toBe('invalidParameters');
  });
  it('empty token site resolves default', async () => {
    const f = AuthDenial.forbidden();
    expect(await fixtureDenialOverride(f, { claims: claims(''), registry: registry() })).toBe(f);
  });
  it('anonymous session -> authorization; else unchanged', async () => {
    const r = await fixtureDenialOverride(AuthDenial.forbidden(), { claims: claims('tenant-a', { sub: '' }), registry: registry() });
    expect((r as FixtureApiError).type).toBe('authorization');
    const f = AuthDenial.forbidden();
    expect(await fixtureDenialOverride(f, { claims: claims('tenant-a'), registry: registry() })).toBe(f);
  });
});

describe('validateCreateInput', () => {
  const valid = { documentName: 'doc.txt', documentBase64: 'R1MtRVMgZ29sZGVuIGRvY3VtZW50', signerUserId: 'U1' };
  it('accepts and decodes', () => {
    const r = validateCreateInput(valid);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.document.toString('utf8')).toBe('GS-ES golden document');
      expect(r.value.documentName).toBe('doc.txt');
      expect(r.value.signerUserId).toBe('U1');
    }
  });
  it.each([
    [{ ...valid, documentName: '' }],
    [{ ...valid, documentName: 'x'.repeat(256) }],
    [{ ...valid, documentName: { a: 1 } }],
    [{ documentBase64: valid.documentBase64, signerUserId: 'U1' }],
    [{ ...valid, documentBase64: '' }],
    [{ ...valid, documentBase64: '====' }],
    [{ ...valid, documentBase64: 'QQ' }],
    [{ ...valid, documentBase64: '-_8=' }],
    [{ ...valid, documentBase64: 'QUJD\u00a0' }],
    [{ ...valid, signerUserId: '' }],
    [{ ...valid, signerUserId: ['a'] }],
  ])('rejects %j', (params) => {
    expect(validateCreateInput(params)).toEqual(INVALID);
  });
  it('accepts 255 chars, case-insensitive keys, whitespace in base64', () => {
    const r = validateCreateInput({ DOCUMENTNAME: 'y'.repeat(255), documentbase64: 'QUJD\u2028RA==', SignerUserID: 'U' });
    expect(r.ok && r.value.document.toString('hex')).toBe('41424344');
  });
  // Bytes ACF 2023 binaryDecode(input, 'base64') returned, as hex; null where it threw or decoded no byte.
  it.each([
    ['QQ==', '41'],
    ['QQ=', '41'],
    ['QQ', null],
    ['Q', null],
    ['!!!!', null],
    ['QUJD RA==', '41424344'],
    ['QUJD\nRA==', '41424344'],
    ['QUJD\r\nRA==', '41424344'],
    [' QUJD', '414243'],
    ['QUJD ', '414243'],
    ['QUJDRA==QQ==', '414243440410'],
    ['-_8=', null],
    ['+/8=', 'FBFF'],
    ['QUJDRA===', '41424344'],
    ['QUJDRAx', null],
    ['QUJDR', null],
    ['QUJD=', '414243'],
    ['QU=D', null],
    ['AA==', '00'],
    ['AB=', '00'],
    ['AQ ', '01'],
    ['A ', null],
    ['Zm9vYmFy', '666F6F626172'],
    ['Zm9vYg', null],
    ['p1 \f', 'A7'],
    ['KTx\u001f', '293C'],
    ['uya\u2028\u2028L', 'BB268B'],
    ['b\u000bRs\tgHw', null],
    ['M5ReP\u0000ihf', null],
    ['2\u00e96f_mr', null],
  ])('decodes documentBase64 %j as ACF does', (documentBase64, hex) => {
    const r = validateCreateInput({ documentName: 'n', documentBase64, signerUserId: 'U' });
    expect(r.ok ? r.value.document.toString('hex').toUpperCase() : null).toBe(hex);
  });
});

describe('validateSignInput', () => {
  it.each([
    [{ typedName: 'Golden Signer' }, 'Golden Signer'],
    [{ TYPEDNAME: '  ' }, '  '],
    [{}, ''],
    [{ typedName: { a: 1 } }, ''],
    [{ typedName: 5 }, '5'],
  ])('%j -> %j', (params, typedName) => {
    expect(validateSignInput('ID-1', params)).toEqual({ ok: true, value: { requestId: 'ID-1', typedName } });
  });
});

describe('validateSuppliedChain', () => {
  const entry = { seq: 1, action: 'created', actor_user_id: 'U', detail: 'abc', at: '2026-06-30T10:00:00.000', prev_hash: '0'.repeat(64), entry_hash: 'a'.repeat(64), entry_id: 'x' };
  const text: SuppliedAuditEntry = { seq: '1', action: 'created', actor_user_id: 'U', detail: 'abc', at: '2026-06-30T10:00:00.000', prev_hash: '0'.repeat(64), entry_hash: 'a'.repeat(64) };
  it('reads arrays and JSON text', () => {
    expect(validateSuppliedChain({ entries: [entry] })).toEqual({ ok: true, value: [text] });
    expect(validateSuppliedChain({ ENTRIES: JSON.stringify([entry, entry]) })).toEqual({ ok: true, value: [text, text] });
    expect(validateSuppliedChain({ entries: [] })).toEqual({ ok: true, value: [] });
  });
  it('renders simple values as CFML toString and keys ignoring case, last wins', () => {
    const r = validateSuppliedChain({ entries: [{ ...entry, SEQ: 2, action: true, detail: 1.5, actor_user_id: 1e3 }] });
    expect(r).toEqual({ ok: true, value: [{ ...text, seq: '2', action: 'YES', detail: '1.5', actor_user_id: '1000' }] });
  });
  it.each([
    [{}],
    [{ entries: '' }],
    [{ entries: 'not json' }],
    [{ entries: '{"a":1}' }],
    [{ entries: { seq: 1 } }],
    [{ entries: [null] }],
    [{ entries: [[entry]] }],
    [{ entries: ['x'] }],
    [{ entries: [{ ...entry, detail: null }] }],
    [{ entries: [{ ...entry, detail: { a: 1 } }] }],
    [{ entries: [entry, { seq: 2 }] }],
  ])('rejects %j', (params) => {
    expect(validateSuppliedChain(params)).toEqual(INVALID);
  });
});

describe('runFixtureChecks', () => {
  it('runs in fixture order and returns values in given order', async () => {
    const ran: FixtureCheckStep[] = [];
    const [validation, existence, site] = await runFixtureChecks([
      { step: 'validation', check: () => (ran.push('validation'), validateCreateInput({ documentName: 'a', documentBase64: 'QQ==', signerUserId: 'U' })) },
      { step: 'existence', check: async () => void ran.push('existence') },
      { step: 'site', check: async () => (ran.push('site'), { ok: true as const, value: { siteId: 's', tenantId: 't' } }) },
    ]);
    expect(ran).toEqual(['site', 'existence', 'validation']);
    expectTypeOf(validation).toEqualTypeOf<CreateRequestInput>();
    expectTypeOf(existence).toEqualTypeOf<undefined>();
    expectTypeOf(site).toEqualTypeOf<{ siteId: string; tenantId: string }>();
    expect(validation.documentName).toBe('a');
    expect(existence).toBeUndefined();
    expect(site).toEqual({ siteId: 's', tenantId: 't' });
  });

  it('earliest failing step wins and later checks do not run', async () => {
    const ran: string[] = [];
    const err = await rejection(
      runFixtureChecks([
        { step: 'state', check: () => void ran.push('state') },
        { step: 'validation', check: () => (ran.push('validation'), validateSuppliedChain({})) },
        { step: 'existence', check: () => { ran.push('existence'); throw new FixtureApiError('notFound'); } },
        { step: 'path', check: () => void ran.push('path') },
      ]),
    );
    expect(err).toBeInstanceOf(FixtureApiError);
    expect((err as FixtureApiError).type).toBe('notFound');
    expect(ran).toEqual(['path', 'existence']);
  });

  it('a failed ValidationResult throws its type and message', async () => {
    const err = await rejection(
      runFixtureChecks([
        { step: 'state', check: () => ({ ok: false as const, type: 'conflict' as const, message: 'already-signed' }) },
        { step: 'validation', check: () => validateCreateInput({}) },
      ]),
    );
    expect((err as FixtureApiError).type).toBe('invalidParameters');
    expect((err as FixtureApiError).message).toBe('Invalid parameters');
    const state = await rejection(runFixtureChecks([{ step: 'state', check: () => ({ ok: false as const, type: 'conflict' as const, message: 'already-signed' }) }]));
    expect((state as FixtureApiError).message).toBe('already-signed');
  });

  it('keeps given order within one step and handles empty lists', async () => {
    const ran: number[] = [];
    await runFixtureChecks([
      { step: 'validation', check: () => void ran.push(1) },
      { step: 'validation', check: () => void ran.push(2) },
    ]);
    expect(ran).toEqual([1, 2]);
    expect(await runFixtureChecks([])).toEqual([]);
    const sign: SignInput = (await runFixtureChecks([{ step: 'validation', check: () => validateSignInput('I', { typedName: 'N' }) }]))[0];
    expect(sign).toEqual({ requestId: 'I', typedName: 'N' });
  });
});
