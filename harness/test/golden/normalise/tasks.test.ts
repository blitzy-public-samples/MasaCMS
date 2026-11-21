import { cfUuid } from '@opt2/platform/legacy-compat';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { createIdOrdinals, ordinalFor } from '../../../src/golden/normalise/ids.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseTasks, type NormalisedTask } from '../../../src/golden/normalise/tasks.js';
import type { TaskRecord } from '../../../src/golden/side-effects.js';

const LEGACY_ORIGIN = 'http://127.0.0.1:8500';
const GATEWAY_ORIGIN = 'http://127.0.0.1:8100';
const SURVEYS_PATH = '/legacy-fixtures/cfml/api.cfm/surveys/surveys/';
const ROUTE_PREFIX = `<origin>${SURVEYS_PATH}`;
const LAUNCH_AT = '2026-06-30T09:00:00';
const HOUR = 3600;
const DAY = 86_400;
const ACTION = { launch: 'launch', reminder: 'remind' } as const;

type Kind = keyof typeof ACTION;
type BaseMode = 'own' | 'earliest';

let rules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
});

const epochMs = (time: string): number => Date.parse(`${time}Z`);

/** Zone-less time `seconds` after `LAUNCH_AT`, with the unit's UTC wall-clock arithmetic. */
function at(seconds: number): string {
  return new Date(epochMs(LAUNCH_AT) + seconds * 1000).toISOString().slice(0, 19);
}

/** One task of `surveyId` as the survey tasks route lists it, scheduled `seconds` after `LAUNCH_AT`. */
function task(
  origin: string,
  surveyId: string,
  kind: Kind,
  seconds: number,
  base: string,
  suffix: string = kind,
): TaskRecord {
  return {
    name: `opt2-survey-${surveyId}-${suffix}`,
    kind,
    target: `${origin}${SURVEYS_PATH}${surveyId}/${ACTION[kind]}`,
    scheduledAt: at(seconds),
    base,
  };
}

/** A launch `launch` seconds after `LAUNCH_AT`, reminders an hour and a day later; `base` defaults to the launch. */
function scheduleOf(origin: string, surveyId: string, opts: { launch?: number; base?: string } = {}): TaskRecord[] {
  const launch = opts.launch ?? 0;
  const base = opts.base ?? at(launch);
  return [
    task(origin, surveyId, 'launch', launch, base),
    task(origin, surveyId, 'reminder', launch + HOUR, base, 'reminder-1'),
    task(origin, surveyId, 'reminder', launch + DAY, base, 'reminder-2'),
  ];
}

/** Surveys `a` and `b`, `b` launching a minute after `a`, each based on its own launch or on neither. */
function twoSurveys(origin: string, a: string, b: string, mode: BaseMode): TaskRecord[] {
  const base = (launch: number): string => (mode === 'own' ? at(launch) : '');
  return [...scheduleOf(origin, a, { base: base(0) }), ...scheduleOf(origin, b, { launch: 60, base: base(60) })];
}

const normalise = (tasks: readonly TaskRecord[], base?: string): NormalisedTask[] =>
  normaliseTasks(tasks, { state: createIdOrdinals(), rules, base });

const offsets = (tasks: readonly NormalisedTask[]): number[] => tasks.map((t) => t.offsetSeconds);

const withOrder = (order: string[]): NormaliseRules => ({ ...rules, tasks: { ...rules.tasks, order } });

const replaceAt = (tasks: readonly TaskRecord[], index: number, change: (t: TaskRecord) => TaskRecord): TaskRecord[] =>
  tasks.map((t, i) => (i === index ? change(t) : t));

describe('normaliseTasks offsets', () => {
  it.each<[string, string | undefined]>([
    ['no caller base', undefined],
    ['an empty caller base', ''],
  ])('takes offsets from the earliest task time with records without a base and %s', (_label, base) => {
    expect(normalise(scheduleOf(LEGACY_ORIGIN, cfUuid(), { base: '' }), base)).toStrictEqual([
      { kind: 'launch', target: `${ROUTE_PREFIX}<id:1>/launch`, offsetSeconds: 0 },
      { kind: 'reminder', target: `${ROUTE_PREFIX}<id:1>/remind`, offsetSeconds: HOUR },
      { kind: 'reminder', target: `${ROUTE_PREFIX}<id:1>/remind`, offsetSeconds: DAY },
    ]);
  });

  it('takes offsets from the caller base for records without their own', () => {
    const tasks = scheduleOf(LEGACY_ORIGIN, cfUuid(), { base: '' });
    expect(offsets(normalise(tasks, at(-600)))).toStrictEqual([600, 4200, 87_000]);
  });

  it("prefers each record's own base over the caller base", () => {
    const tasks = scheduleOf(LEGACY_ORIGIN, cfUuid());
    expect(offsets(normalise(tasks, at(-600)))).toStrictEqual([0, HOUR, DAY]);
  });

  it.each<[string, string, number[]]>([
    ['its own launch', at(DAY), [0, 0, HOUR, HOUR, DAY, DAY]],
    ['the earliest task time of the whole list', '', [0, DAY, HOUR, DAY, DAY + HOUR, 2 * DAY]],
  ])('measures a survey launched a day later from %s', (_label, laterBase, expected) => {
    const tasks = [
      ...scheduleOf(LEGACY_ORIGIN, cfUuid()),
      ...scheduleOf(LEGACY_ORIGIN, cfUuid(), { launch: DAY, base: laterBase }),
    ];
    expect(offsets(normalise(tasks))).toStrictEqual(expected);
  });

  it.each<[string, string, number]>([
    ['2026-06-30 10:00:00', LAUNCH_AT, HOUR],
    ['2026-06-30T09:00:01.5', LAUNCH_AT, 2],
    ['2026-06-30T09:00:00.499', LAUNCH_AT, 0],
    ['2026-06-30T09:00:02', '2026-06-30T09:00:00.6', 1],
    ['2026-06-30T09:00:00.05', '2026-06-30T09:00:00.95', -1],
    ['2026-06-30T08:50:00', LAUNCH_AT, -600],
    ['2026-06-30T08:59:59.6', LAUNCH_AT, 0],
  ])('reads %s against base %s as %d whole seconds', (scheduledAt, base, expected) => {
    const [only] = normalise([{ ...task(LEGACY_ORIGIN, cfUuid(), 'launch', 0, base), scheduledAt }]);
    expect(only?.offsetSeconds).toBe(expected);
  });

  it.each<[string, string]>([
    ['five days later', '2026-07-05T09:00:00'],
    ['across a year end', '2026-12-31T23:30:00'],
    ['across a leap day', '2028-02-28T12:00:00'],
  ])('normalises a schedule moved %s to the same list', (_label, launchAt) => {
    const shift = (epochMs(launchAt) - epochMs(LAUNCH_AT)) / 1000;
    const original = normalise(scheduleOf(LEGACY_ORIGIN, cfUuid()));
    expect(normalise(scheduleOf(LEGACY_ORIGIN, cfUuid(), { launch: shift }))).toStrictEqual(original);
    expect(normalise(scheduleOf(LEGACY_ORIGIN, cfUuid(), { launch: shift, base: '' }))).toStrictEqual(original);
  });

  it.each<[string, string | undefined]>([
    ['no caller base', undefined],
    ['a caller base', LAUNCH_AT],
  ])('returns an empty list for no tasks with %s', (_label, base) => {
    expect(normalise([], base)).toStrictEqual([]);
  });
});

describe('normaliseTasks targets', () => {
  it('normalises a legacy schedule and its gateway copy with other ids to the same list', () => {
    const legacyId = cfUuid();
    const gatewayId = cfUuid();
    const legacy = scheduleOf(LEGACY_ORIGIN, legacyId);
    const gateway = scheduleOf(GATEWAY_ORIGIN, gatewayId);
    expect(gatewayId).not.toBe(legacyId);
    const normalised = normalise(legacy);
    expect(normalise(gateway)).toStrictEqual(normalised);
    expect(normalised.map((t) => t.target)).toStrictEqual([
      `${ROUTE_PREFIX}<id:1>/launch`,
      `${ROUTE_PREFIX}<id:1>/remind`,
      `${ROUTE_PREFIX}<id:1>/remind`,
    ]);
  });

  it.each<[string, (t: TaskRecord) => TaskRecord]>([
    ['kind', (t) => ({ ...t, kind: 'followup' })],
    ['target path', (t) => ({ ...t, target: t.target.replace(/\/remind$/, '/close') })],
    ['time, T+7200 s', (t) => ({ ...t, scheduledAt: at(2 * HOUR) })],
  ])("tells the sides apart when the gateway's first reminder has another %s", (_label, change) => {
    const legacy = scheduleOf(LEGACY_ORIGIN, cfUuid());
    const gateway = replaceAt(scheduleOf(GATEWAY_ORIGIN, cfUuid()), 1, change);
    expect(normalise(gateway)).not.toStrictEqual(normalise(legacy));
  });

  it("continues the id ordinals the scenario's steps assigned", () => {
    const state = createIdOrdinals();
    const surveyId = cfUuid();
    expect(ordinalFor(cfUuid(), state, rules.ids)).toBe('<id:1>');
    expect(ordinalFor(surveyId, state, rules.ids)).toBe('<id:2>');
    const normalised = normaliseTasks(scheduleOf(LEGACY_ORIGIN, surveyId), { state, rules });
    expect(normalised.map((t) => t.target)).toStrictEqual([
      `${ROUTE_PREFIX}<id:2>/launch`,
      `${ROUTE_PREFIX}<id:2>/remind`,
      `${ROUTE_PREFIX}<id:2>/remind`,
    ]);
    expect(state.next).toBe(3);
  });

  it.each<[string, BaseMode]>([
    ['their own launches', 'own'],
    ['the earliest task time', 'earliest'],
  ])('normalises every listing order of two surveys based on %s to the same list', (_label, mode) => {
    const expected = normalise(twoSurveys(LEGACY_ORIGIN, cfUuid(), cfUuid(), mode));
    const gateway = twoSurveys(GATEWAY_ORIGIN, cfUuid(), cfUuid(), mode);
    fc.assert(
      fc.property(fc.shuffledSubarray(gateway, { minLength: gateway.length }), (listing) => {
        expect(normalise(listing)).toStrictEqual(expected);
      }),
      { examples: [[[...gateway].reverse()]] },
    );
  });
});

describe('normaliseTasks order', () => {
  const brief = (t: NormalisedTask): string => `${t.kind} ${t.offsetSeconds} ${t.target.slice(ROUTE_PREFIX.length)}`;

  it.each<[string, string[] | undefined, string[]]>([
    [
      'the committed kind, offset, then target route',
      undefined,
      [
        'launch 0 <id:1>/launch',
        'launch 60 <id:2>/launch',
        'reminder 3600 <id:1>/remind',
        'reminder 3600 <id:2>/remind',
        'reminder 86400 <id:1>/remind',
      ],
    ],
    [
      'target route, then offset',
      ['targetRoute', 'offsetSeconds'],
      [
        'launch 0 <id:1>/launch',
        'reminder 3600 <id:1>/remind',
        'reminder 86400 <id:1>/remind',
        'launch 60 <id:2>/launch',
        'reminder 3600 <id:2>/remind',
      ],
    ],
    [
      'offset, then kind, keeping the listing order of ties',
      ['offsetSeconds', 'kind'],
      [
        'launch 0 <id:1>/launch',
        'launch 60 <id:2>/launch',
        'reminder 3600 <id:2>/remind',
        'reminder 3600 <id:1>/remind',
        'reminder 86400 <id:1>/remind',
      ],
    ],
  ])('sorts by %s and numbers ids in that order', (_label, order, expected) => {
    const a = cfUuid();
    const b = cfUuid();
    const listing = [
      task(LEGACY_ORIGIN, b, 'reminder', HOUR, '', 'reminder-1'),
      task(LEGACY_ORIGIN, a, 'reminder', DAY, '', 'reminder-2'),
      task(LEGACY_ORIGIN, a, 'launch', 0, ''),
      task(LEGACY_ORIGIN, a, 'reminder', HOUR, '', 'reminder-1'),
      task(LEGACY_ORIGIN, b, 'launch', 60, ''),
    ];
    const ordered = order === undefined ? rules : withOrder(order);
    const normalised = normaliseTasks(listing, { state: createIdOrdinals(), rules: ordered });
    expect(normalised.map(brief)).toStrictEqual(expected);
  });

  it('orders strings by code unit, not by locale', () => {
    const listing = scheduleOf(LEGACY_ORIGIN, cfUuid()).map((t) =>
      t.kind === 'reminder' ? { ...t, kind: 'Reminder' } : t,
    );
    expect(normalise(listing).map((t) => t.kind)).toStrictEqual(['Reminder', 'Reminder', 'launch']);
  });
});

describe('normaliseTasks rejects', () => {
  const surveyId = cfUuid();
  const timeAt = (tasks: readonly TaskRecord[], index: number, bad: string): TaskRecord[] =>
    replaceAt(tasks, index, (t) => ({ ...t, scheduledAt: bad }));
  const places: [string, 'scheduledAt' | 'base', (bad: string) => [TaskRecord[], string | undefined]][] = [
    ['a task time', 'scheduledAt', (bad) => [timeAt(scheduleOf(LEGACY_ORIGIN, surveyId), 2, bad), undefined]],
    [
      'a task time on the earliest-time fallback',
      'scheduledAt',
      (bad) => [timeAt(scheduleOf(LEGACY_ORIGIN, surveyId, { base: '' }), 1, bad), undefined],
    ],
    ['a record base', 'base', (bad) => [scheduleOf(LEGACY_ORIGIN, surveyId, { base: bad }), undefined]],
    ['a caller base', 'base', (bad) => [scheduleOf(LEGACY_ORIGIN, surveyId, { base: '' }), bad]],
  ];
  const badTimes = [
    '2026-06-30T09:00:00Z',
    '2026-06-30T09:00:00+02:00',
    '2026-06-30',
    '2026-06-30T09:00:00.1234',
    '30/06/2026 09:00:00',
  ];

  it.each(places.flatMap(([place, what, build]) => badTimes.map((bad) => [place, bad, what, build] as const)))(
    'throws RangeError for %s of %s',
    (_place, bad, what, build) => {
      const [tasks, base] = build(bad);
      const run = (): NormalisedTask[] => normalise(tasks, base);
      expect(run).toThrow(RangeError);
      expect(run).toThrow(`task ${what} ${JSON.stringify(bad)} is not a zone-less YYYY-MM-DDTHH:MM:SS time`);
    },
  );

  it('throws RangeError naming an unknown tasks.order field and the known ones', () => {
    const opts = { state: createIdOrdinals(), rules: withOrder(['kind', 'priority']) };
    const run = (): NormalisedTask[] => normaliseTasks(scheduleOf(LEGACY_ORIGIN, surveyId), opts);
    expect(run).toThrow(RangeError);
    expect(run).toThrow('tasks.order names unknown field priority; expected one of kind, targetRoute, offsetSeconds');
  });
});
