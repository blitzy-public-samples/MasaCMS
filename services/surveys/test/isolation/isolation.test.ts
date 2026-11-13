// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Tenant isolation of the surveys schema, its survey-response grants and its site registry consumer against PostgreSQL. */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEAD_LETTER_REASON_ATTRIBUTE, dlqTopicName, type EventEnvelope } from '@opt2/platform/events';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, openGates } from '@opt2/platform/migration-kit';
import {
  SITE_CHANGED_TOPIC,
  withMetadata,
  withTenant,
  type SiteChangedPayload,
  type TenantDb,
  type TenantTx,
} from '@opt2/platform/tenancy';
import {
  PLATFORM_TABLE_GROUPS,
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createCapturingPublisher,
  createThrowawaySchema,
  defineIsolationSuite,
  expectPlatformTables,
  fixtureForTenant,
  pgAvailable,
  pushTo,
  registryPayloads,
  seedRegistry,
  testEnvelope,
  testPgConfig,
  withoutTenant,
  type PlatformTableGroup,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { SURVEY_RESPONSE_GRANT, applyBulkTarget } from '../../src/domain/bulk-target.js';
import { listResponsePage, submitResponse } from '../../src/domain/responses.js';
import { createSurvey, type DomainDeps } from '../../src/domain/surveys.js';
import { SITE_CHANGED_SUBSCRIPTION } from '../../src/events/consumers.js';
import { findGrantor } from '../../src/repo/grants.js';
import { createSurveysRepository, launchTaskName, reminderTaskName } from '../../src/repo/repository.js';
import {
  OWNED_TABLES,
  SURVEY,
  SURVEY_REMINDER,
  SURVEY_RESPONSE,
  SURVEY_SCHEDULE,
  SURVEY_TARGET,
  UNITS,
  type SurveyResponseRow,
} from '../../src/repo/tables.js';
import { TEST_CLOCK, buildTestApp } from '../helpers/app.js';

type Row = Record<string, unknown>;
type Placement = Pick<SurveyResponseRow, 'response_id' | 'tenant_id' | 'siteid' | 'respondentsiteid'>;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_CONFIGURED = Boolean(process.env.PG_HOST);
const GATE_HOLDER = 'surveys-isolation-setup';
const ANSWERS = '{"q1":"yes"}';
const ALL_PLATFORM_GROUPS = Object.keys(PLATFORM_TABLE_GROUPS) as PlatformTableGroup[];
const TENANT_TABLES = [
  ...OWNED_TABLES.map(({ table }) => table),
  ...ALL_PLATFORM_GROUPS.flatMap((group) => PLATFORM_TABLE_GROUPS[group].tenantOwned),
];

const publisher = createCapturingPublisher();
let schema: ThrowawaySchema | undefined;
let ctx: AppContext | undefined;
let deps: DomainDeps | undefined;
let grantSurveyId: string | undefined;

/** Builds the surveys app over `db` with the suite's capturing publisher. */
function startApp(db: TenantDb) {
  return buildTestApp({ db, publisher });
}

type AppContext = Awaited<ReturnType<typeof startApp>>;

/** Returns `value`; throws naming `what` when the beforeAll that sets it failed. */
function setUp<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The ${what} was not set up; see the beforeAll failure`);
  }
  return value;
}

const created = (): ThrowawaySchema => setUp(schema, 'throwaway surveys schema');
const running = (): AppContext => setUp(ctx, 'surveys app');
const domain = (): DomainDeps => setUp(deps, 'surveys domain');
const grantSurvey = (): string => setUp(grantSurveyId, 'tenant A grant survey');

/** SHA-256 hex digest of a fresh UUID, shaped like a stored task-token hash. */
function tokenHash(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

// Probe outbox rows are already published and probe tasks done, so no sweep or dispatcher acts on them.
const ROW_BUILDERS: Readonly<Record<string, (tenant: TenantFixture) => Row>> = {
  [SURVEY.table]: (tenant) => ({
    survey_id: cfUuid(),
    siteid: tenant.siteId,
    title: `Isolation survey ${tenant.key}`,
    status: 'DRAFT',
    created: TEST_CLOCK.now(),
    createdbyid: cfUuid(),
  }),
  [SURVEY_SCHEDULE.table]: () => {
    const surveyId = cfUuid();
    return {
      schedule_id: cfUuid(),
      survey_id: surveyId,
      launch_at: TEST_CLOCK.now(),
      schedule_version: 1,
      task_name: launchTaskName(surveyId),
      task_token_hash: tokenHash(),
      created: TEST_CLOCK.now(),
    };
  },
  [SURVEY_REMINDER.table]: () => {
    const surveyId = cfUuid();
    return {
      reminder_id: cfUuid(),
      survey_id: surveyId,
      offset_minutes: 60,
      remind_at: TEST_CLOCK.now(),
      task_name: reminderTaskName(surveyId, 1),
      task_token_hash: tokenHash(),
    };
  },
  [SURVEY_TARGET.table]: (tenant) => ({
    target_id: cfUuid(),
    survey_id: cfUuid(),
    siteid: tenant.siteId,
    group_name: null,
    created: TEST_CLOCK.now(),
  }),
  [SURVEY_RESPONSE.table]: (tenant) => ({
    response_id: cfUuid(),
    survey_id: cfUuid(),
    siteid: tenant.siteId,
    respondentsiteid: tenant.siteId,
    respondent_user_id: cfUuid(),
    answers: ANSWERS,
    created: TEST_CLOCK.now(),
  }),
  outbox: () => ({
    event_id: randomUUID(),
    topic: 'surveys.survey.scheduled.v1',
    kind: 'process',
    ordering_key: cfUuid(),
    envelope: '{}',
    created_at: TEST_CLOCK.now(),
    published_at: TEST_CLOCK.now(),
  }),
  inbox: () => ({ event_id: randomUUID(), subscription: SITE_CHANGED_SUBSCRIPTION, status: 'applied' }),
  consumer_aggregate_version: () => ({
    subscription: SITE_CHANGED_SUBSCRIPTION,
    aggregate_type: 'site',
    aggregate_id: `isolation-${randomUUID()}`,
    last_version: 1,
  }),
  changelog: () => ({ table: SURVEY.table, op: 'insert', key: cfUuid(), after: 's0:', origin: 'target' }),
  migration_batch: () => ({ batch_id: randomUUID(), legacy_table: 'synthetic.survey', origin: 'backfill', row_count: 1 }),
  scheduled_task_queue: () => ({
    queue: 'surveys-launch',
    name: `isolation-${randomUUID()}`,
    schedule_time: TEST_CLOCK.now(),
    url: 'http://127.0.0.1:8117/internal/v1/tasks/isolation',
    body: '{}',
    deadline_s: 600,
    status: 'done',
    created_at: TEST_CLOCK.now(),
    updated_at: TEST_CLOCK.now(),
  }),
  scheduled_task_queue_state: () => ({ queue: `isolation-${randomUUID()}`, updated_at: TEST_CLOCK.now() }),
};

/** A fresh `table` row of `tenant`, without `tenant_id`, that meets every constraint of the table. */
function rowFor(table: string, tenant: TenantFixture): Row {
  const build = ROW_BUILDERS[table];
  if (build === undefined) {
    throw new TypeError(`The surveys isolation suite has no row builder for table ${table}`);
  }
  return build(tenant);
}

/** Inserts a fresh `table` row of `tenant` under the tenant of `tx`. */
async function writeAs(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row: Row = { tenant_id: tx.tenantId, ...rowFor(table, tenant) };
  const columns = Object.keys(row);
  const names = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map((_, index) => `$${String(index + 1)}`).join(', ');
  await tx.query(`INSERT INTO "${tx.schema}"."${table}" (${names}) VALUES (${placeholders})`, Object.values(row));
}

/** Every row of `table` visible in `tx`. */
async function readAs(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT * FROM "${tx.schema}"."${table}"`)).rows;
}

/** A contract-valid site.changed envelope re-announcing the fixture site of `tenantId` at version 2 with one more domain. */
function siteChangedEnvelope(tenantId: string): EventEnvelope<SiteChangedPayload> {
  const fixture = fixtureForTenant(tenantId);
  const payload = registryPayloads().find((entry) => entry.siteId === fixture?.siteId);
  if (fixture === undefined || payload === undefined) {
    throw new TypeError(`No fixture site has tenant ${tenantId}`);
  }
  return testEnvelope({
    topic: SITE_CHANGED_TOPIC,
    tenantId,
    aggregateId: fixture.siteId,
    aggregateVersion: 2,
    payload: { ...payload, domains: [...(payload.domains ?? []), `isolation.${fixture.siteId}.opt2.test`] },
  });
}

/** Whether `err` is the fixture's unknown-survey error. */
function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.name === 'FixtureApiError' && (err as { type?: unknown }).type === 'notFound';
}

/** Submits a response to `surveyId` as a respondent of `acting`: 'allowed' once stored, 'denied' on the fixture's notFound. */
async function respondAs(acting: TenantFixture, surveyId: string): Promise<'allowed' | 'denied'> {
  try {
    await submitResponse(domain(), {
      tenantId: acting.tenantId,
      site: acting.siteId,
      userId: cfUuid(),
      surveyId,
      input: { answers: ANSWERS },
    });
    return 'allowed';
  } catch (err) {
    if (isNotFound(err)) {
      return 'denied';
    }
    throw err;
  }
}

/** The responses to `surveyId` visible to `tenant`, by response id. */
function responsesOf(tenant: TenantFixture, surveyId: string): Promise<Placement[]> {
  return withTenant(created().app, tenant.tenantId, async (tx) => {
    const { rows } = await tx.query<Placement>(
      `SELECT response_id, tenant_id, siteid, respondentsiteid
         FROM "${tx.schema}"."${SURVEY_RESPONSE.table}" WHERE survey_id = $1 ORDER BY response_id`,
      [surveyId],
    );
    return rows;
  });
}

/** Every `tenant_registry` row, by site id. */
async function registrySnapshot(): Promise<Row[]> {
  return withMetadata(created().app, async (tx) => (await tx.query(`SELECT * FROM "${tx.schema}".tenant_registry ORDER BY site_id`)).rows);
}

describe('surveys: tenant isolation', () => {
  if (!PG_CONFIGURED) {
    it.skip('PG_HOST unset - PostgreSQL isolation suite skipped');
    return;
  }

  beforeAll(async () => {
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`PG_HOST is set but PostgreSQL at ${host}:${String(port)} is unreachable; the isolation suite cannot run`);
    }
    schema = await createThrowawaySchema({ service: 'surveys', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ctx = await startApp(schema.app);
    // The app's onReady inserts every missing gate as `legacy`; a transition makes a unit authoritative by closing and reopening it.
    await closeGates(schema.app, { units: UNITS, holderId: GATE_HOLDER, allowLegacy: true });
    await openGates(schema.app, { units: UNITS, holderId: GATE_HOLDER });
    deps = { db: schema.app, repository: createSurveysRepository({ clock: TEST_CLOCK, schema: schema.schema }), clock: TEST_CLOCK };
    const detail = await createSurvey(deps, {
      tenantId: TENANT_A.tenantId,
      siteId: TENANT_A.siteId,
      userId: cfUuid(),
      input: { title: 'Isolation grant survey' },
    });
    grantSurveyId = detail.survey.survey_id;
  }, 60_000);

  afterAll(async () => {
    try {
      await ctx?.app.close();
    } finally {
      await schema?.drop();
    }
  });

  it('creates the outbox, event, migration-kit, task and tenancy tables with RLS forced on the tenant-owned ones', async () => {
    await expectPlatformTables(created(), { groups: ALL_PLATFORM_GROUPS });
  });

  // The shared suite also asserts the catalog (forced RLS with USING and WITH CHECK on every tenant table, no schema role
  // that is or inherits SUPERUSER or BYPASSRLS) and pooled-connection reuse for every table listed here.
  defineIsolationSuite(
    { describe, it, expect, beforeAll },
    {
      db: () => schema,
      name: 'surveys tenant tables',
      tables: TENANT_TABLES,
      writeAs,
      readAs,
      rowFor,
      event: {
        app: () => ctx?.app,
        subscription: SITE_CHANGED_SUBSCRIPTION,
        envelopeFor: siteChangedEnvelope,
        publisher,
      },
      grant: {
        kind: SURVEY_RESPONSE_GRANT,
        get resourceId(): string {
          return grantSurvey();
        },
        // Bulk targeting opens its own gated transaction; `tx` names the grantor tenant it runs as.
        grant: async (tx, grantee) => {
          await applyBulkTarget(domain(), { tenantId: tx.tenantId, surveyId: grantSurvey(), input: [{ siteID: grantee.siteId }] });
        },
        guardedWrite: (_grantor, acting) => respondAs(acting, grantSurvey()),
      },
    },
  );

  describe('survey responses across sites', () => {
    let surveyId: string | undefined;
    const targeted = (): string => setUp(surveyId, 'tenant A survey targeting tenant B');

    beforeAll(async () => {
      const detail = await createSurvey(domain(), {
        tenantId: TENANT_A.tenantId,
        siteId: TENANT_A.siteId,
        userId: cfUuid(),
        input: { title: 'Multi-site isolation survey' },
      });
      surveyId = detail.survey.survey_id;
      await applyBulkTarget(domain(), { tenantId: TENANT_A.tenantId, surveyId, input: [{ siteID: TENANT_B.siteId }] });
    });

    it('records tenant A as the grantor of the tenant B grant and grants tenant umbrella nothing', async () => {
      const grant = { kind: SURVEY_RESPONSE_GRANT, resourceId: targeted() };
      expect(await findGrantor(created().app, { ...grant, grantee: TENANT_B.tenantId })).toBe(TENANT_A.tenantId);
      expect(await findGrantor(created().app, { ...grant, grantee: TENANT_UMBRELLA.tenantId })).toBeNull();
    });

    it('stores a tenant B response under tenant A with the survey site and the respondent site, invisible to B and umbrella', async () => {
      const id = targeted();
      const before = await responsesOf(TENANT_A, id);
      const stored = await submitResponse(domain(), {
        tenantId: TENANT_B.tenantId,
        site: TENANT_B.siteId,
        userId: cfUuid(),
        surveyId: id,
        input: { answers: ANSWERS },
      });
      const after = await responsesOf(TENANT_A, id);
      expect(after.filter((row) => !before.some((earlier) => earlier.response_id === row.response_id))).toEqual([
        { response_id: stored.response_id, tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, respondentsiteid: TENANT_B.siteId },
      ]);
      expect(await responsesOf(TENANT_B, id)).toEqual([]);
      expect(await responsesOf(TENANT_UMBRELLA, id)).toEqual([]);
    });

    it('answers notFound to a tenant umbrella respondent and stores nothing', async () => {
      const id = targeted();
      const before = await responsesOf(TENANT_A, id);
      await expect(
        submitResponse(domain(), {
          tenantId: TENANT_UMBRELLA.tenantId,
          site: TENANT_UMBRELLA.siteId,
          userId: cfUuid(),
          surveyId: id,
          input: { answers: ANSWERS },
        }),
      ).rejects.toMatchObject({ name: 'FixtureApiError', type: 'notFound' });
      expect(await responsesOf(TENANT_A, id)).toEqual(before);
      expect(await responsesOf(TENANT_UMBRELLA, id)).toEqual([]);
    });

    it.each([TENANT_B, TENANT_UMBRELLA])('answers notFound when tenant $key lists the responses of the tenant A survey', async (tenant) => {
      await expect(
        listResponsePage(domain(), { tenantId: tenant.tenantId, surveyId: targeted(), params: {} }),
      ).rejects.toMatchObject({ name: 'FixtureApiError', type: 'notFound' });
    });
  });

  it('acks a tenantless site.changed delivery with 204, dead-letters it once as missing-tenant and leaves the registry unchanged', async () => {
    const before = await registrySnapshot();
    publisher.clear();
    const envelope = withoutTenant(siteChangedEnvelope(TENANT_B.tenantId));

    const response = await pushTo(running().app, SITE_CHANGED_SUBSCRIPTION, envelope);

    expect(response.statusCode).toBe(204);
    expect(publisher.raw.map(({ topic, message }) => ({ topic, reason: message.attributes[DEAD_LETTER_REASON_ATTRIBUTE] }))).toEqual([
      { topic: dlqTopicName(SITE_CHANGED_SUBSCRIPTION), reason: 'missing-tenant' },
    ]);
    expect(publisher.published).toEqual([]);
    expect(await registrySnapshot()).toEqual(before);
  });
});
