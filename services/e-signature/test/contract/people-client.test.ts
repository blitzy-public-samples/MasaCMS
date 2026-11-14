// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer contract of e-signature on people: the pool-user read the people client sends, and its reading of each answer, against people's contract. */
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { AuthDenial, renderAuthDenial, serviceRole } from '@opt2/platform/auth';
import {
  LegacyServiceUnavailableError,
  apiUnavailableResponse,
  legacyErrorResponse,
  type SerializedLegacyResponse,
} from '@opt2/platform/legacy-compat';
import {
  ServiceUnavailableError,
  decodeServiceBody,
  type FastifyRequest,
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
const ownDoc = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as { 'x-opt2-calls'?: unknown };

const SITE_ID = 'tenant-a';
const READ_PATH = '/internal/v1/users/pool-user';

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

/** The query people's handlers and denials read back from the read e-signature sends. */
const READ_QUERY = { siteid: SITE_ID, userid: SIGNER_USER_ID };

/** People's answer to the read when the auth hooks or its handler refuse it with `denial`. */
function denied(denial: AuthDenial): ServiceResponse {
  return fromLegacy(renderAuthDenial(denial, { query: READ_QUERY } as unknown as FastifyRequest));
}

/** A stored pool user as people's readPoolUser answers it. */
const POOL_USER = { userid: SIGNER_USER_ID, siteid: SITE_ID, type: 2 };

/** The person summary people-client builds from `POOL_USER`. */
const SIGNER_PERSON: PersonSummary = { userId: SIGNER_USER_ID, siteId: SITE_ID, type: 2 };

const RECORDED = {
  found: recorded(200, { 'Content-Type': 'application/json' }, JSON.stringify(POOL_USER)),
  // service-kit's not-found handler, which the read calls for an id no pool person holds.
  notFound: fromLegacy(legacyErrorResponse('invalidMethodCall', { params: { ...READ_QUERY, userid: OTHER_USER_ID }, mura404: true })),
  unauthorized: denied(AuthDenial.unauthenticated('missing-credential')),
  invalidToken: denied(AuthDenial.invalidToken()),
  siteMismatch: denied(AuthDenial.siteMismatch()),
  forbidden: denied(AuthDenial.forbidden()),
  unavailable: fromLegacy(apiUnavailableResponse()),
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
  it('sends one GET of the pool user to people, with the site and id as its query and no body, headers or token override', async () => {
    expect(PEOPLE_SERVICE).toBe('people');
    const { call } = await sentRead();
    expect(call).toEqual({ service: PEOPLE_SERVICE, method: 'GET', path: READ_PATH, query: READ_QUERY });
    expect(call.userToken).toBeUndefined();
    const headerNames = Object.keys(call.headers ?? {}).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain('authorization');
    expect(headerNames).not.toContain('x-serverless-authorization');
  });

  it("resolves to people's readPoolUser", async () => {
    const { operation } = await sentRead();
    expect(operation.template).toBe(READ_PATH);
    expect(operation.operation.operationId).toBe('readPoolUser');
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

  it("targets a service-transport operation that admits e-signature's workload with the forwarded user token, on a declared call edge", async () => {
    const { operation } = await sentRead();
    const declared = operation.operation;
    expect(declared['x-opt2-transport']).toBe('service');
    expect(declared['x-opt2-requires']).toEqual([serviceRole('e-signature')]);
    expect(declared.security).toEqual([{ userToken: [], invocationCredential: [] }]);
    expect(ownDoc['x-opt2-calls']).toContain(PEOPLE_SERVICE);
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
    name: 'found pool user reads as its person summary',
    userId: SIGNER_USER_ID,
    response: RECORDED.found,
    origin: 'people',
    expected: { kind: 'person', value: SIGNER_PERSON },
  },
  {
    name: 'legacy 404 envelope for an id no pool person holds reads as no person',
    userId: OTHER_USER_ID,
    response: RECORDED.notFound,
    origin: 'people',
    expected: { kind: 'person', value: null },
  },
  {
    name: '401 for a missing user token rejects with PeopleReadDeniedError',
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
    response: RECORDED.siteMismatch,
    origin: 'people',
    expected: { kind: 'denied', status: 403, type: 'authorization' },
  },
  {
    name: '403 for a workload without service:e-signature rejects with PeopleReadDeniedError',
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
      path: READ_PATH,
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
