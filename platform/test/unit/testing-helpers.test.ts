import { describe, expect, it } from 'vitest';
import { AuthDenial, rolesForService } from '../../src/auth/index.js';
import {
  BUSINESS_DATE,
  ContractAssertionError,
  ROLE_SET,
  SERVICE_CALLERS,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  asOf,
  assertEventMatches,
  assertProducerConsumerCompatible,
  assertResponseMatchesOpenApi,
  businessClock,
  crossTenantPairs,
  fixtureForSite,
  fixtureForTenant,
  mintServiceToken,
  mintUserToken,
  poolTenantExpectation,
  registryPayloads,
  routeKeyConflictCases,
  testEnvelope,
  testVerifier,
  userPoolFanoutExpectation,
  type ConsumerExpectation,
  type ResponseUnderTest,
} from '../../src/testing/index.js';

function contractError(check: () => unknown): ContractAssertionError {
  try {
    check();
  } catch (error) {
    if (error instanceof ContractAssertionError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected a ContractAssertionError');
}

describe('business clock', () => {
  it('fixes the business date at 2026-06-30', () => {
    expect(BUSINESS_DATE).toBe('2026-06-30');
  });

  it.each([
    ['the business date by default', undefined, '2026-06-30'],
    ['a local Date', new Date(2026, 0, 2), '2026-01-02'],
    ['a date-only string', '2026-01-02', '2026-01-02'],
  ])('asOf formats %s as yyyy-mm-dd', (_case, input, expected) => {
    expect(asOf(input)).toBe(expected);
  });

  it.each(['2026-02-30', 'not a date'])('asOf rejects %s', (input) => {
    expect(() => asOf(input)).toThrow(RangeError);
  });

  it('businessClock reads local noon of the business date unless given another time', () => {
    expect(businessClock().now().getTime()).toBe(new Date(2026, 5, 30, 12, 0, 0).getTime());
    expect(businessClock('08:30:15').now().getTime()).toBe(new Date(2026, 5, 30, 8, 30, 15).getTime());
    expect(asOf(businessClock().now())).toBe(BUSINESS_DATE);
  });
});

describe('tenant fixtures', () => {
  it.each([
    { fixture: TENANT_A, key: 'A', siteId: 'tenant-a', tenantId: 'edec963e-3516-5bb6-845d-d01a710e32a7' },
    { fixture: TENANT_B, key: 'B', siteId: 'tenant-b', tenantId: '13ab03ed-8b4b-5174-b787-d32a11dd8793' },
    { fixture: TENANT_UMBRELLA, key: 'umbrella', siteId: 'umbrella', tenantId: '455225fe-8c2a-5c61-b33e-f9a8f2cac49a' },
  ])('site $siteId is tenant $tenantId', ({ fixture, key, siteId, tenantId }) => {
    expect(fixture).toEqual({ key, siteId, tenantId });
  });

  const ownPools = (siteId: string) => ({
    publicUserPoolId: siteId,
    privateUserPoolId: siteId,
    categoryPoolId: siteId,
    filePoolId: siteId,
    displayPoolId: siteId,
    contentPoolIds: [siteId],
  });

  it.each([
    ['tenant-a', { ...ownPools('umbrella'), privateUserPoolId: 'tenant-a', contentPoolIds: ['tenant-a'] }],
    ['tenant-b', ownPools('tenant-b')],
    ['umbrella', ownPools('umbrella')],
  ])('registryPayloads gives %s its seeded pools', (siteId, pools) => {
    expect(registryPayloads().find((payload) => payload.siteId === siteId)).toMatchObject(pools);
  });

  it('registryPayloads lists tenant-a, tenant-b and umbrella in order, as fresh objects per call', () => {
    const first = registryPayloads();
    expect(first.map((payload) => payload.siteId)).toEqual(['tenant-a', 'tenant-b', 'umbrella']);
    expect(registryPayloads()).toStrictEqual(first);
    expect(registryPayloads()[0]).not.toBe(first[0]);
  });

  it('looks fixtures up by site or tenant id regardless of case', () => {
    expect(fixtureForSite('TENANT-A')).toBe(TENANT_A);
    expect(fixtureForTenant(TENANT_B.tenantId.toUpperCase())).toBe(TENANT_B);
    expect(fixtureForSite('default')).toBeUndefined();
  });

  it('crossTenantPairs orders every pair of distinct fixtures once', () => {
    const pairs = crossTenantPairs().map(({ writer, reader }) => `${writer.key}>${reader.key}`);
    expect(pairs).toEqual(['A>B', 'A>umbrella', 'B>A', 'B>umbrella', 'umbrella>A', 'umbrella>B']);
  });

  it('resolves pool tenants and userPool fan-out from the seeded pools', () => {
    expect(poolTenantExpectation(TENANT_A, 'publicUser')).toBe(TENANT_UMBRELLA.tenantId);
    expect(poolTenantExpectation(TENANT_A, 'privateUser')).toBe(TENANT_A.tenantId);
    expect(userPoolFanoutExpectation(TENANT_UMBRELLA)).toEqual(new Set([TENANT_UMBRELLA.tenantId, TENANT_A.tenantId]));
    expect(userPoolFanoutExpectation(TENANT_B)).toEqual(new Set([TENANT_B.tenantId]));
  });
});

const SYNTHETIC_ROLE_NAMES = [
  'timesheets.employee',
  'timesheets.primary-approver',
  'timesheets.secondary-approver',
  'finance.preparer',
  'finance.approver',
  'esignature.signer',
  'esignature.auditor',
  'reporting.exporter',
  'surveys.manager',
  'communications.sender',
];

const DEPLOYED_SERVICES = [
  'identity',
  'people',
  'programs-sites',
  'strategies-content',
  'communications',
  'reporting',
  'surveys',
  'timesheets',
  'finance',
  'e-signature',
];

describe('test tokens', () => {
  it('mintUserToken for tenant-a verifies through the test user verifier with the tenant-a tid and site', async () => {
    const token = await mintUserToken({ sub: 'U1', site: 'tenant-a', roles: ['site-admin'] });
    await expect(testVerifier().userVerifier.verify(token)).resolves.toMatchObject({
      sub: 'U1',
      tid: TENANT_A.tenantId,
      site: 'tenant-a',
      roles: ['site-admin'],
      s2: false,
    });
  });

  it('mintServiceToken verifies through the local service verifier of its audience and no other', async () => {
    const token = await mintServiceToken({ caller: 'gateway', audience: 'people' });
    await expect(testVerifier('people').invocationVerifier.verify(`Bearer ${token}`)).resolves.toEqual({
      name: 'gateway',
      roles: ['service:gateway'],
    });
    const elsewhere = testVerifier('identity').invocationVerifier.verify(`Bearer ${token}`);
    await expect(elsewhere).rejects.toBeInstanceOf(AuthDenial);
    await expect(elsewhere).rejects.toMatchObject({ reason: 'invalid-credential' });
  });

  it('ROLE_SET holds the user identities, the ten synthetic roles and a service subject per caller', () => {
    const byName = new Map(ROLE_SET.map((subject) => [subject.name, subject]));
    const userNames = ['member', 'system-user', 'editor', 'site-admin', 's2', 'other-tenant'];
    const serviceNames = SERVICE_CALLERS.map((caller) => `service:${caller}`);
    expect([...byName.keys()]).toEqual(
      expect.arrayContaining(['anonymous', ...userNames, ...SYNTHETIC_ROLE_NAMES, ...serviceNames]),
    );
    expect(byName.get('anonymous')).toMatchObject({ kind: 'anonymous', roles: [] });
    for (const name of [...userNames, ...SYNTHETIC_ROLE_NAMES]) {
      expect(byName.get(name)?.kind).toBe('user');
    }
    for (const role of SYNTHETIC_ROLE_NAMES) {
      expect(byName.get(role)?.roles).toContain(role);
    }
    expect(SERVICE_CALLERS).toEqual(expect.arrayContaining([...DEPLOYED_SERVICES, 'gateway', 'migration']));
    for (const caller of SERVICE_CALLERS) {
      expect(byName.get(`service:${caller}`)).toMatchObject({ kind: 'service', caller, roles: rolesForService(caller) });
    }
  });
});

const json = (ref: string) => ({ 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } });

const notesDoc = {
  openapi: '3.1.0',
  info: { title: 'testing-helpers notes', version: '1.0.0' },
  paths: {
    '/v1/notes/{id}': {
      get: {
        operationId: 'getNote',
        responses: {
          '200': { description: 'note', content: json('Note') },
          '409': { description: 'conflict', content: json('Conflict') },
          '4XX': { description: 'client error', content: json('ClientError') },
          default: { description: 'server error', content: json('ServerError') },
        },
      },
      delete: {
        operationId: 'deleteNote',
        responses: {
          '204': { description: 'deleted' },
          default: { description: 'server error', content: json('ServerError') },
        },
      },
    },
  },
  components: {
    schemas: {
      Note: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title'],
        properties: { id: { type: 'string' }, title: { type: 'string' } },
      },
      Conflict: { type: 'object', required: ['conflictingId'], properties: { conflictingId: { type: 'string' } } },
      ClientError: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      ServerError: { type: 'object', required: ['fault'], properties: { fault: { type: 'string' } } },
    },
  },
};

const note = { id: 'N1', title: 'Hello' };

const noteResponse = (overrides: Partial<ResponseUnderTest> = {}): ResponseUnderTest => ({
  method: 'GET',
  path: '/v1/notes/N1',
  status: 200,
  contentType: 'application/json; charset=utf-8',
  body: note,
  ...overrides,
});

describe('assertResponseMatchesOpenApi', () => {
  it('passes a matching body on /v1/notes/{id} 200 and returns it', () => {
    expect(assertResponseMatchesOpenApi(notesDoc, noteResponse())).toEqual(note);
  });

  it('fails a wrongly typed field with ContractAssertionError', () => {
    const error = contractError(() => assertResponseMatchesOpenApi(notesDoc, noteResponse({ body: { ...note, id: 1 } })));
    expect(error.context).toBe('GET /v1/notes/{id} 200 application/json');
    expect(error.errors).toEqual([expect.objectContaining({ instancePath: '/id', keyword: 'type' })]);
  });

  it.each([
    { route: 'an exact status before 4XX', method: 'GET', status: 409, fits: { conflictingId: 'N2' }, misfits: { error: 'x' } },
    { route: 'a 404 through 4XX', method: 'GET', status: 404, fits: { error: 'notFound' }, misfits: { fault: 'x' } },
    { route: 'a 500 through default', method: 'GET', status: 500, fits: { fault: 'x' }, misfits: { error: 'x' } },
    { route: 'a 404 through default without 4XX', method: 'DELETE', status: 404, fits: { fault: 'x' }, misfits: { error: 'x' } },
  ])('validates $route', ({ method, status, fits, misfits }) => {
    expect(assertResponseMatchesOpenApi(notesDoc, noteResponse({ method, status, body: fits }))).toEqual(fits);
    const error = contractError(() => assertResponseMatchesOpenApi(notesDoc, noteResponse({ method, status, body: misfits })));
    expect(error.errors[0]).toMatchObject({ keyword: 'required' });
  });

  it.each(['application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON'])(
    'matches %s to the declared application/json and parses text bodies',
    (contentType) => {
      expect(assertResponseMatchesOpenApi(notesDoc, noteResponse({ contentType, body: JSON.stringify(note) }))).toEqual(note);
    },
  );

  it('fails a media type the response does not declare', () => {
    const error = contractError(() =>
      assertResponseMatchesOpenApi(notesDoc, noteResponse({ contentType: 'text/html; charset=utf-8' })),
    );
    expect(error.errors).toEqual([expect.objectContaining({ keyword: 'content' })]);
  });
});

const NOTE_TOPIC = 'stub.note.created.v1';

const notePayloadSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `urn:opt2:testing-helpers:event:${NOTE_TOPIC}`,
  title: `${NOTE_TOPIC} payload`,
  'x-opt2-kind': 'state',
  type: 'object',
  additionalProperties: false,
  required: ['noteId', 'title'],
  properties: {
    noteId: { type: 'string', minLength: 1 },
    title: { type: 'string' },
    pinned: { type: 'boolean' },
  },
};

const noteEnvelope = (payload: unknown) =>
  testEnvelope({ topic: NOTE_TOPIC, tenantId: TENANT_A.tenantId, aggregateId: 'N1', payload });

describe('assertEventMatches', () => {
  it('passes a testEnvelope with a valid payload against the platform envelope contract', () => {
    const envelope = noteEnvelope({ noteId: 'N1', title: 'Hello' });
    expect(assertEventMatches(undefined, notePayloadSchema, envelope)).toBe(envelope);
  });

  it.each([
    ['a missing required field', { noteId: 'N1' }, 'payload'],
    ['a wrongly typed field', { noteId: 'N1', title: 'Hello', pinned: 'yes' }, 'payload/pinned'],
  ])('fails a testEnvelope whose payload has %s', (_case, payload, instancePath) => {
    const error = contractError(() => assertEventMatches(undefined, notePayloadSchema, noteEnvelope(payload)));
    expect(error.context).toBe(`event ${NOTE_TOPIC}`);
    expect(error.errors).toEqual([expect.objectContaining({ instancePath })]);
  });
});

describe('assertProducerConsumerCompatible', () => {
  it('passes when every required field exists with the type and kind the consumer expects', () => {
    const expectation: ConsumerExpectation = {
      required: ['noteId', 'title'],
      types: { noteId: 'string', pinned: 'boolean' },
      kind: 'state',
    };
    expect(() => assertProducerConsumerCompatible(notePayloadSchema, expectation)).not.toThrow();
  });

  it.each<[string, ConsumerExpectation, string]>([
    ['a required field the producer does not declare', { required: ['body'] }, 'properties'],
    ['a required field the producer leaves optional', { required: ['pinned'] }, 'required'],
    ['a field of another type', { required: ['title'], types: { title: 'integer' } }, 'type'],
    ['another event kind', { required: ['noteId'], kind: 'process' }, 'x-opt2-kind'],
  ])('fails on %s', (_case, expectation, keyword) => {
    const error = contractError(() => assertProducerConsumerCompatible(notePayloadSchema, expectation));
    expect(error.errors).toEqual([expect.objectContaining({ keyword })]);
  });
});

describe('routeKeyConflictCases', () => {
  it('names every case once', () => {
    const names = routeKeyConflictCases.map((conflict) => conflict.name);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(routeKeyConflictCases)('$name cites its legacy source and expects a lower-case family key', ({ source, expectedKey }) => {
    expect(source.trim()).not.toBe('');
    expect(expectedKey).toBe(expectedKey.toLowerCase());
    expect(expectedKey).toMatch(/^[a-z0-9-]+:/);
  });
});
