// Programmable stand-in for migration's write-window and projection-await operations in gateway tests.
import type { ServerResponse } from 'node:http';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import { isApplied } from '@opt2/platform/migration-kit';
import { PROJECTION_AWAIT_TIMEOUT_MS } from '../../src/dispatcher/barrier.js';
import type { WindowCompleteInput, WindowCompleteResult, WindowOpenInput } from '../../src/dispatcher/write-window.js';
import type { components, paths } from '../../src/generated/clients/migration.js';
import { sendBytes, sendJson, startHttpDouble, type HttpDouble, type RecordedRequest } from './http-double.js';

type Schemas = components['schemas'];
type ProjectionAwaitBody = Schemas['ProjectionAwaitRequest'];
type ProjectionAwaitAnswer = Schemas['ProjectionAwaitResponse'];
type AppliedPositions = ProjectionAwaitAnswer['positions'];
type CompleteState = WindowCompleteResult['state'];

const OPEN_PATH = '/internal/v1/windows' satisfies keyof paths;
const COMPLETE_PATH = '/internal/v1/windows/{windowId}:complete' satisfies keyof paths;
const AWAIT_PATH = '/internal/v1/projection/await' satisfies keyof paths;
const COMPLETE_PATTERN = new RegExp(`^${COMPLETE_PATH.replace('{windowId}', '([^/]+)')}$`);

// Captured at load so delays run on real time even while a suite fakes the global timers; timestamps instead read
// the global `performance` at call time, so they share the suite's clock.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Answer to `windowOpen`: a window, an error status, a delayed window, a destroyed socket or no answer at all. */
export type OpenBehaviour = 'ok' | { status: number } | { delayMs: number } | 'refuse' | 'hang';

/** State `windowComplete` answers for a known window, fixed or computed from it. */
export type CompleteBehaviour = CompleteState | ((window: RecordedWindow) => CompleteState);

/** Answer to `projectionAwait` while no horizon is recorded. */
export type AwaitBehaviour = 'immediate' | { delayMs: number } | 'never';

/** Initial behaviours of {@link startMigrationDouble}. */
export interface MigrationDoubleOptions {
  /** Defaults to `'ok'`. */
  open?: OpenBehaviour;
  /** Defaults to `'closed'`. */
  complete?: CompleteBehaviour;
  /** Defaults to `'immediate'`. */
  await?: AwaitBehaviour;
  /** Caps the wait before an unapplied await's timeout answer; defaults to the request's `timeoutMs`. */
  neverAnswerAfterMs?: number;
}

/** A window the double opened, with the open body exactly as the gateway sent it. */
export interface RecordedWindow extends WindowOpenInput {
  windowId: string;
  /** `performance.now()` when the double answered the open. */
  openedAt: number;
  /** Last `windowComplete` body received for the window. */
  completion?: WindowCompleteInput;
  /** `performance.now()` when that completion arrived. */
  completedAt?: number;
}

/** One `projectionAwait` call. */
export interface RecordedAwait {
  body: ProjectionAwaitBody;
  /** `performance.now()` when the call arrived. */
  receivedAt: number;
}

/** The migration double: base HTTP double plus window and await state and controls. */
export interface MigrationDouble extends HttpDouble {
  /** Windows the double opened, in open order; failed, refused and hung opens appear only in `requests`. */
  windows: RecordedWindow[];
  awaits: RecordedAwait[];
  setOpen(behaviour: OpenBehaviour): void;
  setComplete(behaviour: CompleteBehaviour): void;
  setAwait(behaviour: AwaitBehaviour): void;
  /** Sets `owner`'s projector horizon (xids below it are applied); later awaits then wait on horizons alone. */
  applied(owner: string, xid: string | bigint): void;
}

interface PendingAwait {
  body: ProjectionAwaitBody;
  res: ServerResponse;
  cancel: () => void;
}

function answerable(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

function parseJson<T>(req: RecordedRequest): T {
  return JSON.parse(req.body.toString('utf8')) as T;
}

/** Ends `res` with the legacy-shaped `server_error` envelope under `status`. */
function sendUnavailable(res: ServerResponse, status = 503): void {
  const { headers, body } = apiUnavailableResponse();
  sendBytes(res, status, body, headers);
}

function sendApplied(res: ServerResponse, positions: AppliedPositions): void {
  if (answerable(res)) sendJson(res, 200, { applied: true, positions } satisfies ProjectionAwaitAnswer);
}

/** Starts the migration double on an ephemeral loopback port. */
export async function startMigrationDouble(opts: MigrationDoubleOptions = {}): Promise<MigrationDouble> {
  let openBehaviour: OpenBehaviour = opts.open ?? 'ok';
  let completeBehaviour: CompleteBehaviour = opts.complete ?? 'closed';
  let awaitBehaviour: AwaitBehaviour = opts.await ?? 'immediate';
  let sequence = 0;
  const windows: RecordedWindow[] = [];
  const awaits: RecordedAwait[] = [];
  const horizons = new Map<string, string>();
  const pending = new Set<PendingAwait>();
  const timers = new Set<() => void>();

  /** Runs `fn` after `ms` on a real unref'd timer unless `res` closes or the double closes first; returns its cancel. */
  function later(res: ServerResponse, ms: number, fn: () => void): () => void {
    const cancel = (): void => {
      realClearTimeout(timer);
      timers.delete(cancel);
    };
    const timer = realSetTimeout(() => {
      cancel();
      if (answerable(res)) fn();
    }, ms);
    timer.unref();
    timers.add(cancel);
    res.once('close', cancel);
    return cancel;
  }

  function openWindow(input: WindowOpenInput, res: ServerResponse): void {
    if (!answerable(res)) return;
    sequence += 1;
    // Readable ids rather than contract CfIds: the gateway treats window ids as opaque strings.
    const windowId = `win-${String(sequence).padStart(4, '0')}`;
    windows.push({ ...input, windowId, openedAt: performance.now() });
    sendJson(res, 201, { windowId, state: 'open', phase: 'executing' } satisfies Schemas['WindowOpenResponse']);
  }

  function open(input: WindowOpenInput, res: ServerResponse): void {
    const behaviour = openBehaviour;
    if (behaviour === 'ok') openWindow(input, res);
    else if (behaviour === 'refuse') res.destroy();
    else if (behaviour === 'hang') return;
    else if ('status' in behaviour) sendUnavailable(res, behaviour.status);
    else later(res, behaviour.delayMs, () => openWindow(input, res));
  }

  function complete(windowId: string, input: WindowCompleteInput, res: ServerResponse): void {
    const window = windows.find((candidate) => candidate.windowId === windowId);
    if (window === undefined) {
      sendJson(res, 200, { state: 'unknown' } satisfies WindowCompleteResult);
      return;
    }
    window.completion = input;
    window.completedAt = performance.now();
    const state = typeof completeBehaviour === 'function' ? completeBehaviour(window) : completeBehaviour;
    sendJson(res, 200, { state } satisfies WindowCompleteResult);
  }

  /** Positions the await reports when answered by behaviour; an owners request reports each owner at xid 0. */
  function behaviourPositions(body: ProjectionAwaitBody): AppliedPositions {
    return 'positions' in body ? body.positions : Object.fromEntries(body.owners.map((owner) => [owner, '0']));
  }

  /** Applied positions under the horizons, or undefined while any is not applied; an owner reports its horizon minus one. */
  function horizonPositions(body: ProjectionAwaitBody): AppliedPositions | undefined {
    const awaited: Array<[string, string]> =
      'positions' in body ? Object.entries(body.positions) : body.owners.map((owner) => [owner, '0']);
    const positions: AppliedPositions = {};
    for (const [owner, xid] of awaited) {
      const horizon = horizons.get(owner);
      if (horizon === undefined || !isApplied(xid, horizon)) return undefined;
      positions[owner] = 'positions' in body ? xid : (BigInt(horizon) - 1n).toString();
    }
    return positions;
  }

  function projectionAwait(body: ProjectionAwaitBody, res: ServerResponse): void {
    awaits.push({ body, receivedAt: performance.now() });
    // The contract lets a caller omit `timeoutMs`; the generated type marks it required only because it has a default.
    const timeoutMs = body.timeoutMs ?? PROJECTION_AWAIT_TIMEOUT_MS;
    const timeoutAfterMs = Math.min(timeoutMs, opts.neverAnswerAfterMs ?? timeoutMs);
    if (horizons.size > 0) {
      const positions = horizonPositions(body);
      if (positions !== undefined) {
        sendApplied(res, positions);
        return;
      }
      const entry: PendingAwait = {
        body,
        res,
        cancel: later(res, timeoutAfterMs, () => {
          pending.delete(entry);
          sendUnavailable(res);
        }),
      };
      pending.add(entry);
      res.once('close', () => pending.delete(entry));
      return;
    }
    const behaviour = awaitBehaviour;
    if (behaviour === 'immediate') {
      sendApplied(res, behaviourPositions(body));
    } else if (behaviour !== 'never' && behaviour.delayMs < timeoutMs) {
      // Migration answers 503 once `timeoutMs` elapses, so only a shorter delay ends applied.
      later(res, behaviour.delayMs, () => sendApplied(res, behaviourPositions(body)));
    } else {
      later(res, timeoutAfterMs, () => sendUnavailable(res));
    }
  }

  const base = await startHttpDouble((req, res) => {
    if (req.method === 'POST') {
      if (req.path === OPEN_PATH) return open(parseJson<WindowOpenInput>(req), res);
      if (req.path === AWAIT_PATH) return projectionAwait(parseJson<ProjectionAwaitBody>(req), res);
      const windowId = COMPLETE_PATTERN.exec(req.path)?.[1];
      if (windowId !== undefined) {
        return complete(decodeURIComponent(windowId), parseJson<WindowCompleteInput>(req), res);
      }
    }
    sendBytes(res, 404, '');
  });

  return {
    ...base,
    windows,
    awaits,
    setOpen(behaviour) {
      openBehaviour = behaviour;
    },
    setComplete(behaviour) {
      completeBehaviour = behaviour;
    },
    setAwait(behaviour) {
      awaitBehaviour = behaviour;
    },
    applied(owner, xid) {
      horizons.set(owner, String(xid));
      for (const entry of pending) {
        const positions = horizonPositions(entry.body);
        if (positions === undefined) continue;
        entry.cancel();
        pending.delete(entry);
        sendApplied(entry.res, positions);
      }
    },
    close() {
      for (const cancel of timers) cancel();
      return base.close();
    },
  };
}
