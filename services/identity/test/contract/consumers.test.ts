/** Consumer contracts of identity: the producer event schemas its consumers read and the gateway, people and strategies-content operations it calls. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readTopicSchema } from '@opt2/platform/events';
import { generateCsrfToken, legacyErrorResponse, routeKeyForRequest } from '@opt2/platform/legacy-compat';
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import type { SiteChangedPayload } from '@opt2/platform/tenancy';
import {
  ContractAssertionError,
  TENANT_A,
  assertProducerConsumerCompatible,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
  type ConsumerExpectation,
  type ContractViolation,
  type OperationMatch,
} from '@opt2/platform/testing';
import type { PersonChangedPayload } from '../../src/events/person-contact.js';
import { GATEWAY_SERVICE, createBridgeRelay, type MarkUsedResult } from '../../src/legacy/bridge-relay.js';
import { createContentClient } from '../../src/legacy/content-client.js';
import { TEST_CLOCK, buildTestApp, createClientRecorder, headersFor } from '../helpers/app.js';
import { SITE_ADMIN_A } from '../helpers/rows.js';
import { registryAnswer } from '../helpers/service.js';

interface OpenApiDoc {
  readonly paths: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** A parsed OpenAPI contract and its repository path, which failures name. */
interface Contract {
  readonly file: string;
  readonly doc: OpenApiDoc;
}

interface Exchange {
  readonly req: ServiceRequest;
  readonly res: ServiceResponse;
}

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SELF_ROLE = 'service:identity';
const SESSION_ID = 'C0000000-0000-0000-0000000000000029';
const SESSION_SECRET = 'K0000000-0000-0000-0000000000000029';
const PHOTO_ID = 'F0000000-0000-0000-0000000000000029';
const MARK_USED_TEMPLATE = '/internal/v1/legacy-sessions/{sid}:mark-used';
const FILES_LOOKUP_PATH = '/internal/v1/files:lookup';
const CURRENT_USER_URL = `/_api/json/v1/${TENANT_A.siteId}/findCurrentUser`;

function loadContract(url: URL): Contract {
  return { file: path.relative(REPO_ROOT, fileURLToPath(url)), doc: parse(readFileSync(url, 'utf8')) as OpenApiDoc };
}

const IDENTITY = loadContract(new URL('../../contracts/openapi.yaml', import.meta.url));
const CALLEES: Readonly<Record<string, Contract>> = {
  [GATEWAY_SERVICE]: loadContract(new URL('../../../../gateway/contracts/openapi.yaml', import.meta.url)),
  people: loadContract(new URL('../../../people/contracts/openapi.yaml', import.meta.url)),
  'strategies-content': loadContract(new URL('../../../strategies-content/contracts/openapi.yaml', import.meta.url)),
};

const personSchema = readTopicSchema(new URL('../../../people/contracts/events/people.person.changed.v1.json', import.meta.url));
const siteSchema = readTopicSchema(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url));

/** Every person field the person-contact consumer reads: it stores the whole person state. */
const PERSON_FIELDS = {
  userId: true,
  siteId: true,
  deleted: true,
  groupName: true,
  fname: true,
  lname: true,
  email: true,
  company: true,
  jobTitle: true,
  mobilePhone: true,
  website: true,
  subType: true,
  ext: true,
  contactForm: true,
  subscribe: true,
  notes: true,
  description: true,
  interests: true,
  keepPrivate: true,
  photoFileId: true,
  imName: true,
  imService: true,
  tags: true,
  created: true,
  lastUpdate: true,
  lastUpdateBy: true,
  lastUpdateById: true,
} satisfies Record<keyof PersonChangedPayload, true>;

/** Every site field identity's tenant registry reads. */
const SITE_FIELDS = {
  siteId: true,
  publicUserPoolId: true,
  privateUserPoolId: true,
  categoryPoolId: true,
  filePoolId: true,
  displayPoolId: true,
  contentPoolIds: true,
  domains: true,
} satisfies Record<keyof SiteChangedPayload, true>;

const LIVE_PERSON: PersonChangedPayload = {
  userId: SITE_ADMIN_A.account.userid,
  siteId: SITE_ADMIN_A.siteId,
  deleted: false,
  groupName: null,
  fname: 'Site',
  lname: 'Admin',
  email: `site_admin_a@${TENANT_A.siteId}.opt2.test`,
  company: 'Tenant A',
  jobTitle: 'Administrator',
  mobilePhone: '555-0129',
  website: `https://${TENANT_A.siteId}.opt2.test`,
  subType: 'Default',
  ext: 29,
  contactForm: '',
  subscribe: 1,
  notes: 'Seeded',
  description: '',
  interests: '',
  keepPrivate: 0,
  photoFileId: PHOTO_ID,
  imName: 'siteadmin',
  imService: 'AIM',
  tags: 'admin',
  created: '2026-06-01 09:00:00.000',
  lastUpdate: '2026-06-30 12:00:00.123',
  lastUpdateBy: 'Admin User',
  lastUpdateById: SITE_ADMIN_A.account.userid,
};

const DELETED_PERSON: PersonChangedPayload = {
  ...(Object.fromEntries(Object.keys(PERSON_FIELDS).map((field) => [field, null])) as unknown as PersonChangedPayload),
  userId: SITE_ADMIN_A.account.userid,
  siteId: SITE_ADMIN_A.siteId,
  deleted: true,
};

const PERSON_EXPECTATION: ConsumerExpectation = {
  required: Object.keys(PERSON_FIELDS),
  types: { userId: 'string', siteId: 'string', deleted: 'boolean' },
  kind: 'state',
};

const SITE_EXPECTATION: ConsumerExpectation = { required: Object.keys(SITE_FIELDS), kind: 'state' };

/** A copy of a topic schema whose payload no longer declares `field`. */
function withoutField(schema: object, field: string): object {
  const copy = structuredClone(schema) as { properties?: Record<string, unknown>; required?: string[] };
  delete copy.properties?.[field];
  copy.required = copy.required?.filter((name) => name !== field);
  return copy;
}

/** The violations an assertion reports, or an empty list when it passes. */
function violationsOf(assertion: () => void): ContractViolation[] {
  try {
    assertion();
    return [];
  } catch (err) {
    if (err instanceof ContractAssertionError) return err.errors;
    throw err;
  }
}

/** The callee contract's operation serving a recorded call; a failure names the contract file and the operation. */
function calledOperation(req: ServiceRequest): Contract & { match: OperationMatch } {
  const contract = CALLEES[req.service];
  if (contract === undefined) throw new Error(`identity calls ${req.service}, whose contract this suite does not load`);
  try {
    return { ...contract, match: findOperation(contract.doc, req.method, req.path) };
  } catch (err) {
    if (err instanceof ContractAssertionError) throw new ContractAssertionError(`${contract.file}: ${err.context}`, err.errors);
    throw err;
  }
}

/** Query parameters a recorded call sent, unset ones dropped. */
function sentQuery(req: ServiceRequest): Record<string, string | string[]> {
  return Object.fromEntries(Object.entries(req.query ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
}

function contentTypeOf(res: ServiceResponse): string | undefined {
  const value = res.headers['content-type'];
  return Array.isArray(value) ? value[0] : value;
}

const exchanges: Exchange[] = [];

/** Keeps every answer `client` gives beside the request it answered. */
function captureExchanges(client: ServiceClient): void {
  const forward = client.request.bind(client);
  client.request = async <T = unknown>(req: ServiceRequest): Promise<ServiceResponse<T>> => {
    const res = await forward<T>(req);
    exchanges.push({ req, res });
    return res;
  };
}

/** The gateway's answer to a mark-used for a session no legacy session is mapped to: service-kit's not-found envelope. */
function unmappedSessionAnswer(): ServiceResponse {
  const { status, headers, body } = legacyErrorResponse('invalidMethodCall', { mura404: true });
  return {
    status,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])),
    body: JSON.parse(body) as unknown,
  };
}

let applied: MarkUsedResult;
let unmapped: MarkUsedResult;
let currentUserStatus: number;

beforeAll(async () => {
  const client = createClientRecorder({
    'strategies-content': {
      [`POST ${FILES_LOOKUP_PATH}`]: () => ({
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8' },
        body: { items: [{ fileId: PHOTO_ID, fileExt: 'jpg' }] },
      }),
    },
  });
  captureExchanges(client);
  const relay = createBridgeRelay(client);
  const used = [{ token: generateCsrfToken({ context: SESSION_ID, secret: SESSION_SECRET, now: TEST_CLOCK.now() }).token, usedAt: TEST_CLOCK.now() }];
  applied = await relay.markUsed(SESSION_ID, used);
  client.on(GATEWAY_SERVICE, 'POST', MARK_USED_TEMPLATE, unmappedSessionAnswer);
  unmapped = await relay.markUsed(SESSION_ID, used);
  await createContentClient(client).photoFileExts([PHOTO_ID, null]);

  const t = await buildTestApp();
  try {
    // findCurrentUser resolves its site through the tenant registry, which the recording database leaves empty.
    t.db.respond(/FROM identity\.tenant_registry\b/, registryAnswer);
    captureExchanges(t.app.opt2.client);
    await t.app.ready();
    const res = await t.app.inject({
      method: 'GET',
      url: CURRENT_USER_URL,
      headers: await headersFor('site-admin', { sub: SITE_ADMIN_A.account.userid }),
    });
    currentUserStatus = res.statusCode;
  } finally {
    await t.app.close();
  }
});

describe('consumed event schemas', () => {
  it('people.person.changed.v1 requires every field the person-contact consumer stores, as state, with the types it relies on', () => {
    expect(violationsOf(() => assertProducerConsumerCompatible(personSchema, { ...PERSON_EXPECTATION, samples: [LIVE_PERSON, DELETED_PERSON] }))).toEqual([]);
  });

  it.each(Object.keys(PERSON_FIELDS))('a person schema without %s fails the person-contact expectation on that field alone', (field) => {
    expect(violationsOf(() => assertProducerConsumerCompatible(withoutField(personSchema, field), PERSON_EXPECTATION))).toEqual([
      { instancePath: `/${field}`, message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });

  // events.test.ts holds the unmutated site check; a single violation per drop also shows every other field still satisfies it.
  it.each(Object.keys(SITE_FIELDS))('a site schema without %s fails the tenant-registry expectation on that field alone', (field) => {
    expect(violationsOf(() => assertProducerConsumerCompatible(withoutField(siteSchema, field), SITE_EXPECTATION))).toEqual([
      { instancePath: `/${field}`, message: 'is not declared by the producer', keyword: 'properties' },
    ]);
  });
});

describe('called operations', () => {
  it('reach exactly the services the identity contract lists in x-opt2-calls', () => {
    const declared = IDENTITY.doc['x-opt2-calls'];

    expect(Array.isArray(declared), `${IDENTITY.file} declares no x-opt2-calls list`).toBe(true);
    expect(new Set(exchanges.map(({ req }) => req.service))).toEqual(new Set(declared as string[]));
    expect(new Set(Object.keys(CALLEES))).toEqual(new Set(declared as string[]));
  });

  it("are each declared by the callee's contract", () => {
    const undeclared = exchanges.flatMap(({ req }) => {
      const violations = violationsOf(() => calledOperation(req));
      return violations.length === 0 ? [] : [`${CALLEES[req.service]?.file ?? req.service}: ${req.method} ${req.path}`];
    });

    expect(undeclared).toEqual([]);
  });

  it('authorise identity over the service transport', () => {
    for (const { req } of exchanges) {
      const { file, match } = calledOperation(req);
      expect(match.operation['x-opt2-transport'], `${file}: ${req.method} ${match.template}`).toBe('service');
      expect(match.operation['x-opt2-requires'], `${file}: ${req.method} ${match.template}`).toContain(SELF_ROLE);
      expect(match.operation, `${file}: ${req.method} ${match.template}`).not.toHaveProperty('x-opt2-public');
    }
  });

  it('receive the path, query and JSON body each operation declares', () => {
    for (const { req } of exchanges) {
      const { doc } = calledOperation(req);
      expect(req.form, `${req.method} ${req.path} form body`).toBeUndefined();
      expect(req.body, `${req.method} ${req.path} raw body`).toBeUndefined();
      assertRequestMatchesOpenApi(doc, {
        method: req.method,
        path: req.path,
        query: sentQuery(req),
        ...(req.json === undefined ? {} : { contentType: 'application/json', body: req.json }),
      });
    }
  });

  it("are answered by this suite's fakes only in shapes the callee contracts declare", () => {
    for (const { req, res } of exchanges) {
      assertResponseMatchesOpenApi(calledOperation(req).doc, { method: req.method, path: req.path, status: res.status, contentType: contentTypeOf(res), body: res.body });
    }
  });
});

describe('gateway legacySessionMarkUsed', () => {
  it('declares the 2xx and the unmapped-session 404 the bridge relay tells apart', () => {
    const { match } = calledOperation({ service: GATEWAY_SERVICE, method: 'POST', path: `/internal/v1/legacy-sessions/${SESSION_ID}:mark-used` });
    const statuses = Object.keys(match.operation.responses ?? {});

    expect(match.template).toBe(MARK_USED_TEMPLATE);
    expect(statuses).toContain('404');
    expect(statuses.filter((status) => status === '200' || status === '204')).not.toEqual([]);
    expect(exchanges.filter(({ req }) => req.service === GATEWAY_SERVICE).map(({ res }) => res.status)).toEqual([204, 404]);
    expect(applied).toEqual({ applied: true });
    expect(unmapped).toEqual({ applied: false });
  });
});

describe('people readCurrentUser', () => {
  it('is what the JSON API findCurrentUser route of identity calls', () => {
    const inbound = findOperation(IDENTITY.doc, 'GET', CURRENT_USER_URL);
    const key = routeKeyForRequest({ method: 'GET', path: CURRENT_USER_URL, query: {}, headers: {} }).key;
    const calls = exchanges.filter(({ req }) => req.service === 'people');

    expect(currentUserStatus).toBe(200);
    expect(key).toBe('api:findcurrentuser');
    expect(inbound.operation['x-opt2-route-keys'], `${IDENTITY.file}: GET ${inbound.template}`).toContain(key);
    expect(calls.map(({ req }) => calledOperation(req).match.operation.operationId)).toEqual(['readCurrentUser']);
  });
});
