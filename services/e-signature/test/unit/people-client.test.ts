// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** People's pool-user read as the fixture's `userManager.read`, over a stubbed service client. */
import { describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest } from '@opt2/platform/service-kit';
import { PEOPLE_SERVICE, PeopleReadDeniedError, createPeopleClient } from '../../src/legacy/people-client.js';
import { SIGNER_USER_ID } from '../helpers/tokens.js';

/** A service client answering every call with `answer`, or rejecting with it, and recording each request. */
function stubClient(answer: { status: number; body: unknown } | Error): { client: ServiceClient; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    async request<T>(req: ServiceRequest) {
      calls.push(req);
      if (answer instanceof Error) throw answer;
      return { status: answer.status, headers: {}, body: answer.body as T };
    },
    async close() {},
  };
  return { client, calls };
}

/** The first rejection of `readPerson`, as the caught value. */
async function readFailure(client: ServiceClient): Promise<unknown> {
  return createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID).then(
    () => expect.unreachable('readPerson resolved'),
    (err: unknown) => err,
  );
}

// A pool user as people's readPoolUser answers it: the stored id, site and type.
const USER = { userid: SIGNER_USER_ID, siteid: 'umbrella', type: 2 };
const denial = (message: string, code: string) => ({ apiversion: 'v1', method: 'invalid', error: { message, code } });

describe('e-signature people client', () => {
  it('names people as its callee', () => {
    expect(PEOPLE_SERVICE).toBe('people');
  });

  it('reads the pool user with the site and id as query values, leaving their encoding to the service client', async () => {
    const { client, calls } = stubClient({ status: 200, body: USER });
    await createPeopleClient({ client }).readPerson('tenant a/b', 'id/with ?');
    expect(calls).toEqual([
      { service: 'people', method: 'GET', path: '/internal/v1/users/pool-user', query: { siteid: 'tenant a/b', userid: 'id/with ?' } },
    ]);
  });

  it.each([
    ['a parsed', USER],
    ['a text', JSON.stringify(USER)],
  ])('maps a found pool user from %s body to its person summary', async (_label, body) => {
    const { client } = stubClient({ status: 200, body });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID)).resolves.toEqual({
      userId: SIGNER_USER_ID,
      siteId: 'umbrella',
      type: 2,
    });
  });

  it('reads a 404 as no person', async () => {
    const { client } = stubClient({ status: 404, body: denial('Invalid method call', 'invalid_request') });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID)).resolves.toBeNull();
  });

  it('answers an empty user id with no person and no call', async () => {
    const { client, calls } = stubClient({ status: 200, body: USER });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', '')).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it.each([
    [401, denial('Insufficient Account Permissions', 'invalid_request'), 'authorization'],
    [401, denial('Invalid Access Token', 'invalid_token'), 'invalidAccessToken'],
    [401, denial('Access Token Expired', 'invalid_token'), 'accessTokenExpired'],
    [403, denial('Insufficient Account Permissions', 'invalid_request'), 'authorization'],
    [403, undefined, 'authorization'],
  ])('throws PeopleReadDeniedError for a %i denial', async (status, body, type) => {
    const err = await readFailure(stubClient({ status, body }).client);
    expect(err).toBeInstanceOf(PeopleReadDeniedError);
    expect(err).not.toBeInstanceOf(LegacyApiError);
    expect(err).toMatchObject({ name: 'PeopleReadDeniedError', status, type });
  });

  it.each([502, 503, 504])('throws the legacy 503 ServiceUnavailableError for HTTP %i', async (status) => {
    const err = await readFailure(stubClient({ status, body: undefined }).client);
    expect(err).toBeInstanceOf(ServiceUnavailableError);
    expect(err).toBeInstanceOf(LegacyServiceUnavailableError);
    expect(err).toMatchObject({ service: 'people', message: `Service people unavailable (HTTP_${String(status)})` });
  });

  it('propagates the service client ServiceUnavailableError unchanged', async () => {
    const unavailable = new ServiceUnavailableError('people', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await expect(readFailure(stubClient(unavailable).client)).resolves.toBe(unavailable);
  });

  it.each([400, 500])('throws a plain error naming any other status (%i)', async (status) => {
    const err = await readFailure(stubClient({ status, body: denial('Unhandled Exception', 'server_error') }).client);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ServiceUnavailableError);
    expect(err).not.toBeInstanceOf(PeopleReadDeniedError);
    expect((err as Error).message).toContain(`HTTP ${String(status)}`);
  });
});
