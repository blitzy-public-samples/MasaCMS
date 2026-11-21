// Contract of the scripted migration faults and the assertion helpers their scripts report with.
import type { z } from '@opt2/platform/service-kit';

import type { MigrationContext } from '../../context.js';
import type { ProcessControl } from '../process-control.js';
import type { remoteFaults } from '../registry.js';

/** Ports a fault script acts through. */
export interface FaultEnv {
  ctx: MigrationContext;
  processControl: ProcessControl;
  /** Fault operations of the running migration service. */
  remote: ReturnType<typeof remoteFaults>;
  sleep(ms: number): Promise<void>;
  clock: MigrationContext['clock'];
  logger: MigrationContext['logger'];
}

/** Outcome of one assertion; a `skipped` one leaves the fault unmet unless another fails it. */
export type FaultAssertionStatus = 'pass' | 'fail' | 'skipped';

/** One checked expectation; `detail` is JSON-safe, and a `skipped` assertion carries `reason`. */
export interface FaultAssertion {
  name: string;
  status: FaultAssertionStatus;
  detail?: unknown;
  reason?: string;
}

/** Result of a script's `run`; `state` is the JSON-safe input its `resume` needs. */
export interface FaultRunOutput {
  assertions: FaultAssertion[];
  details?: Record<string, unknown>;
  state?: Record<string, unknown>;
}

/** Result of a script's `resume`; `steps` names each recovery step performed, in order. */
export interface FaultResumeOutput {
  steps: string[];
  assertions: FaultAssertion[];
  details?: Record<string, unknown>;
}

/** One scripted fault: injects in `run`, recovers in `resume`; never reconciles or writes reports. */
export interface FaultScript<P = unknown> {
  /** Fault id in the migration config. */
  readonly name: string;
  /** Whether the run reconciles at `after-fault-<name>` afterwards. */
  readonly reconciles: boolean;
  readonly paramsSchema: z.ZodType<P>;
  // Method syntax keeps the parameters bivariant, so a script with concrete params is assignable to FaultScript.
  run(env: FaultEnv, params: P): Promise<FaultRunOutput>;
  /** Called after `run` whether or not it threw; `output` is undefined when it did. */
  resume(env: FaultEnv, params: P, output?: FaultRunOutput): Promise<FaultResumeOutput>;
}

/** A passed assertion. */
export function pass(name: string, detail?: unknown): FaultAssertion {
  return detail === undefined ? { name, status: 'pass' } : { name, status: 'pass', detail };
}

/** A failed assertion, explained by `detail`. */
export function fail(name: string, detail: unknown, reason?: string): FaultAssertion {
  return reason === undefined ? { name, status: 'fail', detail } : { name, status: 'fail', detail, reason };
}

/** An assertion that could not be checked, with the reason. */
export function skipped(name: string, reason: string): FaultAssertion {
  return { name, status: 'skipped', reason };
}
