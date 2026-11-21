// Scheduled-task rules of the golden normaliser: kind, target route and offset from the scheduling base.
import type { TaskRecord } from '../side-effects.js';
import type { NormaliseRules, TaskRules } from './rules.js';
import { normaliseUrl } from './values.js';

/** One scheduled task as compared: kind verbatim, normalised target route, seconds from its scheduling base. */
export interface NormalisedTask {
  kind: string;
  target: string;
  offsetSeconds: number;
}

type IdOrdinals = Parameters<typeof normaliseUrl>[1];

/** Options of {@link normaliseTasks}. */
export interface NormaliseTasksOptions {
  /** The scenario side's id ordinals, continued from its steps. */
  state: IdOrdinals;
  rules: NormaliseRules;
  /** Base for records without their own, e.g. a launch time the catalogue binds; else the earliest task time. */
  base?: string;
}

type OrderField = keyof NormalisedTask;

// `tasks.order` names of the rules, mapped to the field each sorts by.
const ORDER_FIELDS: ReadonlyMap<string, OrderField> = new Map([
  ['kind', 'kind'],
  ['targetRoute', 'target'],
  ['offsetSeconds', 'offsetSeconds'],
]);

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;

// Zone-less times are read as wall-clock readings with UTC arithmetic, as side-effects.ts derives `scheduledAt`
// from the launch time, so both sides parse identically whatever the process TZ and across DST changes.
function wallClockMs(value: string, what: string): number {
  const m = WALL_CLOCK.exec(value);
  if (m === null) {
    throw new RangeError(`task ${what} ${JSON.stringify(value)} is not a zone-less YYYY-MM-DDTHH:MM:SS time`);
  }
  const [, year, month, day, hour, minute, second, fraction = '0'] = m;
  return Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(fraction.padEnd(3, '0')),
  );
}

function orderFields(rules: TaskRules): OrderField[] {
  return rules.order.map((name) => {
    const field = ORDER_FIELDS.get(name);
    if (field === undefined) {
      const known = [...ORDER_FIELDS.keys()].join(', ');
      throw new RangeError(`tasks.order names unknown field ${name}; expected one of ${known}`);
    }
    return field;
  });
}

// Code-unit order for strings, so the order never depends on the locale.
function byFields(fields: readonly OrderField[]): (a: NormalisedTask, b: NormalisedTask) => number {
  return (a, b) => {
    for (const field of fields) {
      const x = a[field];
      const y = b[field];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/**
 * Tasks as compared, sorted by the rules' `tasks.order`. Each offset is taken from the record's own `base`, else
 * `opts.base`, else the earliest `scheduledAt` in `tasks`; targets go through `normaliseUrl`.
 * Throws `RangeError` for a time that is not zone-less `YYYY-MM-DDTHH:MM:SS[.sss]` or an unknown order field.
 */
export function normaliseTasks(tasks: readonly TaskRecord[], opts: NormaliseTasksOptions): NormalisedTask[] {
  const { state, rules } = opts;
  const fields = orderFields(rules.tasks);
  const fallback = nonEmpty(opts.base);
  let earliest: number | undefined;
  const baseMs = (task: TaskRecord): number => {
    const base = nonEmpty(task.base) ?? fallback;
    if (base !== undefined) return wallClockMs(base, 'base');
    earliest ??= tasks.reduce((min, t) => Math.min(min, wallClockMs(t.scheduledAt, 'scheduledAt')), Infinity);
    return earliest;
  };
  const timed = tasks.map(
    (task): NormalisedTask => ({
      kind: task.kind,
      target: task.target,
      // `+ 0` folds -0, which a JSON golden set cannot hold.
      offsetSeconds: Math.round((wallClockMs(task.scheduledAt, 'scheduledAt') - baseMs(task)) / 1000) + 0,
    }),
  );
  // Targets are normalised in `tasks.order` less the target (stable sort), so ids first seen in them take
  // ordinals independent of the order each side lists its tasks in.
  timed.sort(byFields(fields.filter((field) => field !== 'target')));
  return timed
    .map((task) => ({ ...task, target: normaliseUrl(task.target, state, rules) }))
    .sort(byFields(fields));
}
