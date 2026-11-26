// Unit tests of `requestTransition`: when it stops reading the transition it started.
import type { ServiceClient, ServiceRequest, ServiceResponse } from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';

import type { MigrationContext, ServiceCaller } from '../../src/context.js';
import { requestTransition, type Transition } from '../../src/transition/request.js';

const ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const POLL_MS = 25;
const RUNNING: Transition = {
  transitionId: ID,
  fromVersion: 'v0001',
  toVersion: 'v0002',
  state: 'running',
  step: 5,
  units: ['people.person'],
  frozenRoutes: [],
  startedAt: '2026-03-01T10:00:00.000Z',
};
const ABORTING = { step: 5, message: 'gates held by another holder', state: 'aborting' };
const ABORTED: Transition = { ...RUNNING, state: 'aborted', error: { ...ABORTING, state: 'aborted' } };
const UNDO_FAILURES = { count: 2, firstAt: '2026-03-01T10:00:05.000Z' };

/** A context whose operator client answers the n-th call with `answers[n]` and fails any further call, recording each request. */
function answering(answers: Transition[]): { ctx: Pick<MigrationContext, 'clientAs'>; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      const body = answers[calls.length - 1];
      if (body === undefined) return Promise.reject(new Error(`unexpected call ${String(calls.length)}`));
      return Promise.resolve({ status: calls.length === 1 ? 202 : 200, headers: {}, body } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  const clientAs = (caller: ServiceCaller): ServiceClient => {
    if (caller !== 'operator') throw new Error(`clientAs(${caller}) was called`);
    return client;
  };
  return { ctx: { clientAs }, calls };
}

describe('requestTransition', () => {
  it.each<{ ends: string; answers: Transition[] }>([
    { ends: 'once it completes', answers: [RUNNING, RUNNING, { ...RUNNING, state: 'completed', step: 8 }] },
    { ends: 'once it aborts', answers: [RUNNING, ABORTED] },
    { ends: 'once an undo failing within its budget ends aborted', answers: [RUNNING, { ...RUNNING, error: { ...ABORTING, undoFailures: UNDO_FAILURES } }, ABORTED] },
    {
      ends: 'as soon as the undo is escalated, with the transition still running',
      answers: [RUNNING, { ...RUNNING, error: { ...ABORTING, undoFailures: { ...UNDO_FAILURES, escalatedAt: '2026-03-01T10:05:06.000Z' } } }],
    },
  ])('stops polling $ends', async ({ answers }) => {
    const { ctx, calls } = answering(answers);
    const sleeps: number[] = [];
    const sleep = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const transition = await requestTransition(ctx, { to: 'v0002', pollMs: POLL_MS, sleep });

    expect(transition).toEqual(answers.at(-1));
    const reads = answers.length - 1;
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /internal/v1/transitions',
      ...Array<string>(reads).fill(`GET /internal/v1/transitions/${ID}`),
    ]);
    expect(calls[0]?.json).toEqual({ toVersion: 'v0002' });
    expect(sleeps).toEqual(Array<number>(reads).fill(POLL_MS));
  });
});
