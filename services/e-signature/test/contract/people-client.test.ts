// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of e-signature on people: the user read the people client sends, and its reading of each answer, against people's contract. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  LEGACY_JSON_CONTENT_TYPE,
  LegacyServiceUnavailableError,
  apiUnavailableResponse,
  buildEnvelope,
  legacyErrorResponse,
  routeKeyForRequest,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  decodeServiceBody,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import {
  ContractAssertionError,
  assertRequestMatchesOpenApi,
  assertResponseMatchesOpenApi,
  findOperation,
  type ContractViolation,
  type OperationMatch,
  type ResponseUnderTest,
} from '@opt2/platform/testing';
import { PEOPLE_SERVICE, PeopleReadDeniedError, createPeopleClient, type PersonSummary } from '../../src/legacy/people-client.js';
import { OTHER_USER_ID, SIGNER_USER_ID } from '../helpers/tokens.js';

const peopleDoc = load(readFileSync(new URL('../../../people/contracts/openapi.yaml', import.meta.url), 'utf8')) as object;

const SITE_ID = 'tenant-a';
const READ_PATH = `/_api/json/v1/tenant-a/user/${SIGNER_USER_ID}`;
const LINKS_BASE = 'http://tenant-a.example.test/index.cfm/_api/json/v1/tenant-a';
// createUUID() of the new bean findOne returns for an unknown user (userBean.cfc:266-270).
const GENERATED_USER_ID = '5E1F0A2B-7C3D-4E5F-8091A2B3C4D5E6F7';

type Recorded = ServiceResponse | Error;

/** A service client answering each call with the next recorded entry, or throwing it, and keeping every request. */
function stubClient(responses: readonly Recorded[]): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const pending = [...responses];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      const next = pending.shift();
      if (next === undefined) return Promise.reject(new Error(`unrecorded call ${String(calls.length)} to ${req.service}`));
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve({ ...next, body: next.body as T });
    },
    close: () => Promise.resolve(),
  };
  return { client, calls };
}

/** A wire answer as service-kit hands it over: lower-cased header names, body decoded by its content type. */
function recorded(status: number, headers: Record<string, string>, wire: string): ServiceResponse {
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  return { status, headers: lowered, body: decodeServiceBody(Buffer.from(wire, 'utf8'), lowered['content-type'], PEOPLE_SERVICE) };
}

/** A serialized legacy JSON API response as recorded, at `status` when people answers it at another status. */
function fromLegacy(response: SerializedLegacyResponse, status = response.status): ServiceResponse {
  return recorded(status, response.headers, response.body);
}

/** A 200 `findOne` envelope of `data`, with params suppressed as the JSON API does by default. */
function foundEnvelope(data: Record<string, unknown>): ServiceResponse {
  const wire = JSON.stringify(buildEnvelope({ method: 'findOne', data }));
  return recorded(200, { 'Content-Type': LEGACY_JSON_CONTENT_TYPE }, wire);
}

/** Links findOne builds for a user (jsonApiUtility.cfc:3374-3420). */
function userLinks(userId: string): Record<string, string> {
  return {
    entities: LINKS_BASE,
    all: `${LINKS_BASE}/user`,
    properties: `${LINKS_BASE}/user/properties`,
    self: `${LINKS_BASE}/user/${userId}`,
  };
}

/** A stored user as people's findOne serializes it: lower-cased keys, `type` as text, numbers and `isnew` as integers. */
const USER_DATA = {
  id: SIGNER_USER_ID,
  userid: SIGNER_USER_ID,
  siteid: SITE_ID,
  remoteid: '',
  groupname: '',
  fname: 'Ada',
  lname: 'Signer',
  username: 'asigner',
  email: 'ada.signer@example.test',
  company: 'Program 1',
  jobtitle: 'Coordinator',
  mobilephone: '',
  website: '',
  type: 'user',
  subtype: 'Default',
  s2: 0,
  lastlogin: '2026-06-29T08:30:00',
  lastupdate: '2026-06-01T10:00:00',
  lastupdateby: 'Admin User',
  created: '2026-01-15T09:00:00',
  perm: 0,
  inactive: 0,
  ispublic: 0,
  subscribe: 1,
  keepprivate: 0,
  photofileid: '',
  tags: '',
  primaryaddressid: '',
  isnew: 0,
  entityname: 'user',
  links: userLinks(SIGNER_USER_ID),
};

/** The new bean findOne answers for an unknown user: userBean defaults, a generated id and `isnew` 1 (userDAO.cfc:111-117). */
const NEW_BEAN_DATA = {
  ...USER_DATA,
  id: GENERATED_USER_ID,
  userid: GENERATED_USER_ID,
  fname: '',
  lname: '',
  username: '',
  email: '',
  company: '',
  jobtitle: '',
  lastlogin: '',
  lastupdateby: '',
  ispublic: 1,
  isnew: 1,
  links: userLinks(GENERATED_USER_ID),
};

/** The person summary people-client builds from a stored user's data; `type` text `user` decodes to 2 (userBean.cfc:753-765). */
function personOf(data: typeof USER_DATA, inactive: number): PersonSummary {
  return { userId: data.userid, siteId: data.siteid, type: 2, fname: data.fname, lname: data.lname, email: data.email, inactive };
}

const RECORDED = {
  found: foundEnvelope(USER_DATA),
  foundNullInactive: foundEnvelope({ ...USER_DATA, inactive: '' }),
  isNew: foundEnvelope(NEW_BEAN_DATA),
  notFound: fromLegacy(legacyErrorResponse('invalidMethodCall', { method: 'findOne', mura404: true })),
  unauthorized: fromLegacy(legacyErrorResponse('authorization', { method: 'findOne' })),
  invalidToken: fromLegacy(
    legacyErrorResponse('invalidAccessToken', { method: 'findOne', wwwAuthenticate: 'Bearer error="invalid_access_token"' }),
  ),
  forbidden: fromLegacy(legacyErrorResponse('authorization'), 403),
  unavailable: fromLegacy(apiUnavailableResponse({ method: 'findOne' })),
  badGateway: recorded(
    502,
    { 'Content-Type': 'text/html; charset=UTF-8' },
    '<html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>',
  ),
  gatewayTimeout: recorded(504, { 'Content-Type': 'text/plain' }, 'upstream request timeout'),
} satisfies Record<string, ServiceResponse>;

/** The findings people's contract reports for `response`; none when it conforms. */
function contractFindings(response: ResponseUnderTest): ContractViolation[] {
  try {
    assertResponseMatchesOpenApi(peopleDoc, response);
    return [];
  } catch (err) {
    if (err instanceof ContractAssertionError) return err.errors;
    throw err;
  }
}

/** The request's query parameters in the form the contract matcher reads. */
function sentQuery(call: ServiceRequest): Record<string, string | string[]> {
  const entries = Object.entries(call.query ?? {}).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined);
  return Object.fromEntries(entries);
}

/** The single request a found read sends, with the operation people's contract resolves it to. */
async function sentRead(): Promise<{ call: ServiceRequest; operation: OperationMatch }> {
  const { client, calls } = stubClient([RECORDED.found]);
  await createPeopleClient({ client }).readPerson(SITE_ID, SIGNER_USER_ID);
  expect(calls).toHaveLength(1);
  const [call] = calls as [ServiceRequest];
  return { call, operation: findOperation(peopleDoc, call.method, call.path) };
}

describe('e-signature people client request against the people contract', () => {
  it('sends one GET of the user item to people, with no query, body, headers or token override', async () => {
    expect(PEOPLE_SERVICE).toBe('people');
    const { call } = await sentRead();
    expect(call).toEqual({ service: PEOPLE_SERVICE, method: 'GET', path: READ_PATH });
    expect(call.userToken).toBeUndefined();
    const headerNames = Object.keys(call.headers ?? {}).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('x-serverless-authorization');
  });

  it("resolves to people's jsonItemGet on the JSON API item template", async () => {
    const { operation } = await sentRead();
    // People declares the read on its per-segment item template, not on a catch-all `{path}` template.
    expect(operation.template).toBe('/_api/json/v1/{siteid}/{segment}/{item}');
    expect(operation.operation.operationId).toBe('jsonItemGet');
  });

  it('sends only path, query and header parameters the operation declares', async () => {
    const { call } = await sentRead();
    expect(() =>
      assertRequestMatchesOpenApi(peopleDoc, {
        method: call.method,
        path: call.path,
        query: sentQuery(call),
        headers: call.headers ?? {},
      }),
    ).not.toThrow();
  });

  it('targets a service-transport operation a forwarded user token reaches, keyed as the user findOne', async () => {
    const { call, operation } = await sentRead();
    const declared = operation.operation;
    expect(declared['x-opt2-transport']).toBe('service');
    expect(declared['x-opt2-public'] === true || Array.isArray(declared['x-opt2-requires'])).toBe(true);
    expect(declared.security).toContainEqual({ userToken: [], invocationCredential: [] });
    const { key } = routeKeyForRequest({ method: call.method, path: call.path, query: sentQuery(call), headers: call.headers ?? {} });
    expect(key).toBe('api:user.findone');
    expect(declared['x-opt2-route-keys']).toContain(key);
  });
});

type Outcome =
  | { kind: 'person'; value: PersonSummary | null }
  | { kind: 'denied'; status: 401 | 403; type: string }
  | { kind: 'unavailable' };

interface ResponseCase {
  name: string;
  userId: string;
  response: ServiceResponse;
  /** `transport` answers come from the network path, not from people, so its contract need not declare them. */
  origin: 'people' | 'transport';
  expected: Outcome;
}

const RESPONSE_CASES: readonly ResponseCase[] = [
  {
    name: 'found user reads as its person summary',
    userId: SIGNER_USER_ID,
    response: RECORDED.found,
    origin: 'people',
    expected: { kind: 'person', value: personOf(USER_DATA, 0) },
  },
  {
    name: "found user with a NULL inactive column reads as active, userBean's default",
    userId: SIGNER_USER_ID,
    response: RECORDED.foundNullInactive,
    origin: 'people',
    expected: { kind: 'person', value: personOf(USER_DATA, 0) },
  },
  {
    name: 'new bean (isnew 1) for an unknown user reads as no person',
    userId: OTHER_USER_ID,
    response: RECORDED.isNew,
    origin: 'people',
    expected: { kind: 'person', value: null },
  },
  {
    name: 'legacy 404 envelope reads as no person',
    userId: SIGNER_USER_ID,
    response: RECORDED.notFound,
    origin: 'people',
    expected: { kind: 'person', value: null },
  },
  {
    name: '401 authorization denial rejects with PeopleReadDeniedError',
    userId: SIGNER_USER_ID,
    response: RECORDED.unauthorized,
    origin: 'people',
    expected: { kind: 'denied', status: 401, type: 'authorization' },
  },
  {
    name: '401 invalid access token rejects with PeopleReadDeniedError',
    userId: SIGNER_USER_ID,
    response: RECORDED.invalidToken,
    origin: 'people',
    expected: { kind: 'denied', status: 401, type: 'invalidAccessToken' },
  },
  {
    name: '403 site mismatch rejects with PeopleReadDeniedError',
    userId: SIGNER_USER_ID,
    response: RECORDED.forbidden,
    origin: 'people',
    expected: { kind: 'denied', status: 403, type: 'authorization' },
  },
  {
    name: 'legacy 503 rejects with the service-unavailable error',
    userId: SIGNER_USER_ID,
    response: RECORDED.unavailable,
    origin: 'people',
    expected: { kind: 'unavailable' },
  },
  {
    name: 'transport 502 rejects with the service-unavailable error',
    userId: SIGNER_USER_ID,
    response: RECORDED.badGateway,
    origin: 'transport',
    expected: { kind: 'unavailable' },
  },
  {
    name: 'transport 504 rejects with the service-unavailable error',
    userId: SIGNER_USER_ID,
    response: RECORDED.gatewayTimeout,
    origin: 'transport',
    expected: { kind: 'unavailable' },
  },
];

/** What `readPerson` settled to: its value, or the rejection. */
async function settle(read: Promise<PersonSummary | null>): Promise<{ value: PersonSummary | null } | { error: unknown }> {
  return read.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

describe("e-signature people client reading people's answers", () => {
  it.each(RESPONSE_CASES)('$name', async ({ userId, response, origin, expected }) => {
    const findings = contractFindings({
      method: 'GET',
      path: `/_api/json/v1/${SITE_ID}/user/${userId}`,
      status: response.status,
      contentType: response.headers['content-type'],
      body: response.body,
    });
    expect(origin === 'people' ? findings : findings.filter((finding) => finding.keyword !== 'status')).toEqual([]);

    const { client, calls } = stubClient([response]);
    const settled = await settle(createPeopleClient({ client }).readPerson(SITE_ID, userId));
    expect(calls).toHaveLength(1);

    switch (expected.kind) {
      case 'person':
        expect(settled).toEqual({ value: expected.value });
        break;
      case 'denied': {
        expect(settled).toHaveProperty('error');
        const { error } = settled as { error: unknown };
        expect(error).toBeInstanceOf(PeopleReadDeniedError);
        expect(error).toMatchObject({ status: expected.status, type: expected.type });
        break;
      }
      case 'unavailable': {
        expect(settled).toHaveProperty('error');
        const { error } = settled as { error: unknown };
        expect(error).toBeInstanceOf(ServiceUnavailableError);
        expect(error).toBeInstanceOf(LegacyServiceUnavailableError);
        expect(error).toMatchObject({ service: PEOPLE_SERVICE });
        break;
      }
    }
  });

  it.each([
    {
      name: 'connection refused',
      thrown: new ServiceUnavailableError(
        PEOPLE_SERVICE,
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8112'), { code: 'ECONNREFUSED' }),
      ),
    },
    {
      name: 'call timeout',
      thrown: new ServiceUnavailableError(PEOPLE_SERVICE, new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
    },
  ])('$name from the service client rejects with the same error after one call', async ({ thrown }) => {
    const { client, calls } = stubClient([thrown, RECORDED.found]);
    await expect(createPeopleClient({ client }).readPerson(SITE_ID, SIGNER_USER_ID)).rejects.toBe(thrown);
    expect(calls).toHaveLength(1);
  });
});
