// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey scheduling against a throwaway `surveys` schema: fixture validation and state rules, versions, reminders and the outbox row. */
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GateRaceError, UnitNotAuthoritativeError, ensureUnitGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata } from '@opt2/platform/tenancy';
import { fixedClock } from '@opt2/platform/service-kit';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { createLogger } from '@opt2/platform/logging';
import { createOutbox, resetOutboxRuntimes } from '@opt2/platform/outbox';
import {
  assertEventMatches,
  createCapturingPublisher,
  createThrowawaySchema,
  pgAvailable,
  type CapturingPublisher,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { launchTaskName, reminderTaskName, scheduleSurvey, type ScheduleInput } from '../../src/domain/schedule.js';
import { SURVEY_STATUS, createSurvey, type DomainDeps, type SurveyStatus } from '../../src/domain/surveys.js';
import { SURVEY_SCHEDULED_TOPIC, surveyScheduledSchema, surveyScheduledValidator } from '../../src/events/survey-scheduled.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0, 123);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const LAUNCH = '2026-07-01T09:30:00';
const TOKEN_HASH = /^[0-9a-f]{64}$/;

describe('schedule task names', () => {
  it('are the fixture names opt2-survey-<id>-launch and opt2-survey-<id>-reminder-<n>', () => {
    expect(launchTaskName('6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9')).toBe('opt2-survey-6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9-launch');
    expect(reminderTaskName('6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9', 3)).toBe('opt2-survey-6A1B2C3D-4E5F-6071-8293A4B5C6D7E8F9-reminder-3');
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('scheduleSurvey against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: DomainDeps;
  let publisher: CapturingPublisher;
  let sites = 0;
  let siteA: string;
  let tenantA: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    const clock = fixedClock(T0);
    deps = { db: handle.app, repository: createSurveysRepository({ clock, schema: handle.schema }), clock };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    publisher = createCapturingPublisher();
    createOutbox({
      service: 'surveys',
      db: handle.app,
      publisher,
      logger: createLogger({ service: 'surveys', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
      clock: fixedClock(T0),
      payloadValidators: { [SURVEY_SCHEDULED_TOPIC]: surveyScheduledValidator },
    });
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    sites += 1;
    siteA = `surveys-schedule-a-${sites}`;
    tenantA = tenantIdForSite(siteA);
  });

  afterEach(() => {
    resetOutboxRuntimes();
  });

  async function newSurvey(status?: SurveyStatus): Promise<string> {
    const { survey } = await createSurvey(deps, { tenantId: tenantA, siteId: siteA, userId: USER_ID, input: { title: 'Pulse' } });
    if (status !== undefined) {
      await handle.app.withTenant(tenantA, (tx) => deps.repository.setSurveyStatus(tx, survey.survey_id, status));
    }
    return survey.survey_id;
  }

  function schedule(surveyId: string, input: ScheduleInput, against: DomainDeps = deps) {
    return scheduleSurvey(against, { tenantId: tenantA, surveyId, input });
  }

  /** Rows of `sql` in tenant A, with `$S` standing for the throwaway schema. */
  function rows<R>(sql: string, values: unknown[] = []): Promise<R[]> {
    return handle.app.withTenant(tenantA, async (tx) => (await tx.query(sql.replaceAll('$S', handle.schema), values)).rows as R[]);
  }

  function scheduledOutbox() {
    return rows<{ envelope: Record<string, unknown>; published_at: Date | null }>(
      `SELECT envelope, published_at FROM $S.outbox WHERE topic = '${SURVEY_SCHEDULED_TOPIC}' ORDER BY seq`,
    );
  }

  it('first schedule stores version 1 with its reminders, marks the survey SCHEDULED and publishes one event', async () => {
    const id = await newSurvey();
    await handle.app.withTenant(tenantA, (tx) =>
      deps.repository.insertTargets(tx, id, [
        { siteId: siteA, groupName: 'Panel' },
        { siteId: 'tenant-b', groupName: null },
      ]),
    );

    const detail = await schedule(id, { launchAt: LAUNCH, reminders: [{ offsetMinutes: 60 }, { offsetMinutes: '1440' }] });

    expect(detail.survey.status).toBe(SURVEY_STATUS.SCHEDULED);
    expect(Object.keys(detail.schedule ?? {})).toEqual(['schedule_id', 'survey_id', 'launch_at', 'schedule_version', 'task_name', 'created']);
    expect(detail.schedule).toMatchObject({
      survey_id: id,
      launch_at: new Date(2026, 6, 1, 9, 30),
      schedule_version: 1,
      task_name: launchTaskName(id),
      created: T0,
    });
    expect(detail.reminders.map(({ task_name, offset_minutes, remind_at, sent_at }) => ({ task_name, offset_minutes, remind_at, sent_at }))).toEqual([
      { task_name: reminderTaskName(id, 1), offset_minutes: 60, remind_at: new Date(2026, 6, 1, 10, 30), sent_at: null },
      { task_name: reminderTaskName(id, 2), offset_minutes: 1440, remind_at: new Date(2026, 6, 2, 9, 30), sent_at: null },
    ]);
    expect(detail.targets).toHaveLength(2);

    const [stored] = await rows<{ row_version: string; task_token_hash: string }>('SELECT * FROM $S.survey_schedule WHERE survey_id = $1', [id]);
    expect(stored?.row_version).toBe('1');
    expect(stored?.task_token_hash).toMatch(TOKEN_HASH);
    const reminderHashes = await rows<{ task_token_hash: string }>('SELECT task_token_hash FROM $S.survey_reminder WHERE survey_id = $1', [id]);
    expect(reminderHashes).toEqual([{ task_token_hash: stored?.task_token_hash }, { task_token_hash: stored?.task_token_hash }]);

    const outbox = await scheduledOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.published_at).not.toBeNull();
    expect(outbox[0]?.envelope).toMatchObject({ aggregateType: 'survey-schedule', aggregateId: id, aggregateVersion: 1, tenantId: tenantA });
    expect(outbox[0]?.envelope['payload']).toStrictEqual({
      surveyId: id,
      siteId: siteA,
      scheduleVersion: 1,
      launchAt: '2026-07-01T09:30:00.000',
      launchTaskName: `opt2-survey-${id}-launch`,
      reminders: [
        { n: 1, offsetMinutes: 60, taskName: `opt2-survey-${id}-reminder-1` },
        { n: 2, offsetMinutes: 1440, taskName: `opt2-survey-${id}-reminder-2` },
      ],
      targets: [
        { siteId: siteA, groupName: 'Panel' },
        { siteId: 'tenant-b', groupName: null },
      ],
    });
    const published = publisher.published.filter((event) => event.topic === SURVEY_SCHEDULED_TOPIC);
    expect(published).toHaveLength(1);
    expect(() => assertEventMatches(undefined, surveyScheduledSchema, published[0]?.envelope)).not.toThrow();
  });

  it('reschedule bumps both versions, keeps created, replaces the reminders and writes a second event', async () => {
    const id = await newSurvey();
    await schedule(id, { launchAt: LAUNCH, reminders: [{ offsetMinutes: 60 }, { offsetMinutes: 120 }] });

    const detail = await schedule(id, { launchAt: '2026-08-01T10:00:00', reminders: '[{"offsetMinutes":5}]' });

    expect(detail.schedule).toMatchObject({ schedule_version: 2, launch_at: new Date(2026, 7, 1, 10, 0), created: T0 });
    expect(detail.reminders.map((reminder) => reminder.task_name)).toEqual([reminderTaskName(id, 1)]);
    expect(await rows('SELECT row_version FROM $S.survey_schedule WHERE survey_id = $1', [id])).toEqual([{ row_version: '2' }]);
    const events = (await scheduledOutbox()).map(({ envelope }) => envelope as { aggregateVersion: number; payload: Record<string, unknown> });
    expect(events.map(({ aggregateVersion, payload }) => [aggregateVersion, payload['scheduleVersion'], payload['reminders']])).toEqual([
      [1, 1, [
        { n: 1, offsetMinutes: 60, taskName: reminderTaskName(id, 1) },
        { n: 2, offsetMinutes: 120, taskName: reminderTaskName(id, 2) },
      ]],
      [2, 2, [{ n: 1, offsetMinutes: 5, taskName: reminderTaskName(id, 1) }]],
    ]);
  });

  it.each<[string, ScheduleInput, number]>([
    ['absent reminders', { launchAt: LAUNCH }, 0],
    ['empty reminder text', { launchAt: LAUNCH, reminders: '' }, 0],
    ['null reminders', { launchAt: LAUNCH, reminders: null }, 0],
    ['an empty reminder array', { launchAt: LAUNCH, reminders: [] }, 0],
    ['a signed offset text', { launchAt: LAUNCH, reminders: [{ offsetMinutes: '+5' }] }, 1],
    ['a reminder due at the last datetime second', { launchAt: '9999-12-31T22:59:59', reminders: [{ offsetMinutes: 60 }] }, 1],
  ])('accepts %s', async (_case, input, reminders) => {
    const id = await newSurvey();

    const detail = await schedule(id, input);

    expect(detail.schedule?.schedule_version).toBe(1);
    expect(detail.reminders).toHaveLength(reminders);
  });

  it.each<[string, ScheduleInput]>([
    ['no launch time', {}],
    ['a space before the time', { launchAt: '2026-07-01 09:30:00' }],
    ['milliseconds', { launchAt: '2026-07-01T09:30:00.000' }],
    ['a date that rolls over', { launchAt: '2026-02-30T09:30:00' }],
    ['hour 24', { launchAt: '2026-07-01T24:00:00' }],
    ['a year before 1753', { launchAt: '1752-12-31T23:59:59' }],
    ['a numeric launch time', { launchAt: 20260701 }],
    ['reminder text that is not JSON', { launchAt: LAUNCH, reminders: 'soon' }],
    ['a reminder struct instead of an array', { launchAt: LAUNCH, reminders: { offsetMinutes: 5 } }],
    ['a reminder without offsetMinutes', { launchAt: LAUNCH, reminders: [{}] }],
    ['offsetMinutes in another case', { launchAt: LAUNCH, reminders: [{ offsetminutes: 5 }] }],
    ['an empty offset', { launchAt: LAUNCH, reminders: [{ offsetMinutes: '' }] }],
    ['a null offset', { launchAt: LAUNCH, reminders: [{ offsetMinutes: null }] }],
    ['a negative offset', { launchAt: LAUNCH, reminders: [{ offsetMinutes: -1 }] }],
    ['a decimal offset', { launchAt: LAUNCH, reminders: [{ offsetMinutes: '1.5' }] }],
    ['an offset beyond the int range', { launchAt: LAUNCH, reminders: [{ offsetMinutes: '2147483648' }] }],
    ['a negative non-ASCII offset', { launchAt: LAUNCH, reminders: [{ offsetMinutes: '-٣' }] }],
    ['a reminder after 9999-12-31 23:59:59', { launchAt: '9999-12-31T23:00:00', reminders: [{ offsetMinutes: 60 }] }],
  ])('answers invalidParameters for %s and writes nothing', async (_case, input) => {
    const id = await newSurvey();

    const error = await schedule(id, input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'invalidParameters' });
    expect(await rows('SELECT 1 FROM $S.survey_schedule WHERE survey_id = $1', [id])).toEqual([]);
  });

  it('fails as a server error for an offset of non-ASCII digits, as ACF int() does', async () => {
    const id = await newSurvey();

    const error = await schedule(id, { launchAt: LAUNCH, reminders: [{ offsetMinutes: '٣٠' }] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(LegacyApiError);
  });

  it('answers the fixture notFound before validating anything for an unknown survey', async () => {
    const error = await schedule(UNKNOWN_ID, {}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type: 'notFound' });
  });

  it.each([[SURVEY_STATUS.LAUNCHED], [SURVEY_STATUS.CLOSED]])('answers conflict after validation for a %s survey and writes nothing', async (status) => {
    const id = await newSurvey(status);

    await expect(schedule(id, {})).rejects.toMatchObject({ type: 'invalidParameters' });
    const error = await schedule(id, { launchAt: LAUNCH }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FixtureApiError);
    expect(error).toMatchObject({ type: 'conflict' });
    expect(await rows('SELECT status FROM $S.survey WHERE survey_id = $1', [id])).toEqual([{ status }]);
    expect(await rows('SELECT 1 FROM $S.survey_schedule WHERE survey_id = $1', [id])).toEqual([]);
    expect(await scheduledOutbox()).toEqual([]);
  });

  it('re-runs after a gate race and stores one schedule version and one event', async () => {
    const id = await newSurvey();
    let races = 0;
    const racing: SurveysRepository = {
      ...deps.repository,
      replaceReminders: async (tx, surveyId, reminders, ctx) => {
        const stored = await deps.repository.replaceReminders(tx, surveyId, reminders, ctx);
        if (races === 0) {
          races += 1;
          throw new GateRaceError(['surveys.survey_reminder']);
        }
        return stored;
      },
    };

    const detail = await schedule(id, { launchAt: LAUNCH, reminders: [{ offsetMinutes: 1 }] }, { ...deps, repository: racing });

    expect(races).toBe(1);
    expect(detail.schedule?.schedule_version).toBe(1);
    expect(await scheduledOutbox()).toHaveLength(1);
  });

  it('propagates the unavailability of a legacy-authoritative schedule unit and writes no event', async () => {
    const id = await newSurvey();
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'legacy' WHERE unit = 'surveys.survey_schedule'`),
    );

    await expect(schedule(id, { launchAt: LAUNCH })).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(await scheduledOutbox()).toEqual([]);
  });

  it.runIf(process.env.TZ === 'America/New_York')('resolves a DST gap and fold the way ACF parses them', async () => {
    const id = await newSurvey();

    await expect(schedule(id, { launchAt: '2026-03-08T02:30:00' })).rejects.toMatchObject({ type: 'invalidParameters' });
    await schedule(id, { launchAt: '2026-11-01T01:30:00', reminders: [{ offsetMinutes: 60 }] });

    expect(await rows("SELECT to_char(remind_at, 'YYYY-MM-DD HH24:MI:SS') AS wall FROM $S.survey_reminder WHERE survey_id = $1", [id])).toEqual([
      { wall: '2026-11-01 02:30:00' },
    ]);
  });
});
