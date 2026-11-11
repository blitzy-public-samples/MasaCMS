// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Surveys repository helpers against a throwaway `surveys` schema: fixture row writes, one changelog row per written row, gates and RLS. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RepositoryError, UnitNotAuthoritativeError, ensureUnitGates, type WriteContext } from '@opt2/platform/migration-kit';
import { OutsideTenantTransactionError, tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  OWNER,
  SCHEMA,
  createSurveysRepository,
  launchTaskName,
  reminderTaskName,
  type SurveysRepository,
  type TargetPair,
} from '../../src/repo/repository.js';
import { OWNED_TABLES, UNITS, type SurveyRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const LAUNCH_AT = new Date(2026, 6, 1, 9, 0, 0);
const USER_ID = '11111111-2222-3333-4444555566667777';
const HASH_1 = 'a'.repeat(64);
const HASH_2 = 'b'.repeat(64);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

interface LoggedChange {
  table: string;
  op: string;
  columns: string[];
  origin: string;
  actor_user_id: string | null;
  request_id: string | null;
}

describe('surveys repository identity', () => {
  it('names the owner, schema and fixture task names', () => {
    expect([OWNER, SCHEMA]).toEqual(['surveys', 'surveys']);
    expect(launchTaskName('ABC')).toBe('opt2-survey-ABC-launch');
    expect(reminderTaskName('ABC', 12)).toBe('opt2-survey-ABC-reminder-12');
  });

  it('extends the platform repository of the owned tables', () => {
    const repository = createSurveysRepository({ clock: fixedClock(NOW) });
    expect(Object.isFrozen(repository)).toBe(true);
    expect(repository).toMatchObject({ owner: 'surveys', schema: 'surveys' });
    expect(repository.units()).toEqual([...UNITS]);
    expect(OWNED_TABLES.map((table) => repository.definition(table.table))).toEqual([...OWNED_TABLES]);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('surveys repository writes against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;
  let tenants = 0;
  let tenantId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createSurveysRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    tenants += 1;
    tenantId = tenantIdForSite(`surveys-repository-${tenants}`);
  });

  async function setGates(state: 'open' | 'legacy', units: readonly string[] = UNITS): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $2, holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`, [
        units,
        state,
      ]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function changelog(tenant = tenantId): Promise<LoggedChange[]> {
    return inTenant(async (tx) => {
      const { rows } = await tx.query<LoggedChange>(
        `SELECT "table", op, columns, origin, actor_user_id, request_id FROM ${handle.schema}.changelog ORDER BY seq`,
      );
      return rows;
    }, tenant);
  }

  function ops(changes: LoggedChange[]): string[] {
    return changes.map((change) => `${change.op} ${change.table}`);
  }

  function rows<T extends Record<string, unknown>>(table: string, order: string): Promise<T[]> {
    return inTenant(async (tx) => (await tx.query<T>(`SELECT * FROM ${handle.schema}.${table} ORDER BY ${order}`)).rows);
  }

  function newSurvey(tenant = tenantId): Promise<SurveyRow> {
    return inTenant((tx) => repository.insertSurvey(tx, { siteId: 'tenant-a', title: 'Pulse', createdById: USER_ID }), tenant);
  }

  it('inserts a DRAFT survey with a CF id, the clock time and the creator, logging one insert', async () => {
    const survey = await newSurvey();

    expect(survey).toMatchObject({
      tenant_id: tenantId,
      siteid: 'tenant-a',
      title: 'Pulse',
      status: 'DRAFT',
      createdbyid: USER_ID,
      lastupdate: null,
      lastupdatebyid: null,
      launched_at: null,
    });
    expect(survey.survey_id).toMatch(CF_UUID);
    expect(survey.created.getTime()).toBe(NOW.getTime());
    expect(await changelog()).toMatchObject([{ table: 'survey', op: 'insert', origin: 'target' }]);
  });

  it('passes the caller write context to the changelog', async () => {
    const ctx: WriteContext = { actorUserId: USER_ID, requestId: 'req-1' };
    await inTenant((tx) => repository.insertSurvey(tx, { siteId: 'tenant-a', title: 'Pulse', createdById: USER_ID }, ctx));

    expect(await changelog()).toMatchObject([{ actor_user_id: USER_ID, request_id: 'req-1' }]);
  });

  it('sets a status once and writes nothing when it is already set', async () => {
    const survey = await newSurvey();
    const scheduled = await inTenant((tx) => repository.setSurveyStatus(tx, survey.survey_id, 'SCHEDULED'));
    const again = await inTenant((tx) => repository.setSurveyStatus(tx, survey.survey_id, 'SCHEDULED'));

    expect(scheduled).toMatchObject({ status: 'SCHEDULED', launched_at: null, lastupdate: null });
    expect(again).toEqual(scheduled);
    expect(await changelog()).toMatchObject([
      { op: 'insert', table: 'survey' },
      { op: 'update', table: 'survey', columns: ['status'] },
    ]);
  });

  it('launches with the clock time only while launched_at is null', async () => {
    const survey = await newSurvey();
    const launched = await inTenant((tx) => repository.setSurveyStatus(tx, survey.survey_id, 'LAUNCHED'));
    const later = new Date(NOW.getTime() + 60_000);
    const repeat = await inTenant((tx) => repository.setSurveyStatus(tx, survey.survey_id, 'LAUNCHED', { launchedAt: later }));

    expect(launched).toMatchObject({ status: 'LAUNCHED' });
    expect(launched?.launched_at?.getTime()).toBe(NOW.getTime());
    expect(repeat).toEqual(launched);
    expect(ops(await changelog())).toEqual(['insert survey', 'update survey']);
  });

  it('stamps an explicit launch time', async () => {
    const survey = await newSurvey();
    const at = new Date(2026, 6, 2, 8, 30, 0, 250);
    const launched = await inTenant((tx) => repository.setSurveyStatus(tx, survey.survey_id, 'LAUNCHED', { launchedAt: at }));

    expect(launched?.launched_at?.getTime()).toBe(at.getTime());
  });

  it('answers null for the status of an unknown survey', async () => {
    expect(await inTenant((tx) => repository.setSurveyStatus(tx, 'NO-SUCH-SURVEY', 'SCHEDULED'))).toBeNull();
    expect(await changelog()).toEqual([]);
  });

  it('inserts a schedule at version 1 and bumps both versions on a reschedule', async () => {
    const survey = await newSurvey();
    const first = await inTenant((tx) => repository.upsertSchedule(tx, survey.survey_id, { launchAt: LAUNCH_AT, taskTokenHash: HASH_1 }));
    const relaunch = new Date(2026, 6, 3, 10, 0, 0);
    const second = await inTenant((tx) => repository.upsertSchedule(tx, survey.survey_id, { launchAt: relaunch, taskTokenHash: HASH_2 }));

    expect(first).toMatchObject({
      survey_id: survey.survey_id,
      schedule_version: 1,
      row_version: '1',
      task_name: launchTaskName(survey.survey_id),
      task_token_hash: HASH_1,
    });
    expect(first.schedule_id).toMatch(CF_UUID);
    expect(first.created.getTime()).toBe(NOW.getTime());
    expect(second).toMatchObject({ schedule_id: first.schedule_id, schedule_version: 2, row_version: '2', task_token_hash: HASH_2 });
    expect(second.launch_at.getTime()).toBe(relaunch.getTime());
    expect(second.created.getTime()).toBe(first.created.getTime());
    expect(await changelog()).toMatchObject([
      { op: 'insert', table: 'survey' },
      { op: 'insert', table: 'survey_schedule' },
      { op: 'update', table: 'survey_schedule', columns: ['launch_at', 'schedule_version', 'task_token_hash', 'row_version'] },
    ]);
  });

  it('replaces reminders by deleting each stored row and inserting the new ones numbered from 1', async () => {
    const survey = await newSurvey();
    const first = await inTenant((tx) =>
      repository.replaceReminders(tx, survey.survey_id, [
        { offsetMinutes: 60, remindAt: new Date(LAUNCH_AT.getTime() + 3_600_000), taskTokenHash: HASH_1 },
        { offsetMinutes: 1440, remindAt: new Date(LAUNCH_AT.getTime() + 86_400_000), taskTokenHash: HASH_1 },
      ]),
    );
    const second = await inTenant((tx) =>
      repository.replaceReminders(tx, survey.survey_id, [
        { offsetMinutes: 30, remindAt: new Date(LAUNCH_AT.getTime() + 1_800_000), taskTokenHash: HASH_2 },
      ]),
    );

    expect(first.map((row) => [row.task_name, row.offset_minutes, row.sent_at])).toEqual([
      [reminderTaskName(survey.survey_id, 1), 60, null],
      [reminderTaskName(survey.survey_id, 2), 1440, null],
    ]);
    expect(second).toMatchObject([{ task_name: reminderTaskName(survey.survey_id, 1), offset_minutes: 30, task_token_hash: HASH_2 }]);
    expect(second[0]?.reminder_id).toMatch(CF_UUID);
    expect(await rows('survey_reminder', 'task_name')).toEqual(second);
    expect(ops(await changelog())).toEqual([
      'insert survey',
      'insert survey_reminder',
      'insert survey_reminder',
      'delete survey_reminder',
      'delete survey_reminder',
      'insert survey_reminder',
    ]);
  });

  it.each([
    ['distinct pairs', [{ siteId: 'tenant-a', groupName: null }, { siteId: 'tenant-b', groupName: 'Panel' }], 2],
    ['a repeated pair', [{ siteId: 'tenant-a', groupName: 'Panel' }, { siteId: 'tenant-a', groupName: 'Panel' }], 1],
    ['repeated NULL groups', [{ siteId: 'tenant-a', groupName: null }, { siteId: 'tenant-a', groupName: null }], 1],
    ['a NULL group beside an empty one', [{ siteId: 'tenant-a', groupName: null }, { siteId: 'tenant-a', groupName: '' }], 2],
    ['pairs differing in case and trailing spaces', [{ siteId: 'tenant-a', groupName: 'Panel' }, { siteId: 'TENANT-A ', groupName: 'panel  ' }], 1],
    ['no pairs', [], 0],
  ] as [string, TargetPair[], number][])('collapses %s as usp_survey_bulk_target does', async (_label, pairs, inserted) => {
    const survey = await newSurvey();
    const result = await inTenant((tx) => repository.insertTargets(tx, survey.survey_id, pairs));

    expect(result).toEqual({ inserted, total: inserted });
    expect(ops(await changelog()).filter((op) => op === 'insert survey_target')).toHaveLength(inserted);
  });

  it('inserts only pairs the survey does not target yet and counts every target', async () => {
    const survey = await newSurvey();
    await inTenant((tx) =>
      repository.insertTargets(tx, survey.survey_id, [
        { siteId: 'tenant-a', groupName: null },
        { siteId: 'tenant-b', groupName: 'Panel' },
      ]),
    );
    const result = await inTenant((tx) =>
      repository.insertTargets(tx, survey.survey_id, [
        { siteId: 'tenant-a', groupName: null },
        { siteId: 'tenant-b', groupName: 'PANEL' },
        { siteId: 'tenant-b', groupName: null },
      ]),
    );
    const stored = await rows<{ target_id: string; siteid: string; group_name: string | null; created: Date }>(
      'survey_target',
      'siteid, group_name NULLS FIRST',
    );

    expect(result).toEqual({ inserted: 1, total: 3 });
    expect(stored.map((row) => [row.siteid, row.group_name])).toEqual([
      ['tenant-a', null],
      ['tenant-b', null],
      ['tenant-b', 'Panel'],
    ]);
    expect(stored.every((row) => CF_UUID.test(row.target_id) && row.created.getTime() === NOW.getTime())).toBe(true);
  });

  it.each([
    ['unicode and padding', '  {"q1": "Grüße – 你好"}  \n'],
    ['JSON-looking text kept unparsed', '{"b":1,  "a":[1.0, 2e3]}'],
    ['plain text', 'Yes'],
  ])('stores a response with %s byte-exact under the survey site', async (_label, answers) => {
    const survey = await newSurvey();
    const response = await inTenant((tx) =>
      repository.insertResponse(tx, { survey, respondentSiteId: 'tenant-b', respondentUserId: USER_ID, answers }),
    );

    expect(response).toMatchObject({
      survey_id: survey.survey_id,
      siteid: 'tenant-a',
      respondentsiteid: 'tenant-b',
      respondent_user_id: USER_ID,
      answers,
    });
    expect(response.response_id).toMatch(CF_UUID);
    expect(response.created.getTime()).toBe(NOW.getTime());
    expect(ops(await changelog())).toEqual(['insert survey', 'insert survey_response']);
  });

  it('stamps sent_at of a reminder once and answers null for an unknown reminder or survey', async () => {
    const survey = await newSurvey();
    await inTenant((tx) =>
      repository.replaceReminders(tx, survey.survey_id, [
        { offsetMinutes: 60, remindAt: new Date(LAUNCH_AT.getTime() + 3_600_000), taskTokenHash: HASH_1 },
      ]),
    );
    const sent = await inTenant((tx) => repository.markReminderSent(tx, survey.survey_id, 1));
    const repeat = await inTenant((tx) => repository.markReminderSent(tx, survey.survey_id, 1, new Date(NOW.getTime() + 1000)));

    expect(sent?.sent_at?.getTime()).toBe(NOW.getTime());
    expect(repeat).toEqual(sent);
    expect(await inTenant((tx) => repository.markReminderSent(tx, survey.survey_id, 2))).toBeNull();
    expect(await inTenant((tx) => repository.markReminderSent(tx, 'NO-SUCH-SURVEY', 1))).toBeNull();
    expect(await changelog()).toMatchObject([
      { op: 'insert', table: 'survey' },
      { op: 'insert', table: 'survey_reminder' },
      { op: 'update', table: 'survey_reminder', columns: ['sent_at'] },
    ]);
  });

  it.each([
    ['upsertSchedule', 'survey_schedule', (r: SurveysRepository, tx: TenantTx, id: string) =>
      r.upsertSchedule(tx, id, { launchAt: LAUNCH_AT, taskTokenHash: HASH_1 })],
    ['replaceReminders', 'survey_reminder', (r: SurveysRepository, tx: TenantTx, id: string) => r.replaceReminders(tx, id, [])],
    ['insertTargets', 'survey_target', (r: SurveysRepository, tx: TenantTx, id: string) => r.insertTargets(tx, id, [])],
  ] as const)('%s refuses a survey the tenant cannot see', async (_method, table, call) => {
    const survey = await newSurvey(tenantIdForSite('tenant-a'));
    const err = await inTenant<unknown>((tx) => call(repository, tx, survey.survey_id)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RepositoryError);
    expect(err).toMatchObject({ table, message: `${table}: survey ${survey.survey_id} does not exist` });
    expect(await changelog()).toEqual([]);
  });

  it('rejects writes to a unit that is not target-authoritative', async () => {
    const survey = await newSurvey();
    await setGates('legacy', ['surveys.survey_target']);

    await expect(
      inTenant((tx) => repository.insertTargets(tx, survey.survey_id, [{ siteId: 'tenant-a', groupName: null }])),
    ).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(ops(await changelog())).toEqual(['insert survey']);
  });

  it('rejects a helper call outside its tenant transaction', async () => {
    const kept = await inTenant((tx) => Promise.resolve(tx));

    await expect(repository.insertSurvey(kept, { siteId: 'tenant-a', title: 'Pulse', createdById: USER_ID })).rejects.toBeInstanceOf(
      OutsideTenantTransactionError,
    );
    await expect(repository.setSurveyStatus(kept, 'ANY', 'SCHEDULED')).rejects.toBeInstanceOf(OutsideTenantTransactionError);
  });
});
