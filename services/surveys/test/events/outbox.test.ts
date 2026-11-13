// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** `surveys.survey.scheduled.v1` outbox over a throwaway PostgreSQL schema: one row per schedule, in-request flush, sweep and chain. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventPublisher } from '@opt2/platform/events';
import { apiUnavailableResponse } from '@opt2/platform/legacy-compat';
import type { GateRequest } from '@opt2/platform/migration-kit';
import { flushAfterCommit, outboxRuntimeFor, outboxTable, rowFromDb, type OutboxRow } from '@opt2/platform/outbox';
import { CLOUD_TASKS_HEADERS, slotName, slotStartS, successorSlotS, type TaskWireBody } from '@opt2/platform/tasks';
import { withTenant } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  createCapturingPublisher,
  createThrowawaySchema,
  mintTasksInvokerToken,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { buildTestApp, createFakeTaskPort, headersFor, type TestApp } from '../helpers/app.js';
import { UNITS } from '../../src/repo/tables.js';

const SERVICE = 'surveys';
const TOPIC = 'surveys.survey.scheduled.v1';
const SWEEP_QUEUE = 'surveys-outbox-sweep';
const SWEEP_PATH = '/internal/v1/outbox/sweep';
const SWEEP_INTERVAL_S = 60;
// Surveys are created only through the fixture route: `/v1` has no create operation.
const FIXTURE_SURVEYS = '/legacy-fixtures/cfml/api.cfm/surveys/surveys';
const SITE_QUERY = `?siteid=${TENANT_A.siteId}`;
const CSRF_HEADERS = { 'x-csrf_token': 'OUTBOX-SUITE-TOKEN', 'x-csrf_token_expires': '260630130000000' };
const SCHEDULE_BODY = { launchAt: '2026-07-01T09:00:00', reminders: [{ offsetMinutes: 60 }] };
const GATE_HOLDER = 'surveys-outbox-events-suite';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_MISSING = !process.env.PG_HOST;
const SKIP_REASON = 'PG_HOST unset: PostgreSQL-backed event suite skipped';

/** A sweep chain task and the successor its delivery must secure first. */
interface ChainSlot {
  name: string;
  slotS: number;
  successorName: string;
  successorS: number;
}

/** One publish the wrapper let through, with whether the watched successor task was on the port at that moment. */
interface PublishRecord {
  eventId: string;
  successorPresent: boolean;
}

describe.skipIf(PG_MISSING)(`surveys outbox, in-request flush and sweep chain${PG_MISSING ? ` (${SKIP_REASON})` : ''}`, () => {
  const taskPort = createFakeTaskPort();
  const capture = createCapturingPublisher();
  const publishes: PublishRecord[] = [];
  let failPublish = false;
  let watchedSuccessor: string | undefined;
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];
  let nowS!: number;

  /** Whether the fake port holds the sweep chain task `name`. */
  const hasTask = (name: string): boolean => taskPort.tasks.some((task) => task.queue === SWEEP_QUEUE && task.name === name);

  /** Capturing publisher that rejects while `failPublish` is set, leaving committed rows unflushed as a killed process would. */
  const publisher: EventPublisher = {
    async publish(topic, envelope) {
      if (failPublish) throw new Error('publisher unavailable');
      publishes.push({ eventId: envelope.eventId, successorPresent: watchedSuccessor !== undefined && hasTask(watchedSuccessor) });
      return capture.publish(topic, envelope);
    },
    publishRaw: (topic, message) => capture.publishRaw(topic, message),
    close: () => capture.close(),
  };

  /** Topics `eventId` reached the publisher on, once per publish. */
  const publishedTopics = (eventId: string): string[] =>
    capture.published.filter((event) => event.envelope.eventId === eventId).map((event) => event.topic);

  /** The chain task `offset` slots after the clock's slot, with its successor. */
  function chainSlot(offset: number): ChainSlot {
    const slotS = slotStartS(nowS, SWEEP_INTERVAL_S) + offset * SWEEP_INTERVAL_S;
    const successorS = successorSlotS(slotS, nowS, SWEEP_INTERVAL_S);
    return { name: slotName(SWEEP_QUEUE, slotS), slotS, successorName: slotName(SWEEP_QUEUE, successorS), successorS };
  }

  /** POSTs `body` to the migration gate endpoint as the migration service. */
  async function gate(body: GateRequest) {
    return app.inject({ method: 'POST', url: '/internal/v1/migration/gate', headers: await headersFor('service:migration'), payload: body });
  }

  /** Creates a tenant-a survey through the fixture route, schedules it through `/v1`, and returns its id. */
  async function scheduleNewSurvey(title: string): Promise<string> {
    const manager = await headersFor('surveys.manager', { site: TENANT_A.siteId });
    const created = await app.inject({
      method: 'POST',
      url: `${FIXTURE_SURVEYS}${SITE_QUERY}`,
      headers: { ...manager, ...CSRF_HEADERS },
      payload: { title },
    });
    expect(created.statusCode).toBe(200);
    const surveyId = created.json<{ data: { survey_id: string } }>().data.survey_id;

    const scheduled = await app.inject({
      method: 'POST',
      url: `/v1/surveys/${surveyId}/schedule${SITE_QUERY}`,
      headers: manager,
      payload: SCHEDULE_BODY,
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json()).toMatchObject({ data: { surveyId } });
    return surveyId;
  }

  /** The survey's outbox rows in `seq` order, read under tenant-a's RLS. */
  async function outboxRows(surveyId: string): Promise<OutboxRow[]> {
    const { rows } = await withTenant(schema.app, TENANT_A.tenantId, (tx) =>
      tx.query(`SELECT * FROM ${outboxTable(schema.schema)} WHERE ordering_key = $1 ORDER BY seq`, [surveyId]),
    );
    return rows.map(rowFromDb);
  }

  /** The survey's one outbox row; fails the case when it has any other number. */
  async function onlyRow(surveyId: string): Promise<OutboxRow> {
    const rows = await outboxRows(surveyId);
    expect(rows).toHaveLength(1);
    return rows[0] as OutboxRow;
  }

  /** Schedules a survey while the publisher is down, so its row stays committed and unpublished; returns that row. */
  async function unflushedRow(title: string): Promise<OutboxRow> {
    failPublish = true;
    const surveyId = await scheduleNewSurvey(title);
    failPublish = false;
    const row = await onlyRow(surveyId);
    expect(row.publishedAt).toBeNull();
    expect(publishedTopics(row.eventId)).toEqual([]);
    return row;
  }

  /** Delivers chain task `slot` to the sweep route as the local Cloud Tasks adapter does. */
  async function sweep(slot: ChainSlot) {
    const body = { queue: SWEEP_QUEUE, name: slot.name, tenantId: null, payload: { slotStartS: slot.slotS } } satisfies TaskWireBody;
    return app.inject({
      method: 'POST',
      url: SWEEP_PATH,
      headers: {
        authorization: `Bearer ${await mintTasksInvokerToken({ audience: SERVICE })}`,
        [CLOUD_TASKS_HEADERS.taskName]: slot.name,
        [CLOUD_TASKS_HEADERS.queueName]: SWEEP_QUEUE,
      },
      payload: body,
    });
  }

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: SERVICE, migrationsDir: MIGRATIONS_DIR });
    const built = await buildTestApp({ db: schema.app, publisher, taskPort });
    app = built.app;
    nowS = Math.floor(built.clock.now().getTime() / 1000);

    const opening: GateRequest[] = [
      { op: 'close', units: [...UNITS], holderId: GATE_HOLDER, allowLegacy: true },
      { op: 'open', units: [...UNITS], holderId: GATE_HOLDER },
    ];
    for (const request of opening) {
      expect((await gate(request)).statusCode).toBe(200);
    }
    const status = (await gate({ op: 'status', units: [...UNITS] })).json<{ units: { state: string }[] }>();
    expect(status.units.map((unit) => unit.state)).toEqual(UNITS.map(() => 'open'));
  });

  afterEach(() => {
    failPublish = false;
    watchedSuccessor = undefined;
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  it('writes exactly one surveys.survey.scheduled.v1 outbox row per schedule request and publishes it in-request', async () => {
    const surveyId = await scheduleNewSurvey('In-request flush');

    const row = await onlyRow(surveyId);
    expect(row).toMatchObject({ topic: TOPIC, kind: 'process', tenantId: TENANT_A.tenantId });
    expect(row.envelope).toMatchObject({ eventId: row.eventId, tenantId: TENANT_A.tenantId, aggregateId: surveyId });
    expect(row.publishedAt).not.toBeNull();
    expect(publishedTopics(row.eventId)).toEqual([TOPIC]);
  });

  it('publishes an eventId once when flushAfterCommit repeats or a sweep follows the in-request flush', async () => {
    const surveyId = await scheduleNewSurvey('Repeated flush');
    const flushed = await onlyRow(surveyId);
    expect(publishedTopics(flushed.eventId)).toEqual([TOPIC]);

    const repeated = await flushAfterCommit(outboxRuntimeFor(schema.schema), TENANT_A.tenantId, [flushed.eventId]);
    const swept = await sweep(chainSlot(0));

    expect(repeated).toEqual({ published: 0, failed: 0, skipped: 0 });
    expect(swept.statusCode).toBe(200);
    expect(publishedTopics(flushed.eventId)).toEqual([TOPIC]);
    expect(await onlyRow(surveyId)).toEqual(flushed);
  });

  it('publishes a committed but unflushed row on the next sweep and stamps published_at', async () => {
    const unflushed = await unflushedRow('Unflushed');

    const res = await sweep(chainSlot(0));

    expect(res.statusCode).toBe(200);
    expect(publishedTopics(unflushed.eventId)).toEqual([TOPIC]);
    expect((await onlyRow(unflushed.orderingKey)).publishedAt).not.toBeNull();
  });

  it('creates the successor surveys-outbox-sweep task on the task port before answering 2xx', async () => {
    const chain = chainSlot(5);
    expect(chain.successorName).toBe(`${SWEEP_QUEUE}-${String(chain.slotS + SWEEP_INTERVAL_S)}`);
    expect(hasTask(chain.successorName)).toBe(false);
    const { eventId } = await unflushedRow('Successor first');
    watchedSuccessor = chain.successorName;

    const res = await sweep(chain);

    expect(res.statusCode).toBe(200);
    expect(publishes.filter((entry) => entry.eventId === eventId)).toEqual([{ eventId, successorPresent: true }]);
    expect(taskPort.tasks.filter((task) => task.name === chain.successorName)).toEqual([
      expect.objectContaining({
        queue: SWEEP_QUEUE,
        url: expect.stringMatching(/\/internal\/v1\/outbox\/sweep$/),
        scheduleTime: new Date(chain.successorS * 1000),
      }),
    ]);
  });

  it('answers the legacy 503 and publishes nothing when the successor task cannot be created, so the queue retries', async () => {
    const chain = chainSlot(10);
    const unflushed = await unflushedRow('Successor unavailable');
    const legacy503 = JSON.parse(apiUnavailableResponse().body) as { apiversion: string; error: unknown };

    const restore = taskPort.failCreate({ queue: SWEEP_QUEUE, name: chain.successorName });
    const refused = await sweep(chain).finally(restore);

    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ apiversion: legacy503.apiversion, error: legacy503.error });
    expect((await onlyRow(unflushed.orderingKey)).publishedAt).toBeNull();
    expect(publishedTopics(unflushed.eventId)).toEqual([]);
    expect(hasTask(chain.successorName)).toBe(false);

    const retried = await sweep(chain);

    expect(retried.statusCode).toBe(200);
    expect(hasTask(chain.successorName)).toBe(true);
    expect(publishedTopics(unflushed.eventId)).toEqual([TOPIC]);
    expect((await onlyRow(unflushed.orderingKey)).publishedAt).not.toBeNull();
  });
});
