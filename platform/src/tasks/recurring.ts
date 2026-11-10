/** Self-rescheduling recurring task chains with one deterministically named task per slot. */
import type { CreateTaskInput, TaskContext, TaskHandler, TaskPort } from './port.js';
import { queueDefinition, recurringQueues, targetUrl } from './queues.js';
import type { Clock } from '../service-kit/index.js';
import { LegacyServiceUnavailableError } from '../legacy-compat/index.js';

/** Start, in epoch seconds, of the slot containing `epochS`. */
export function slotStartS(epochS: number, intervalS: number): number {
  return Math.floor(epochS / intervalS) * intervalS;
}

/** Task name of a queue's slot, `<queue>-<slot start epoch s>`; throws `TypeError` unless the slot is a non-negative integer. */
export function slotName(queue: string, slotStartEpochS: number): string {
  if (!Number.isInteger(slotStartEpochS) || slotStartEpochS < 0) {
    throw new TypeError(`Slot start must be a non-negative integer of epoch seconds, got ${String(slotStartEpochS)}`);
  }
  return `${queue}-${String(slotStartEpochS)}`;
}

/** Slot start encoded in a chain task name of `queue`, or undefined for any other name. */
export function parseSlotName(queue: string, name: string): number | undefined {
  const escaped = queue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const digits = new RegExp(`^${escaped}-(\\d+)$`).exec(name)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/** Successor slot of `currentSlotS`: the next slot, and never one at or before the slot containing `nowS`. */
export function successorSlotS(currentSlotS: number, nowS: number, intervalS: number): number {
  return Math.max(currentSlotS + intervalS, slotStartS(nowS, intervalS) + intervalS);
}

/** Queue, cadence and target of one recurring chain. */
export interface RecurringSpec {
  queue: string;
  intervalS: number;
  deadlineS: number;
  url: string;
}

/** Chain spec of a registry queue; throws `TypeError` when the queue is not recurring. */
export function recurringSpec(queue: string, serviceUrls: Record<string, string>): RecurringSpec {
  const def = queueDefinition(queue);
  if (!def.recurring) throw new TypeError(`Queue ${queue} is not a recurring queue`);
  return { queue: def.name, intervalS: def.recurring.intervalS, deadlineS: def.deadlineS, url: targetUrl(def, serviceUrls) };
}

/** Outcome of `ensureRecurring`; `name` is the live task found or the task created or already present. */
export interface EnsureRecurringResult {
  queue: string;
  name: string;
  created: boolean;
  reason: 'live' | 'created-current' | 'created-next';
}

function epochSeconds(clock: Clock): number {
  return Math.floor(clock.now().getTime() / 1000);
}

// Recurring tasks are system tasks: no tenantId, ever.
function slotTask(spec: RecurringSpec, slotS: number): CreateTaskInput {
  return {
    queue: spec.queue,
    name: slotName(spec.queue, slotS),
    scheduleTime: new Date(slotS * 1000),
    url: spec.url,
    deadlineS: spec.deadlineS,
    body: { slotStartS: slotS },
  };
}

/** Creates the current slot's chain task unless a chain task of any slot is live. */
export async function ensureRecurring(port: TaskPort, opts: RecurringSpec & { clock: Clock }): Promise<EnsureRecurringResult> {
  const { queue, intervalS } = opts;
  const current = slotStartS(epochSeconds(opts.clock), intervalS);

  let earliest: { name: string; slotS: number } | undefined;
  for (const task of await port.list(queue)) {
    const slotS = parseSlotName(queue, task.name);
    if (slotS !== undefined && (earliest === undefined || slotS < earliest.slotS)) earliest = { name: task.name, slotS };
  }
  if (earliest) return { queue, name: earliest.name, created: false, reason: 'live' };

  const currentTask = slotTask(opts, current);
  if ((await port.create(currentTask)).created) {
    return { queue, name: currentTask.name, created: true, reason: 'created-current' };
  }

  // Not live yet not creatable: the current name is the tombstone of a lost chain, so restart at the next slot.
  const nextTask = slotTask(opts, current + intervalS);
  const next = await port.create(nextTask);
  return { queue, name: nextTask.name, created: next.created, reason: 'created-next' };
}

/** The successor chain task could not be created; renders as the legacy 503 so the queue retries the current task. */
export class SuccessorCreationError extends LegacyServiceUnavailableError {
  override readonly name: string = 'SuccessorCreationError';

  constructor(
    readonly queue: string,
    readonly successor: string,
    override readonly cause: unknown,
  ) {
    super(`Could not create successor task ${successor} on queue ${queue}`, 'auto', 'successor-creation-failed');
  }
}

/** Task context of a chain task: its slot and the successor created before the work ran. */
export interface RecurringTaskContext extends TaskContext {
  slotStartS: number;
  successor: { name: string; created: boolean };
}

const CLOUD_TASK_PATH_PREFIX = /^projects\/.*\/tasks\//;

/** Task handler that creates the chain's successor, then runs `fn`; returns `fn`'s result or `{ ok: true, successor }`. */
export function recurringHandler(
  opts: RecurringSpec & { port: TaskPort; clock: Clock },
  fn: (ctx: RecurringTaskContext) => Promise<unknown>,
): TaskHandler {
  const { queue, intervalS, port, clock } = opts;
  return async (ctx) => {
    const nowS = epochSeconds(clock);
    const taskId = ctx.taskName.replace(CLOUD_TASK_PATH_PREFIX, '');
    const current = parseSlotName(queue, taskId) ?? slotStartS(nowS, intervalS);
    const successorTask = slotTask(opts, successorSlotS(current, nowS, intervalS));

    let created: boolean;
    try {
      created = (await port.create(successorTask)).created;
    } catch (err) {
      throw new SuccessorCreationError(queue, successorTask.name, err);
    }

    const result = await fn({ ...ctx, slotStartS: current, successor: { name: successorTask.name, created } });
    return result === undefined ? { ok: true, successor: successorTask.name } : result;
  };
}

/** Ensures, in registry order, every recurring chain `service` creates; the site monitor only with `withSiteMonitor`. */
export async function ensureOwnRecurring(
  port: TaskPort,
  opts: { service: string; serviceUrls: Record<string, string>; clock: Clock; withSiteMonitor?: boolean },
): Promise<EnsureRecurringResult[]> {
  const results: EnsureRecurringResult[] = [];
  for (const def of recurringQueues({ includeLocalOnly: true, withSiteMonitor: opts.withSiteMonitor })) {
    if (!def.creators.includes(opts.service)) continue;
    results.push(await ensureRecurring(port, { ...recurringSpec(def.name, opts.serviceUrls), clock: opts.clock }));
  }
  return results;
}
