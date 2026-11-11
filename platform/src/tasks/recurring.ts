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

/** Most consecutive slots a chain walk tries before giving up on tombstoned names. */
export const MAX_SLOT_PROBES = 5;

/** Every probed slot name of a chain is a tombstone; renders as the legacy 503 so the caller retries. */
export class RecurringSlotsTombstonedError extends LegacyServiceUnavailableError {
  override readonly name: string = 'RecurringSlotsTombstonedError';

  constructor(
    readonly queue: string,
    readonly probed: readonly string[],
  ) {
    super(`No live chain task on queue ${queue}: tombstoned slots ${probed.join(', ')}`, 'auto', 'recurring-slots-tombstoned');
  }
}

/** Live chain task a slot walk secured: its slot, and whether the walk created it. */
interface DurableSlot {
  name: string;
  slotS: number;
  created: boolean;
}

/** Secures a live chain task at `fromS` or the first later slot whose name is not a tombstone; throws `RecurringSlotsTombstonedError` after `MAX_SLOT_PROBES` tombstones. */
async function durableSlot(port: TaskPort, spec: RecurringSpec, fromS: number): Promise<DurableSlot> {
  const probed: string[] = [];
  for (let probe = 0; probe < MAX_SLOT_PROBES; probe += 1) {
    const slotS = fromS + probe * spec.intervalS;
    const task = slotTask(spec, slotS);
    if ((await port.create(task)).created) return { name: task.name, slotS, created: true };
    if ((await port.get(spec.queue, task.name)) !== undefined) return { name: task.name, slotS, created: false };
    // ALREADY_EXISTS with no live task is a tombstone, whose name stays reserved.
    probed.push(task.name);
  }
  throw new RecurringSlotsTombstonedError(spec.queue, probed);
}

/** Earliest chain task in the first page of the queue that holds one, or undefined when no page does. */
async function liveChainTask(port: TaskPort, queue: string): Promise<string | undefined> {
  let pageToken: string | undefined;
  do {
    const page = await port.list(queue, pageToken === undefined ? {} : { pageToken });
    let earliest: { name: string; slotS: number } | undefined;
    for (const task of page.tasks) {
      const slotS = parseSlotName(queue, task.name);
      if (slotS !== undefined && (earliest === undefined || slotS < earliest.slotS)) earliest = { name: task.name, slotS };
    }
    if (earliest) return earliest.name;
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return undefined;
}

/** Creates the current slot's chain task, or a later one past tombstones, unless a chain task is live. */
export async function ensureRecurring(port: TaskPort, opts: RecurringSpec & { clock: Clock }): Promise<EnsureRecurringResult> {
  const { queue, intervalS } = opts;
  const current = slotStartS(epochSeconds(opts.clock), intervalS);

  const live = await liveChainTask(port, queue);
  if (live !== undefined) return { queue, name: live, created: false, reason: 'live' };

  const slot = await durableSlot(port, opts, current);
  if (!slot.created) return { queue, name: slot.name, created: false, reason: 'live' };
  return { queue, name: slot.name, created: true, reason: slot.slotS === current ? 'created-current' : 'created-next' };
}

/** No live successor chain task could be secured; renders as the legacy 503 so the queue retries the current task. */
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

/** Task context of a chain task: its slot and the live successor secured before the work ran. */
export interface RecurringTaskContext extends TaskContext {
  slotStartS: number;
  successor: { name: string; created: boolean };
}

const CLOUD_TASK_PATH_PREFIX = /^projects\/.*\/tasks\//;

/** Task handler that secures a live successor chain task, then runs `fn`; returns `fn`'s result or `{ ok: true, successor }`. */
export function recurringHandler(
  opts: RecurringSpec & { port: TaskPort; clock: Clock },
  fn: (ctx: RecurringTaskContext) => Promise<unknown>,
): TaskHandler {
  const { queue, intervalS, port, clock } = opts;
  return async (ctx) => {
    const nowS = epochSeconds(clock);
    const taskId = ctx.taskName.replace(CLOUD_TASK_PATH_PREFIX, '');
    const current = parseSlotName(queue, taskId) ?? slotStartS(nowS, intervalS);
    const successorS = successorSlotS(current, nowS, intervalS);

    let successor: DurableSlot;
    try {
      successor = await durableSlot(port, opts, successorS);
    } catch (err) {
      throw new SuccessorCreationError(queue, slotName(queue, successorS), err);
    }

    const result = await fn({ ...ctx, slotStartS: current, successor: { name: successor.name, created: successor.created } });
    return result === undefined ? { ok: true, successor: successor.name } : result;
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
