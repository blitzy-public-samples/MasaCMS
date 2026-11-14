// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** People's JSON API `user` read as the fixture's `userManager.read`, over a stubbed service client. */
import { describe, expect, it } from 'vitest';
import { LegacyApiError, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest } from '@opt2/platform/service-kit';
import { PEOPLE_READ_GAPS, PEOPLE_SERVICE, PeopleReadDeniedError, createPeopleClient } from '../../src/legacy/people-client.js';
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

// A user findOne as people serializes it (jsonApiUtility.cfc:2349-2383): lower-cased keys, `type` as text, `isnew` 0.
const USER = {
  id: SIGNER_USER_ID,
  userid: SIGNER_USER_ID,
  siteid: 'umbrella',
  fname: 'Ada',
  lname: 'Signer',
  email: 'ada@example.test',
  type: 'user',
  inactive: 0,
  isnew: 0,
  entityname: 'user',
};
const envelope = (data: Record<string, unknown>) => ({ apiversion: 'v1', method: 'findOne', data });
const denial = (message: string, code: string) => ({ apiversion: 'v1', method: 'findOne', error: { message, code } });

describe('e-signature people client', () => {
  it('names people as its callee and records the read gaps', () => {
    expect(PEOPLE_SERVICE).toBe('people');
    expect(PEOPLE_READ_GAPS.map((gap) => gap.id)).toEqual(['cross-permission', 'cross-site']);
    expect(Object.isFrozen(PEOPLE_READ_GAPS)).toBe(true);
  });

  it('reads the user through the JSON API with encoded path segments and nothing else', async () => {
    const { client, calls } = stubClient({ status: 200, body: envelope(USER) });
    await createPeopleClient({ client }).readPerson('tenant a/b', 'id/with ?');
    expect(calls).toEqual([{ service: 'people', method: 'GET', path: '/_api/json/v1/tenant%20a%2Fb/user/id%2Fwith%20%3F' }]);
  });

  it('maps a found user to its person summary', async () => {
    const { client } = stubClient({ status: 200, body: envelope(USER) });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID)).resolves.toEqual({
      userId: SIGNER_USER_ID,
      siteId: 'umbrella',
      type: 2,
      fname: 'Ada',
      lname: 'Signer',
      email: 'ada@example.test',
      inactive: 0,
    });
  });

  it.each([
    ['user', 0, 2, 0],
    ['group', 1, 1, 1],
    ['Group', 0, 1, 0],
    [2, '', 2, 0],
    ['1', 0, 1, 0],
  ])('decodes type %j and inactive %j as userBean does, from a text body', async (type, inactive, expectedType, expectedInactive) => {
    const { client } = stubClient({ status: 200, body: JSON.stringify(envelope({ ...USER, type, inactive })) });
    const person = await createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID);
    expect(person).toMatchObject({ type: expectedType, inactive: expectedInactive });
  });

  it.each([1, '1', true])('reads a new bean (isnew %j) as no person', async (isnew) => {
    const { client } = stubClient({ status: 200, body: envelope({ ...USER, isnew }) });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID)).resolves.toBeNull();
  });

  it('reads a 404 as no person', async () => {
    const { client } = stubClient({ status: 404, body: denial('Invalid method call', 'invalid_request') });
    await expect(createPeopleClient({ client }).readPerson('tenant-a', SIGNER_USER_ID)).resolves.toBeNull();
  });

  it('answers an empty user id with no person and no call', async () => {
    const { client, calls } = stubClient({ status: 200, body: envelope(USER) });
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
