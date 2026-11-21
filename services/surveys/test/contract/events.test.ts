// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Producer contract of `surveys.survey.scheduled.v1`: the schema's declarations and the envelopes a fixture (re)schedule publishes. */
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ContractAssertionError,
  TENANT_A,
  assertEventMatches,
  withoutTenant,
  type PublishedEvent,
} from '@opt2/platform/testing';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledSchema } from '../../src/events/survey-scheduled.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';

/** An object node of the topic schema. */
interface ObjectSchema {
  $ref?: string;
  additionalProperties?: unknown;
  required?: string[];
  properties?: Record<string, ObjectSchema & { items?: ObjectSchema }>;
}

/** The root keywords of the payload schema file this suite reads. */
interface TopicSchemaFile extends ObjectSchema {
  $comment: string;
  'x-opt2-kind'?: unknown;
  'x-opt2-supersedes'?: unknown;
  $defs: Record<string, ObjectSchema>;
}

/** The payload surveys builds for the topic, as read back from a captured envelope. */
interface ScheduledPayload {
  surveyId: string;
  siteId: string;
  scheduleVersion: number;
  launchAt: string;
  launchTaskName: string;
  reminders: { n: number; offsetMinutes: number; taskName: string }[];
  targets: { siteId: string; groupName: string | null }[];
}

type CapturedEnvelope = PublishedEvent['envelope'];

async function readJson<T>(relative: string): Promise<T> {
  return JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8')) as T;
}

const schema = await readJson<TopicSchemaFile>('../../contracts/events/surveys.survey.scheduled.v1.json');
const envelopeSchema = await readJson<object>('../../../../platform/contracts/event-envelope.v1.json');
const pin = await readJson<{ sha: string }>('../../../../opt2/source-pin.json');

const PAYLOAD_FIELDS = ['surveyId', 'siteId', 'scheduleVersion', 'launchAt', 'launchTaskName', 'reminders', 'targets'] as const;
const REMINDER_FIELDS = ['n', 'offsetMinutes', 'taskName'] as const;
const TARGET_FIELDS = ['siteId', 'groupName'] as const;

const SITE = `?siteid=${TENANT_A.siteId}`;
const CSRF_HEADERS = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const TARGETS = [{ siteID: 'tenant-b' }, { siteID: 'umbrella', groupName: 'Staff' }];
const FIRST = { launchAt: '2026-07-01T09:00:00', reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 1440 }] };
const RESCHEDULE = { launchAt: '2026-07-02T08:30:00', reminders: [{ offsetMinutes: 30 }, { offsetMinutes: 120 }, { offsetMinutes: 2880 }] };

/** The node a local `#/…` JSON pointer names in the topic schema. */
function resolveLocal(ref: string): ObjectSchema {
  if (!ref.startsWith('#/')) throw new Error(`not a local $ref: ${ref}`);
  const node = ref
    .slice(2)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], schema);
  if (node === undefined) throw new Error(`unresolved $ref: ${ref}`);
  return node as ObjectSchema;
}

/** The item schema of a list field, its `$ref` resolved within the file. */
function itemSchema(field: 'reminders' | 'targets'): ObjectSchema {
  const items = schema.properties?.[field]?.items;
  if (items === undefined) throw new Error(`${field} declares no items`);
  return items.$ref === undefined ? items : resolveLocal(items.$ref);
}

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

/** The ContractAssertionError `run` throws; fails the test when it throws nothing or something else. */
function contractErrorOf(run: () => unknown): ContractAssertionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractAssertionError);
    return error as ContractAssertionError;
  }
  throw new Error('expected a ContractAssertionError, but nothing was thrown');
}

const payloadOf = (envelope: CapturedEnvelope): ScheduledPayload => envelope.payload as ScheduledPayload;

/** A copy of `envelope` whose payload `edit` changed. */
function withPayload(envelope: CapturedEnvelope, edit: (payload: Record<string, unknown>) => void): CapturedEnvelope {
  const payload = structuredClone(envelope.payload) as Record<string, unknown>;
  edit(payload);
  return { ...envelope, payload };
}

describe('surveys.survey.scheduled.v1 payload schema', () => {
  it('is a superseding process topic applied in the envelope tenant only', () => {
    expect(schema['x-opt2-kind']).toBe('process');
    expect(schema['x-opt2-supersedes']).toBe(true);
    expect('x-opt2-tenant-fanout' in schema).toBe(false);
  });

  it('records the pinned source SHA', () => {
    expect(schema.$comment).toBe(`source-sha: ${pin.sha}`);
  });

  it('is the file the producer validates its outbox rows against', () => {
    expect(surveyScheduledSchema).toStrictEqual(schema);
  });

  it.each([
    ['the payload', schema, PAYLOAD_FIELDS],
    ['a reminder', itemSchema('reminders'), REMINDER_FIELDS],
    ['a target', itemSchema('targets'), TARGET_FIELDS],
  ] as const)('declares and requires exactly the fields of %s, and no others', (_label, node, fields) => {
    expect(sorted(Object.keys(node.properties ?? {}))).toStrictEqual(sorted(fields));
    expect(sorted(node.required ?? [])).toStrictEqual(sorted(fields));
    expect(node.additionalProperties).toBe(false);
  });
});

describe('surveys.survey.scheduled.v1 envelopes captured from fixture schedules', () => {
  let t: TestApp;
  let surveyId: string;
  let beforeSchedule: CapturedEnvelope[];
  let afterFirst: CapturedEnvelope[];
  let afterReschedule: CapturedEnvelope[];

  const scheduled = (): CapturedEnvelope[] =>
    t.publisher.published.filter(({ topic }) => topic === SURVEY_SCHEDULED_TOPIC).map(({ envelope }) => envelope);

  async function post(path: string, body: Record<string, unknown>): Promise<{ data: Record<string, unknown> }> {
    const res = await t.app.inject({
      method: 'POST',
      url: `${FIXTURE_BASE}${path}${SITE}`,
      headers: { ...(await headersFor('surveys.manager')), ...CSRF_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode, `POST ${path}: ${res.body}`).toBe(200);
    return res.json() as { data: Record<string, unknown> };
  }

  beforeAll(async () => {
    t = await buildTestApp();
    t.db.seedRegistry();
    const created = await post('', { title: 'Contract survey' });
    surveyId = String(created.data.survey_id);
    await post(`/${surveyId}/targets/bulk`, { targets: TARGETS });
    beforeSchedule = scheduled();
    await post(`/${surveyId}/schedule`, FIRST);
    afterFirst = scheduled();
    await post(`/${surveyId}/schedule`, RESCHEDULE);
    afterReschedule = scheduled();
  });

  afterAll(async () => {
    await t?.app.close();
  });

  const captured = (): [string, CapturedEnvelope][] => [
    ['first schedule', afterReschedule[0] as CapturedEnvelope],
    ['reschedule', afterReschedule[1] as CapturedEnvelope],
  ];

  it('publishes exactly one envelope per schedule request', () => {
    expect(beforeSchedule).toHaveLength(0);
    expect(afterFirst).toHaveLength(1);
    expect(afterReschedule).toHaveLength(2);
    expect(afterReschedule[0]).toStrictEqual(afterFirst[0]);
  });

  it('announces the reschedule at a higher aggregate and schedule version', () => {
    const [first, second] = afterReschedule.map(payloadOf);
    expect(payloadOf(afterFirst[0] as CapturedEnvelope).scheduleVersion).toBe(1);
    expect(afterReschedule[1]?.aggregateVersion).toBeGreaterThan(afterReschedule[0]?.aggregateVersion ?? Infinity);
    expect(second?.scheduleVersion).toBeGreaterThan(first?.scheduleVersion ?? Infinity);
  });

  it('captured envelopes validate against envelope and topic schema', () => {
    for (const [label, envelope] of captured()) {
      expect(() => assertEventMatches(envelopeSchema, schema, envelope), label).not.toThrow();
    }
  });

  it("names the survey schedule aggregate in the survey's tenant", () => {
    for (const [label, envelope] of captured()) {
      const payload = payloadOf(envelope);
      expect(envelope, label).toMatchObject({
        aggregateType: 'survey-schedule',
        aggregateId: surveyId,
        tenantId: TENANT_A.tenantId,
        producer: 'surveys',
      });
      expect(payload.surveyId, label).toBe(envelope.aggregateId);
      expect(payload.siteId, label).toBe(TENANT_A.siteId);
    }
  });

  it('carries the requested launch, reminders and targets', () => {
    for (const [request, envelope] of [
      [FIRST, afterReschedule[0]],
      [RESCHEDULE, afterReschedule[1]],
    ] as const) {
      const payload = payloadOf(envelope as CapturedEnvelope);
      expect(payload.launchAt).toBe(`${request.launchAt}.000`);
      expect(payload.reminders.map(({ n, offsetMinutes }) => ({ n, offsetMinutes }))).toStrictEqual(
        request.reminders.map(({ offsetMinutes }, index) => ({ n: index + 1, offsetMinutes })),
      );
      expect(payload.targets).toHaveLength(TARGETS.length);
      expect(payload.targets).toStrictEqual(
        expect.arrayContaining([
          { siteId: 'tenant-b', groupName: null },
          { siteId: 'umbrella', groupName: 'Staff' },
        ]),
      );
    }
  });

  it('names the launch and reminder tasks after the survey', () => {
    for (const [label, envelope] of captured()) {
      const payload = payloadOf(envelope);
      expect(payload.launchTaskName, label).toBe(`opt2-survey-${surveyId}-launch`);
      for (const reminder of payload.reminders) {
        expect(reminder.taskName, label).toBe(`opt2-survey-${surveyId}-reminder-${reminder.n}`);
      }
    }
  });

  it('requires every field the domain builds, at the root and in each item', () => {
    for (const [label, envelope] of captured()) {
      const payload = payloadOf(envelope);
      expect(sorted(Object.keys(payload)), label).toStrictEqual(sorted(schema.required ?? []));
      expect(payload.reminders.length, label).toBeGreaterThanOrEqual(2);
      for (const reminder of payload.reminders) {
        expect(sorted(Object.keys(reminder)), label).toStrictEqual(sorted(itemSchema('reminders').required ?? []));
      }
      for (const target of payload.targets) {
        expect(sorted(Object.keys(target)), label).toStrictEqual(sorted(itemSchema('targets').required ?? []));
      }
    }
  });

  it('an envelope without tenant fails validation', () => {
    const error = contractErrorOf(() => assertEventMatches(envelopeSchema, schema, withoutTenant(afterReschedule[0] as CapturedEnvelope)));
    expect(error.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining("'tenantId'") }));
  });

  it.each(PAYLOAD_FIELDS)('a payload without %s fails validation', (field) => {
    const envelope = withPayload(afterReschedule[0] as CapturedEnvelope, (payload) => {
      delete payload[field];
    });
    const error = contractErrorOf(() => assertEventMatches(envelopeSchema, schema, envelope));
    expect(error.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`'${field}'`) }));
  });

  it.each([
    ...REMINDER_FIELDS.map((field) => ['reminder', 'reminders', field] as const),
    ...TARGET_FIELDS.map((field) => ['target', 'targets', field] as const),
  ])('a %s without %s fails validation', (_item, list, field) => {
    const envelope = withPayload(afterReschedule[0] as CapturedEnvelope, (payload) => {
      delete (payload[list] as Record<string, unknown>[])[0]?.[field];
    });
    const error = contractErrorOf(() => assertEventMatches(envelopeSchema, schema, envelope));
    expect(error.errors).toContainEqual(expect.objectContaining({ message: expect.stringContaining(`'${field}'`) }));
  });
});
