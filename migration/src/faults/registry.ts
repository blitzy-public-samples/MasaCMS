// In-process fault registry of the migration service, and the CLI's client of the service's fault operations.
import { setTimeout as delay } from 'node:timers/promises';

import { z } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../context.js';
import type { components, operations, paths } from '../generated/openapi.js';
import type { ProjectorHooks } from '../reverse/index.js';
import type { WindowHooks } from '../windows/index.js';

/** Faults the running migration service injects in its own process. */
export const REGISTRY_FAULT_NAMES = ['projector-delay', 'projector-crash', 'window-import-interrupted'] as const;

/** Name of a registry fault. */
export type RegistryFaultName = (typeof REGISTRY_FAULT_NAMES)[number];

/** Body of `faultSet`. */
export type FaultRequest = components['schemas']['FaultRequest'];

const PROJECTOR_DELAY = 'projector-delay' satisfies RegistryFaultName;
const PROJECTOR_CRASH = 'projector-crash' satisfies RegistryFaultName;
const WINDOW_IMPORT_INTERRUPTED = 'window-import-interrupted' satisfies RegistryFaultName;

/** Exit status of a projector crash, as for a process killed by SIGKILL. */
const CRASH_EXIT_CODE = 137;

const FAULT_PATH = '/internal/v1/faults/{name}' satisfies keyof paths;
const MIGRATION_SERVICE = 'migration';

type FaultOperation = Extract<keyof operations, 'faultSet' | 'faultClear'>;

/** Parameter schemas per fault; an omitted `delayMs` takes the configured default. */
function paramSchemas(defaultDelayMs: number) {
  return {
    'projector-delay': z.object({ delayMs: z.number().int().min(0).default(defaultDelayMs) }).strict(),
    'projector-crash': z
      .object({ point: z.literal('after-legacy-commit'), afterBatches: z.number().int().min(1).default(1) })
      .strict(),
    'window-import-interrupted': z.object({ windowId: z.string().min(1).optional() }).strict(),
  } as const satisfies Record<RegistryFaultName, z.ZodType>;
}

/** Parameters of each fault as armed, defaults applied. */
export type FaultParams = { [N in RegistryFaultName]: z.output<ReturnType<typeof paramSchemas>[N]> };

/** One armed fault of `name`; `since` is the ISO time it was armed. */
export interface ActiveFaultOf<N extends RegistryFaultName> {
  name: N;
  params: FaultParams[N];
  since: string;
}

/** One armed fault. */
export type ActiveFault = { [N in RegistryFaultName]: ActiveFaultOf<N> }[RegistryFaultName];

/** No registry fault has this name; maps to 404. The faults' errors carry the fault in `fault`, since `name` is the class name. */
export class UnknownFaultError extends Error {
  override readonly name: string = 'UnknownFaultError';
  readonly statusCode = 404;

  constructor(readonly fault: string) {
    super(`Unknown fault "${fault}"; known: ${REGISTRY_FAULT_NAMES.join(', ')}`);
  }
}

/** The fault's parameters are invalid, or the fault cannot be armed in this environment; maps to 400. */
export class FaultParamsError extends Error {
  override readonly name: string = 'FaultParamsError';
  readonly statusCode = 400;

  constructor(
    readonly fault: RegistryFaultName,
    /** One `key.path: message` line per problem. */
    readonly issues: string[],
  ) {
    super(`Invalid parameters for fault ${fault}: ${issues.join('; ')}`);
  }
}

/** Thrown by an armed hook; a plain error, so the hook's caller handles it as an ordinary failure of that step. */
export class FaultInjectedError extends Error {
  override readonly name: string = 'FaultInjectedError';

  constructor(readonly fault: RegistryFaultName) {
    super(`Fault ${fault} injected`);
  }
}

/** The migration service answered a fault operation outside 2xx; `body` is its answer unchanged. */
export class FaultCallError extends Error {
  override readonly name: string = 'FaultCallError';

  constructor(
    readonly operation: FaultOperation,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Migration ${operation} answered HTTP ${String(status)}`);
  }
}

/** This process's armed faults, and the hooks that consult them on every call. */
export interface FaultRegistry {
  /** Arms `name` with `params`, replacing it when already armed. @throws UnknownFaultError, FaultParamsError */
  set(name: string, params?: unknown): ActiveFault;
  /** Disarms `name`; true when it was armed. @throws UnknownFaultError */
  clear(name: string): boolean;
  /** The armed faults, sorted by name. */
  active(): ActiveFault[];
  /** `projector-delay` sleeps before each batch; `projector-crash` exits the process after the n-th batch's legacy commit. */
  projectorHooks(): ProjectorHooks;
  /** `window-import-interrupted` fails each import attempt of every window, or of the one named. */
  windowHooks(): WindowHooks;
}

/** Ports {@link createFaultRegistry} uses instead of the timer and `process.exit`, for example in tests. */
export interface FaultRegistryDeps {
  sleep?: (ms: number) => Promise<void>;
  exit?: (code: number) => void;
}

/** `name` as a registry fault name. @throws UnknownFaultError */
function registryName(name: string): RegistryFaultName {
  const found = REGISTRY_FAULT_NAMES.find((known) => known === name);
  if (found === undefined) throw new UnknownFaultError(name);
  return found;
}

/** Resolves once the logger's buffered lines are written. */
function flushed(logger: MigrationContext['logger']): Promise<void> {
  return new Promise((resolve) => {
    logger.flush(() => resolve());
  });
}

/** Creates the empty registry; faults live only in this process and vanish on restart. */
export function createFaultRegistry(
  ctx: Pick<MigrationContext, 'config' | 'clock' | 'logger' | 'env'>,
  deps: FaultRegistryDeps = {},
): FaultRegistry {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const defaultDelayMs = ctx.config.faults.find((fault) => fault.name === PROJECTOR_DELAY)?.defaultDelayMs;
  if (defaultDelayMs === undefined) throw new Error(`The migration config sets no defaultDelayMs for ${PROJECTOR_DELAY}`);
  const schemas = paramSchemas(defaultDelayMs);
  const faults = new Map<RegistryFaultName, ActiveFault>();

  // The projector calls `afterLegacyCommit` once per part of a batch, so batches are counted by batch id.
  let crashBatches = 0;
  let lastCrashBatchId: string | undefined;
  const resetCrashCount = (): void => {
    crashBatches = 0;
    lastCrashBatchId = undefined;
  };

  const projectorHooks: ProjectorHooks = {
    beforeBatch: async () => {
      const fault = faults.get(PROJECTOR_DELAY);
      if (fault?.name === PROJECTOR_DELAY) await sleep(fault.params.delayMs);
    },
    afterLegacyCommit: async ({ batchId }) => {
      const fault = faults.get(PROJECTOR_CRASH);
      if (fault?.name !== PROJECTOR_CRASH || batchId === lastCrashBatchId) return;
      lastCrashBatchId = batchId;
      crashBatches += 1;
      if (crashBatches !== fault.params.afterBatches) return;
      ctx.logger.warn(`fault ${PROJECTOR_CRASH} exiting after the legacy commit of batch ${batchId}`);
      try {
        await flushed(ctx.logger);
      } finally {
        exit(CRASH_EXIT_CODE);
      }
    },
  };

  const windowHooks: WindowHooks = {
    beforeImport: async (window) => {
      const fault = faults.get(WINDOW_IMPORT_INTERRUPTED);
      if (fault?.name !== WINDOW_IMPORT_INTERRUPTED) return;
      const { windowId } = fault.params;
      if (windowId === undefined || windowId === window.windowId) throw new FaultInjectedError(WINDOW_IMPORT_INTERRUPTED);
    },
  };

  return Object.freeze({
    set(name: string, params: unknown = {}): ActiveFault {
      const fault = registryName(name);
      if (fault === PROJECTOR_CRASH && ctx.env.OPT2_ENV !== 'local') {
        throw new FaultParamsError(fault, [`local only (OPT2_ENV=${ctx.env.OPT2_ENV})`]);
      }
      const parsed = schemas[fault].safeParse(params);
      if (!parsed.success) {
        throw new FaultParamsError(fault, parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`));
      }
      const entry = { name: fault, params: parsed.data, since: ctx.clock.now().toISOString() } as ActiveFault;
      faults.set(fault, entry);
      if (fault === PROJECTOR_CRASH) resetCrashCount();
      ctx.logger.info(`fault set ${fault} ${JSON.stringify(entry.params)}`);
      return entry;
    },
    clear(name: string): boolean {
      const fault = registryName(name);
      const wasActive = faults.delete(fault);
      if (fault === PROJECTOR_CRASH) resetCrashCount();
      if (wasActive) ctx.logger.info(`fault cleared ${fault}`);
      return wasActive;
    },
    active(): ActiveFault[] {
      // Map keys are unique, so two entries never share a name.
      return [...faults.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    projectorHooks: () => projectorHooks,
    windowHooks: () => windowHooks,
  });
}

/** Client of the running migration service's `faultSet` and `faultClear`, called as `platform.operator`. */
export interface RemoteFaults {
  /** Arms `name` in the running service with `params`; resolves with nothing, as `faultSet` answers 204. @throws FaultCallError on a non-2xx answer */
  set(name: RegistryFaultName, params?: FaultRequest['params']): Promise<void>;
  /** Disarms `name` in the running service. @throws FaultCallError on a non-2xx answer */
  clear(name: RegistryFaultName): Promise<void>;
}

/** Fault operations of the migration service at `OPT2_MIGRATION_URL`; each call is sent once. */
export function remoteFaults(ctx: Pick<MigrationContext, 'env' | 'clientAs'>): RemoteFaults {
  const call = async (operation: FaultOperation, name: RegistryFaultName, json?: FaultRequest): Promise<void> => {
    const response = await ctx.clientAs('operator').request({
      service: MIGRATION_SERVICE,
      method: operation === 'faultSet' ? 'PUT' : 'DELETE',
      path: FAULT_PATH.replace('{name}', encodeURIComponent(name)),
      json,
      userToken: null,
    });
    if (response.status < 200 || response.status > 299) throw new FaultCallError(operation, response.status, response.body);
  };
  const remote: RemoteFaults = {
    set: (name, params = {}) => call('faultSet', name, { params }),
    clear: (name) => call('faultClear', name),
  };
  return Object.freeze(remote);
}
