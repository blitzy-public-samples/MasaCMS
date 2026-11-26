import { describe, expect, it } from 'vitest';
import {
  MIGRATION_PATH_PREFIX,
  UNPUBLISHED_EVENTS_HEADER,
  WRITE_POSITION_HEADER,
  postApply,
  type ApplyRequest,
  type ApplyResponse,
} from '../../src/migration-kit/index.js';
import { ServiceUnavailableError, type ServiceClient, type ServiceRequest, type ServiceResponse } from '../../src/service-kit/index.js';

const BATCH: ApplyRequest = {
  batchId: 'batch-1',
  origin: 'backfill',
  legacyTable: 'tusers',
  tenantId: '7b0c1e7a-3a55-5b7e-9d8b-0c6f3f1a2b3c',
  columns: [{ name: 'UserID', type: 's' }],
  rows: [{ op: 'upsert', row: '["user-1"]' }],
};
const APPLIED: ApplyResponse = { batchId: 'batch-1', duplicate: false, applied: 1, skipped: 0 };
const DUPLICATE: ApplyResponse = { batchId: 'batch-1', duplicate: true, applied: 0, skipped: 0 };
const LEGACY_503 = { apiversion: 'v1', method: 'invalid', error: { code: 'server_error', message: 'Unhandled Exception' } };
const EXPECTED_CALL: ServiceRequest = { service: 'people', method: 'POST', path: `${MIGRATION_PATH_PREFIX}/apply`, json: BATCH, userToken: null };

type Answer = ServiceResponse | Error;

/** A client answering its calls from `answers` in order, recording each call. */
function scriptedClient(...answers: Answer[]): { client: Pick<ServiceClient, 'request'>; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      const answer = answers.shift();
      if (answer === undefined) return Promise.reject(new Error('unexpected call'));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer as ServiceResponse<T>);
    },
  };
  return { client, calls };
}

/** The owner's 503 for a batch it committed with `count` events left to the sweep. */
function pending(headers: ServiceResponse['headers'] = {}, count = '3'): ServiceResponse {
  return { status: 503, headers: { 'content-type': 'application/json;charset=utf-8', 'x-opt2-unpublished-events': count, ...headers }, body: LEGACY_503 };
}

const refused = (): ServiceUnavailableError =>
  new ServiceUnavailableError('people', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));

describe('postApply', () => {
  it.each<[string, ServiceResponse['headers'], ServiceResponse['headers'], string[]]>([
    ["keeps the first answer's write position when the re-send carries none", { 'x-opt2-write-position': 'people=120' }, {}, ['people=120']],
    [
      "puts the first answer's write positions before the re-send's",
      { [WRITE_POSITION_HEADER]: ['people=120', 'identity=7'] },
      { 'x-opt2-write-position': 'people=121' },
      ['people=120', 'identity=7', 'people=121'],
    ],
  ])('re-sends the same batch once after a pending-publication 503 and %s', async (_label, firstHeaders, resentHeaders, positions) => {
    const { client, calls } = scriptedClient(pending(firstHeaders), { status: 200, headers: { 'content-type': 'application/json', ...resentHeaders }, body: DUPLICATE });

    const response = await postApply(client, 'people', BATCH);

    expect(response).toStrictEqual({ status: 200, headers: { 'content-type': 'application/json', 'x-opt2-write-position': positions }, body: DUPLICATE });
    expect(calls).toStrictEqual([EXPECTED_CALL, EXPECTED_CALL]);
    expect(calls[0]?.json).toBe(calls[1]?.json);
  });

  it('returns the re-send unchanged when the first answer carried no write position', async () => {
    const resent: ServiceResponse = { status: 200, headers: { 'x-opt2-write-position': 'people=121' }, body: DUPLICATE };
    const { client, calls } = scriptedClient(pending(), resent);

    await expect(postApply(client, 'people', BATCH)).resolves.toBe(resent);
    expect(calls).toHaveLength(2);
  });

  it.each<[string, ServiceResponse]>([
    ['a 200', { status: 200, headers: { 'x-opt2-write-position': 'people=120' }, body: APPLIED }],
    ['a plain 503', { status: 503, headers: {}, body: LEGACY_503 }],
    ['a 500 naming unpublished events', { status: 500, headers: { [UNPUBLISHED_EVENTS_HEADER]: '3' }, body: LEGACY_503 }],
    ['a 409', { status: 409, headers: {}, body: { error: 'gate-conflict', units: ['people.person'] } }],
  ])('returns %s unchanged after one call', async (_label, answer) => {
    const { client, calls } = scriptedClient(answer);

    await expect(postApply(client, 'people', BATCH)).resolves.toBe(answer);
    expect(calls).toStrictEqual([EXPECTED_CALL]);
  });

  it('returns a second pending-publication 503 unchanged without a third call', async () => {
    const second = pending({ 'x-opt2-write-position': 'people=121' }, '1');
    const { client, calls } = scriptedClient(pending({ 'x-opt2-write-position': 'people=120' }), second);

    await expect(postApply(client, 'people', BATCH)).resolves.toBe(second);
    expect(calls).toHaveLength(2);
  });

  it.each<[string, () => Answer[], number]>([
    ['the call', () => [refused()], 1],
    ['the re-send', () => [pending(), refused()], 2],
  ])('rethrows a transport failure of %s unchanged', async (_label, answers, callCount) => {
    const scripted = answers();
    const failure = scripted.at(-1);
    const { client, calls } = scriptedClient(...scripted);

    await expect(postApply(client, 'people', BATCH)).rejects.toBe(failure);
    expect(calls).toHaveLength(callCount);
  });
});
