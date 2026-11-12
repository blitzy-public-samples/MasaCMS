// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Consumer bindings of the login-mail and survey-scheduled topics against the producers' contracts, and the reminder task route's wiring. */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { topicMeta, type ConsumerDefinition, type TopicMeta } from '@opt2/platform/events';
import type { Logger } from '@opt2/platform/logging';
import type { FastifyInstance, FastifyRequest, FastifyReply, ServiceClient } from '@opt2/platform/service-kit';
import { TaskTenantMismatchError, registerTaskRoute, type TaskContext, type TaskRouteOptions } from '@opt2/platform/tasks';
import type { TenantDb, TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, fixedClock } from '@opt2/platform/testing';
import type { MailDeps } from '../../src/domain/delivery.js';
import { applyLoginMail } from '../../src/domain/login-mail.js';
import { performReminder, type ReminderResult } from '../../src/domain/reminders.js';
import { applySurveyScheduled, type SurveyScheduleDeps } from '../../src/domain/survey-schedule.js';
import { LOGIN_MAIL_TOPIC, loginMailConsumer, loginMailSchema } from '../../src/events/login-mail.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledConsumer, surveyScheduledSchema } from '../../src/events/survey-scheduled.js';
import { findScheduledTask } from '../../src/repo/queries.js';
import type { CommunicationsRepository } from '../../src/repo/repository.js';
import type { ScheduledTaskRow } from '../../src/repo/tables.js';
import { REMINDER_TASK_PATH, registerReminderTaskRoute } from '../../src/tasks/reminder.js';

vi.mock('../../src/domain/login-mail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/login-mail.js')>();
  return { ...actual, applyLoginMail: vi.fn(actual.applyLoginMail) };
});

vi.mock('../../src/domain/survey-schedule.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/survey-schedule.js')>();
  return { ...actual, applySurveyScheduled: vi.fn(actual.applySurveyScheduled) };
});

vi.mock('@opt2/platform/tasks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@opt2/platform/tasks')>()),
  registerTaskRoute: vi.fn(),
}));

vi.mock('../../src/repo/queries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/repo/queries.js')>()),
  findScheduledTask: vi.fn(),
}));

vi.mock('../../src/domain/reminders.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/domain/reminders.js')>()),
  performReminder: vi.fn(),
}));

/** The mock surface `lastBinding` reads from a wrapped domain `apply` factory. */
interface DomainFactoryMock {
  mock: { lastCall?: unknown[] | undefined; results: Array<{ value: unknown }> };
}

interface Binding {
  label: string;
  producer: string;
  topic: string;
  expectedTopic: string;
  schema: object;
  meta: TopicMeta;
  keys: string[];
  define: (deps: object) => ConsumerDefinition;
  domain: DomainFactoryMock;
}

/** Deps and returned effect of the latest call to a domain `apply` factory. */
function lastBinding(domain: DomainFactoryMock): { deps: unknown; apply: unknown } {
  return { deps: domain.mock.lastCall?.[0], apply: domain.mock.results.at(-1)?.value };
}

const BINDINGS: Binding[] = [
  {
    label: 'login-mail',
    producer: 'identity',
    topic: LOGIN_MAIL_TOPIC,
    expectedTopic: 'identity.login-mail.requested.v1',
    schema: loginMailSchema,
    meta: { kind: 'process' },
    keys: ['apply', 'kind', 'topic'],
    define: (deps) => loginMailConsumer(deps as MailDeps),
    domain: vi.mocked(applyLoginMail),
  },
  {
    label: 'survey-scheduled',
    producer: 'surveys',
    topic: SURVEY_SCHEDULED_TOPIC,
    expectedTopic: 'surveys.survey.scheduled.v1',
    schema: surveyScheduledSchema,
    meta: { kind: 'process', supersedes: true },
    keys: ['apply', 'kind', 'supersedes', 'topic'],
    define: (deps) => surveyScheduledConsumer(deps as SurveyScheduleDeps),
    domain: vi.mocked(applySurveyScheduled),
  },
];

describe.each(BINDINGS)('$label consumer definition', ({ label, producer, topic, expectedTopic, schema, meta, keys, define, domain }) => {
  it('names the producer topic', () => {
    expect(topic).toBe(expectedTopic);
  });

  it("loads the producer's contract schema for the topic", () => {
    const contract = new URL(`../../../${producer}/contracts/events/${expectedTopic}.json`, import.meta.url);
    expect(schema).toEqual(JSON.parse(readFileSync(contract, 'utf8')));
    expect(schema).toHaveProperty('$id', `urn:opt2:${producer}:event:${expectedTopic}`);
  });

  it("declares exactly the schema's x-opt2 kind, supersedes and fan-out, with no tenant re-check override", () => {
    const definition = define({ label });
    const declared = Object.fromEntries(Object.entries(definition).filter(([key]) => key !== 'topic' && key !== 'apply'));
    expect(topicMeta(schema)).toEqual(meta);
    expect(declared).toEqual(topicMeta(schema));
    expect(definition.topic).toBe(expectedTopic);
    expect(Object.keys(definition).sort()).toEqual(keys);
    expect(definition).not.toHaveProperty('checkTenant');
    expect(definition).not.toHaveProperty('fanout');
  });

  it("applies the domain effect bound to the consumer's deps", () => {
    const deps = { label };
    const definition = define(deps);
    const bound = lastBinding(domain);
    expect(bound.deps).toBe(deps);
    expect(bound.apply).toBeTypeOf('function');
    expect(definition).toHaveProperty('apply', bound.apply);
  });
});

const SURVEY_ID = '11111111-2222-3333-4444555566667777';
const OTHER_SURVEY_ID = '99999999-2222-3333-4444555566667777';
const TASK_ID = '00000012-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const OTHER_TASK_ID = '00000013-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const TASK_NAME = `opt2-survey-${SURVEY_ID}-reminder-2-v3`;
const PAYLOAD = { scheduledTaskId: TASK_ID, surveyId: SURVEY_ID, n: 2, scheduleVersion: 3 };
const RESULT: ReminderResult = { status: 'sent' };
const T0 = new Date(2026, 5, 29, 8, 0, 0);

const db = { schema: 'communications' } as unknown as TenantDb;
const repository = {} as CommunicationsRepository;
const clock = fixedClock('2026-06-30T09:15:00');
const tx = { tenantId: TENANT_A.tenantId, schema: 'communications' } as unknown as TenantTx;
const appLogger = { owner: 'app' } as unknown as Logger;
const appClient = { owner: 'app' } as unknown as ServiceClient;
const ownLogger = { owner: 'options' } as unknown as Logger;
const ownClient = { owner: 'options' } as unknown as ServiceClient;
const app = { opt2: { logger: appLogger, client: appClient } } as unknown as FastifyInstance;

/** A `scheduled` reminder 2 of schedule version 3 in tenant-a, unless overridden. */
function reminderRow(overrides: Partial<ScheduledTaskRow> = {}): ScheduledTaskRow {
  return {
    tenant_id: TENANT_A.tenantId,
    scheduled_task_id: TASK_ID,
    task_name: `opt2-survey-${SURVEY_ID}-reminder-2`,
    queue: 'communications-reminders',
    queue_task_name: TASK_NAME,
    kind: 'survey-reminder',
    source_type: 'survey',
    source_id: SURVEY_ID,
    reminder_n: 2,
    schedule_time: new Date(2026, 5, 30, 9, 15, 0),
    status: 'scheduled',
    target_route: `/internal/v1/tasks/reminders/${TASK_ID}`,
    schedule_version: 3,
    origin: 'event',
    enqueued_at: T0,
    dequeued_at: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

/** Registers the route on the fake app and returns the options it passed to `registerTaskRoute`. */
function registered(options: { logger?: Logger; client?: ServiceClient } = {}): Extract<TaskRouteOptions, { scope: 'tenant' }> {
  registerReminderTaskRoute(app, { db, repository, clock, ...options });
  const call = vi.mocked(registerTaskRoute).mock.lastCall;
  if (call === undefined) throw new Error('registerTaskRoute was not called');
  const [onApp, path, routeOptions] = call;
  expect(onApp).toBe(app);
  expect(path).toBe(REMINDER_TASK_PATH);
  if (routeOptions.scope !== 'tenant') throw new Error(`expected a tenant-scoped task route, got ${routeOptions.scope}`);
  return routeOptions;
}

/** Task context of a delivery to `/internal/v1/tasks/reminders/<pathId>` carrying `stored`. */
function taskContext(pathId: string | undefined, stored: ScheduledTaskRow | undefined): TaskContext<ScheduledTaskRow> {
  return {
    queue: 'communications-reminders',
    taskName: TASK_NAME,
    retryCount: 0,
    executionCount: 0,
    tenantId: TENANT_A.tenantId,
    payload: PAYLOAD,
    stored,
    request: { params: pathId === undefined ? {} : { scheduledTaskId: pathId } } as unknown as FastifyRequest,
    reply: {} as FastifyReply,
  };
}

describe('reminder task route', () => {
  beforeEach(() => {
    vi.mocked(registerTaskRoute).mockClear();
    vi.mocked(findScheduledTask).mockReset();
    vi.mocked(performReminder).mockReset();
  });

  it("is the communications-reminders queue's target path in Fastify form", () => {
    expect(REMINDER_TASK_PATH).toBe('/internal/v1/tasks/reminders/:scheduledTaskId');
  });

  it('registers a tenant-scoped task route on the given database', () => {
    const options = registered();
    expect(options.scope).toBe('tenant');
    expect(options.db).toBe(db);
  });

  it.each([
    ['a non-object payload', null],
    ['an empty payload', {}],
    ['an empty task id', { ...PAYLOAD, scheduledTaskId: '' }],
    ['an empty survey id', { ...PAYLOAD, surveyId: '' }],
    ['a zero ordinal', { ...PAYLOAD, n: 0 }],
    ['a fractional ordinal', { ...PAYLOAD, n: 1.5 }],
    ['a string ordinal', { ...PAYLOAD, n: '2' }],
    ['a zero schedule version', { ...PAYLOAD, scheduleVersion: 0 }],
  ])('finds no stored reminder for %s without reading', async (_label, payload) => {
    const { findStored } = registered();
    await expect(findStored(tx, payload, { taskName: TASK_NAME, queue: 'communications-reminders' })).resolves.toBeNull();
    expect(findScheduledTask).not.toHaveBeenCalled();
  });

  it.each([
    ['no row to null', null, null],
    ['a launch row to null', reminderRow({ kind: 'survey-launch', reminder_n: null }), null],
    ["another survey's reminder to null", reminderRow({ source_id: OTHER_SURVEY_ID }), null],
    ["the payload survey's reminder to that row", reminderRow(), reminderRow()],
  ])('reads the payload task id and resolves %s', async (_label, row, expected) => {
    vi.mocked(findScheduledTask).mockResolvedValue(row);
    const { findStored } = registered();
    await expect(findStored(tx, PAYLOAD, { taskName: TASK_NAME, queue: 'communications-reminders' })).resolves.toEqual(expected);
    expect(findScheduledTask).toHaveBeenCalledExactlyOnceWith(tx, TASK_ID);
  });

  it.each([
    ['no stored row', TASK_ID, undefined],
    ['a path naming another task', OTHER_TASK_ID, reminderRow()],
    ['a path without a task id', undefined, reminderRow()],
  ])('refuses %s as a tenant mismatch without running the reminder', async (_label, pathId, stored) => {
    const { handler } = registered();
    const refused = handler(taskContext(pathId, stored));
    await expect(refused).rejects.toBeInstanceOf(TaskTenantMismatchError);
    await expect(refused).rejects.toMatchObject({ tenantId: TENANT_A.tenantId, taskName: TASK_NAME });
    expect(performReminder).not.toHaveBeenCalled();
  });

  it.each([
    ["the service's own", {}, appLogger, appClient],
    ['the given', { logger: ownLogger, client: ownClient }, ownLogger, ownClient],
  ])('runs the stored reminder with %s logger and client and answers its result', async (_label, options, logger, client) => {
    vi.mocked(performReminder).mockResolvedValue(RESULT);
    const stored = reminderRow();
    const { handler } = registered(options);
    await expect(handler(taskContext(TASK_ID, stored))).resolves.toEqual(RESULT);
    expect(performReminder).toHaveBeenCalledExactlyOnceWith({ db, repository, clock, logger, client }, stored);
  });
});
