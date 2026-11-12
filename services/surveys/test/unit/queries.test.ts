// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Surveys read helpers against a throwaway `surveys` schema: fixture order, paging, columns and list indexes, tenant isolation and window gates. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitReadBlockedError, ensureUnitGates, withGatedTenant } from '@opt2/platform/migration-kit';
import { OutsideTenantTransactionError, tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  findSurvey,
  getSchedule,
  getSurvey,
  listReminders,
  listResponses,
  listSchedulings,
  listSurveys,
  listTargets,
  type SurveyListFilters,
} from '../../src/repo/queries.js';
import { UNITS } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0);
const USER_ID = '11111111-2222-3333-4444555566667777';
const HASH = 'a'.repeat(64);
const ANSWERS = ' {"q1": "é", "q2": [1, 2]}\n ';
const FULL_PAGE = { pageIndex: 1, itemsPerPage: 50 };

/** Local time `minutes` after T0. */
function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

/** CF-format id whose sort order follows `n`. */
function cfId(n: number): string {
  return `${String(n).padStart(8, '0')}-AAAA-BBBB-CCCCDDDDEEEEFFFF`;
}

const available = await pgAvailable();

describe.skipIf(!available)('surveys queries against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let tenants = 0;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    tenants += 1;
    tenantA = tenantIdForSite(`surveys-queries-a-${tenants}`);
    tenantB = tenantIdForSite(`surveys-queries-b-${tenants}`);
  });

  function inTenant<T>(tenant: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  /** Wraps `tx` so every statement text it runs is appended to `seen`. */
  function recording(tx: TenantTx, seen: string[]): TenantTx {
    const query = ((text: string, values?: unknown[]) => {
      seen.push(text);
      return tx.query(text, values);
    }) as TenantTx['query'];
    return { ...tx, query };
  }

  async function insert(tx: TenantTx, table: string, row: Record<string, unknown>): Promise<void> {
    const columns = ['tenant_id', ...Object.keys(row)];
    const values = [tx.tenantId, ...Object.values(row)];
    await tx.query(
      `INSERT INTO ${handle.schema}.${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      values,
    );
  }

  function insertSurvey(tx: TenantTx, surveyId: string, siteid: string, created: Date): Promise<void> {
    return insert(tx, 'survey', { survey_id: surveyId, siteid, title: 'Pulse', status: 'DRAFT', created, createdbyid: USER_ID });
  }

  /** A survey with a schedule, reminders 10, 2 and 1, four targets and three responses, each inserted out of fixture order. */
  async function seedDetail(tx: TenantTx, surveyId: string): Promise<void> {
    await insertSurvey(tx, surveyId, 'tenant-a', at(0));
    await insert(tx, 'survey_schedule', {
      schedule_id: cfId(21),
      survey_id: surveyId,
      launch_at: at(60),
      schedule_version: 2,
      task_name: `opt2-survey-${surveyId}-launch`,
      task_token_hash: HASH,
      created: at(0),
      row_version: 2,
    });
    for (const [reminderId, n, offset] of [
      [32, 10, 600],
      [31, 2, 20],
      [30, 1, 10],
    ] as const) {
      await insert(tx, 'survey_reminder', {
        reminder_id: cfId(reminderId),
        survey_id: surveyId,
        offset_minutes: offset,
        remind_at: at(offset),
        task_name: `opt2-survey-${surveyId}-reminder-${n}`,
        task_token_hash: HASH,
      });
    }
    for (const [targetId, siteid, groupName] of [
      [41, 'tenant-b', 'Zeta'],
      [42, 'tenant-a', 'beta'],
      [43, 'tenant-a', null],
      [44, 'Tenant-A', 'Alpha'],
    ] as const) {
      await insert(tx, 'survey_target', { target_id: cfId(targetId), survey_id: surveyId, siteid, group_name: groupName, created: at(0) });
    }
    for (const [responseId, created] of [
      [52, at(5)],
      [51, at(5)],
      [50, at(9)],
    ] as const) {
      await insert(tx, 'survey_response', {
        response_id: cfId(responseId),
        survey_id: surveyId,
        siteid: 'tenant-a',
        respondentsiteid: 'tenant-b',
        respondent_user_id: USER_ID,
        answers: ANSWERS,
        created,
      });
    }
  }

  describe('listSurveys', () => {
    beforeEach(async () => {
      await inTenant(tenantA, async (tx) => {
        await insertSurvey(tx, cfId(3), 'tenant-a', at(1));
        await insertSurvey(tx, cfId(2), 'tenant-a', at(1));
        await insertSurvey(tx, cfId(1), 'TENANT-A ', at(2));
        await insertSurvey(tx, cfId(4), 'tenant-a', at(0));
        await insertSurvey(tx, cfId(5), 'other', at(0));
      });
    });

    it.each<[string, SurveyListFilters, number[]]>([
      ['every row on one page', { siteId: 'tenant-a', ...FULL_PAGE }, [4, 2, 3, 1]],
      ['the first page', { siteId: 'tenant-a', pageIndex: 1, itemsPerPage: 2 }, [4, 2]],
      ['a short last page, matching the site case-insensitively', { siteId: 'Tenant-A', pageIndex: 2, itemsPerPage: 3 }, [1]],
      ['no rows past the total', { siteId: 'tenant-a', pageIndex: 3, itemsPerPage: 2 }, []],
    ])('reads %s by creation time and id with the site total', async (_name, filters, expected) => {
      const page = await inTenant(tenantA, (tx) => listSurveys(tx, filters));

      expect(page.total).toBe(4);
      expect(page.rows.map((row) => row.survey_id)).toEqual(expected.map(cfId));
    });

    it('counts nothing for a site without surveys', async () => {
      expect(await inTenant(tenantA, (tx) => listSurveys(tx, { siteId: 'nobody', ...FULL_PAGE }))).toEqual({
        rows: [],
        total: 0,
      });
    });
  });

  describe('listResponses', () => {
    const surveyId = cfId(70);
    const isPageRead = (text: string): boolean => /\bsurvey_response\b.*\bOFFSET\b/.test(text);

    beforeEach(async () => {
      await inTenant(tenantA, async (tx) => {
        for (const [responseId, responseSurvey, minutes] of [
          [63, surveyId, 5],
          [61, surveyId, 5],
          [64, surveyId, 1],
          [62, surveyId, 9],
          [65, cfId(71), 0],
        ] as const) {
          await insert(tx, 'survey_response', {
            response_id: cfId(responseId),
            survey_id: responseSurvey,
            siteid: 'tenant-a',
            respondentsiteid: 'tenant-a',
            respondent_user_id: USER_ID,
            answers: ANSWERS,
            created: at(minutes),
          });
        }
      });
    });

    it.each<[string, { pageIndex: number; itemsPerPage: number }, number[]]>([
      ['every row on one page', FULL_PAGE, [64, 61, 63, 62]],
      ['the first page', { pageIndex: 1, itemsPerPage: 2 }, [64, 61]],
      ['the second page', { pageIndex: 2, itemsPerPage: 2 }, [63, 62]],
      ['a short last page', { pageIndex: 2, itemsPerPage: 3 }, [62]],
      ['no rows for a page starting at the total', { pageIndex: 3, itemsPerPage: 2 }, []],
      ['no rows for a page starting after the total', { pageIndex: 6, itemsPerPage: 1 }, []],
    ])('reads %s by creation time and id with the survey total', async (_name, page, expected) => {
      const seen: string[] = [];
      const result = await inTenant(tenantA, (tx) => listResponses(recording(tx, seen), surveyId, page));

      expect(result.total).toBe(4);
      expect(result.rows.map((row) => row.response_id)).toEqual(expected.map(cfId));
      expect(seen.filter(isPageRead)).toHaveLength(expected.length === 0 ? 0 : 1);
    });

    it('counts nothing for a survey without responses and reads no page', async () => {
      const seen: string[] = [];

      expect(await inTenant(tenantA, (tx) => listResponses(recording(tx, seen), cfId(72), FULL_PAGE))).toEqual({ rows: [], total: 0 });
      expect(seen.filter(isPageRead)).toEqual([]);
    });
  });

  describe('listSchedulings', () => {
    const scheduled = cfId(20);
    const other = cfId(23);
    const unscheduled = cfId(25);
    const unknown = cfId(99);

    beforeEach(async () => {
      await inTenant(tenantA, async (tx) => {
        await seedDetail(tx, scheduled);
        await insertSurvey(tx, other, 'tenant-a', at(1));
        await insert(tx, 'survey_schedule', {
          schedule_id: cfId(24),
          survey_id: other,
          launch_at: at(90),
          schedule_version: 1,
          task_name: `opt2-survey-${other}-launch`,
          task_token_hash: HASH,
          created: at(1),
        });
        for (const [reminderId, n] of [
          [36, 3],
          [34, 1],
        ] as const) {
          await insert(tx, 'survey_reminder', {
            reminder_id: cfId(reminderId),
            survey_id: other,
            offset_minutes: n * 30,
            remind_at: at(90 + n * 30),
            task_name: `opt2-survey-${other}-reminder-${n}`,
            task_token_hash: HASH,
          });
        }
        await insertSurvey(tx, unscheduled, 'tenant-a', at(2));
      });
    });

    it('groups each schedule and its ordinal-ordered reminders by survey in two statements, an unscheduled id with none', async () => {
      const seen: string[] = [];

      const [byId, details] = await inTenant(tenantA, async (tx) => [
        await listSchedulings(recording(tx, seen), [unknown, other, scheduled, unscheduled, other]),
        [await getSurvey(tx, scheduled), await getSurvey(tx, other)],
      ] as const);

      expect([...byId.keys()]).toEqual([unknown, other, scheduled, unscheduled]);
      expect(byId.get(scheduled)?.reminders.map((reminder) => reminder.reminder_id)).toEqual([30, 31, 32].map(cfId));
      expect(byId.get(other)?.reminders.map((reminder) => reminder.reminder_id)).toEqual([34, 36].map(cfId));
      for (const detail of details) {
        expect(byId.get(detail?.survey.survey_id ?? '')).toEqual({ schedule: detail?.schedule, reminders: detail?.reminders });
      }
      expect(byId.get(other)?.schedule?.schedule_id).toBe(cfId(24));
      expect(byId.get(unscheduled)).toEqual({ schedule: null, reminders: [] });
      expect(byId.get(unknown)).toEqual({ schedule: null, reminders: [] });
      expect(seen.filter((text) => /\bsurvey_(schedule|reminder)\b/.test(text))).toHaveLength(2);
    });

    it('runs no statement, not even a gate read, for no ids', async () => {
      const seen: string[] = [];

      expect(await inTenant(tenantA, (tx) => listSchedulings(recording(tx, seen), []))).toEqual(new Map());
      expect(seen).toEqual([]);
    });

    it('plans the batched schedule and reminder reads with the ids as an index condition once the tables have statistics', async () => {
      await inTenant(tenantA, async (tx) => {
        const bulkId = (segment: string): string => `lpad(n::text, 8, '0') || '-${segment}-BBBB-CCCCDDDDEEEEFFFF'`;
        await tx.query(
          `INSERT INTO ${handle.schema}.survey_schedule (tenant_id, schedule_id, survey_id, launch_at, schedule_version, task_name, task_token_hash, created)
           SELECT $1, ${bulkId('EEEE')}, ${bulkId('FFFF')}, $2, 1, 'opt2-survey-launch', $3, $2 FROM generate_series(1000, 1499) AS n`,
          [tx.tenantId, at(0), HASH],
        );
        await tx.query(
          `INSERT INTO ${handle.schema}.survey_reminder (tenant_id, reminder_id, survey_id, offset_minutes, remind_at, task_name, task_token_hash)
           SELECT $1, ${bulkId('EEEE')}, lpad((1000 + n % 500)::text, 8, '0') || '-FFFF-BBBB-CCCCDDDDEEEEFFFF', 10, $2, 'opt2-survey-reminder-1', $3
           FROM generate_series(1000, 2499) AS n`,
          [tx.tenantId, at(10), HASH],
        );
      });
      await handle.adminPool.query(`ANALYZE ${handle.schema}.survey_schedule, ${handle.schema}.survey_reminder`);

      const plans = await inTenant(tenantA, async (tx) => {
        const seen: string[] = [];
        await listSchedulings(recording(tx, seen), [scheduled, other]);
        await tx.query('SET LOCAL enable_seqscan = off');
        const explain = async (table: string): Promise<string> => {
          const text = seen.find((statement) => new RegExp(`\\b${table}\\b`).test(statement)) ?? '';
          return (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, [[scheduled, other]])).rows.map((row) => row['QUERY PLAN']).join('\n');
        };
        return [await explain('survey_schedule'), await explain('survey_reminder')];
      });

      expect(plans[0]).toMatch(/survey_schedule_tenant_id_survey_id_key[\s\S]*Index Cond:[^\n]*survey_id = ANY/);
      expect(plans[1]).toMatch(/survey_reminder_survey_idx[\s\S]*Index Cond:[^\n]*survey_id = ANY/);
    });
  });

  it('indexes the survey list and response pages in their order, with statistics for the site expression', async () => {
    const indexes = await handle.adminPool.query<{ indexname: string; indexdef: string }>(
      'SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2) ORDER BY indexname',
      [handle.schema, ['survey_list_idx', 'survey_response_survey_idx', 'survey_site_idx']],
    );
    const statistics = await handle.adminPool.query<{ definition: string }>(
      'SELECT pg_get_statisticsobjdef(oid) AS definition FROM pg_statistic_ext WHERE stxnamespace = $1::regnamespace',
      [handle.schema],
    );

    expect(indexes.rows).toEqual([
      {
        indexname: 'survey_list_idx',
        indexdef: `CREATE INDEX survey_list_idx ON ${handle.schema}.survey USING btree (tenant_id, created, survey_id) INCLUDE (siteid)`,
      },
      {
        indexname: 'survey_response_survey_idx',
        indexdef: `CREATE INDEX survey_response_survey_idx ON ${handle.schema}.survey_response USING btree (tenant_id, survey_id, created, response_id)`,
      },
    ]);
    expect(statistics.rows).toEqual([
      { definition: `CREATE STATISTICS ${handle.schema}.survey_site_key_stats ON lower(rtrim(siteid::text)) FROM ${handle.schema}.survey` },
    ]);
  });

  it('plans the survey and response pages on their list indexes', async () => {
    const plans = await inTenant(tenantA, async (tx) => {
      await insertSurvey(tx, cfId(80), 'tenant-a', at(0));
      await insert(tx, 'survey_response', {
        response_id: cfId(81),
        survey_id: cfId(80),
        siteid: 'tenant-a',
        respondentsiteid: 'tenant-a',
        respondent_user_id: USER_ID,
        answers: ANSWERS,
        created: at(1),
      });
      const seen: string[] = [];
      await listSurveys(recording(tx, seen), { siteId: 'tenant-a', pageIndex: 1, itemsPerPage: 2 });
      await listResponses(recording(tx, seen), cfId(80), { pageIndex: 1, itemsPerPage: 2 });
      await tx.query('SET LOCAL enable_seqscan = off');
      const explain = async (text: string | undefined, key: string): Promise<string> =>
        (await tx.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text ?? ''}`, [key, 0, 2])).rows.map((row) => row['QUERY PLAN']).join('\n');
      return [
        await explain(seen.find((text) => /\bsurvey\b.*\bOFFSET\b/.test(text)), 'tenant-a'),
        await explain(seen.find((text) => /\bsurvey_response\b.*\bOFFSET\b/.test(text)), cfId(80)),
      ];
    });

    expect(plans[0]).toMatch(/Limit[\s\S]*Index Scan using survey_list_idx/);
    expect(plans[0]).not.toMatch(/Sort/);
    expect(plans[1]).toMatch(/Limit[\s\S]*Index Scan using survey_response_survey_idx/);
    expect(plans[1]).not.toMatch(/Sort/);
  });

  it('returns the detail in the fixture columns and order', async () => {
    const surveyId = cfId(20);
    await inTenant(tenantA, (tx) => seedDetail(tx, surveyId));

    const detail = await inTenant(tenantA, (tx) => getSurvey(tx, surveyId));

    expect(detail?.survey).toMatchObject({ survey_id: surveyId, tenant_id: tenantA, siteid: 'tenant-a' });
    expect(Object.keys(detail?.schedule ?? {})).toEqual(['schedule_id', 'survey_id', 'launch_at', 'schedule_version', 'task_name', 'created']);
    expect(detail?.reminders.map((reminder) => reminder.reminder_id)).toEqual([30, 31, 32].map(cfId));
    expect(Object.keys(detail?.reminders[0] ?? {})).toEqual(['reminder_id', 'survey_id', 'offset_minutes', 'remind_at', 'task_name', 'sent_at']);
    expect(detail?.targets.map((target) => target.target_id)).toEqual([43, 44, 42, 41].map(cfId));
    expect(Object.keys(detail?.targets[0] ?? {})).toEqual(['target_id', 'survey_id', 'siteid', 'group_name', 'created']);
  });

  it('returns an unscheduled detail with no children, and null for an unknown survey', async () => {
    await inTenant(tenantA, (tx) => insertSurvey(tx, cfId(60), 'tenant-a', at(0)));

    expect(await inTenant(tenantA, (tx) => getSurvey(tx, cfId(60)))).toMatchObject({ schedule: null, reminders: [], targets: [] });
    expect(await inTenant(tenantA, (tx) => getSurvey(tx, cfId(98)))).toBeNull();
    expect(await inTenant(tenantA, (tx) => findSurvey(tx, cfId(98)))).toBeNull();
  });

  it('reads the stored schedule, reminders, targets and responses of a survey', async () => {
    const surveyId = cfId(20);
    await inTenant(tenantA, (tx) => seedDetail(tx, surveyId));

    const [schedule, unscheduled, reminders, targets, responses] = await inTenant(tenantA, async (tx) => [
      await getSchedule(tx, surveyId),
      await getSchedule(tx, cfId(99)),
      await listReminders(tx, surveyId),
      await listTargets(tx, surveyId),
      await listResponses(tx, surveyId, FULL_PAGE),
    ]);

    expect(schedule).toMatchObject({ schedule_id: cfId(21), task_token_hash: HASH, row_version: '2' });
    expect(unscheduled).toBeNull();
    expect(reminders.map((reminder) => reminder.offset_minutes)).toEqual([10, 20, 600]);
    expect(targets.map((target) => target.target_id)).toEqual([43, 44, 42, 41].map(cfId));
    expect(targets[0]).toMatchObject({ tenant_id: tenantA, group_name: null });
    expect(responses.total).toBe(3);
    expect(responses.rows.map((response) => response.response_id)).toEqual([51, 52, 50].map(cfId));
    expect(responses.rows.map((response) => response.answers)).toEqual([ANSWERS, ANSWERS, ANSWERS]);
  });

  it("hides another tenant's rows", async () => {
    await inTenant(tenantB, (tx) => seedDetail(tx, cfId(20)));

    const seen = await inTenant(tenantA, async (tx) => [
      await listSurveys(tx, { siteId: 'tenant-a', ...FULL_PAGE }),
      await findSurvey(tx, cfId(20)),
      await getSurvey(tx, cfId(20)),
      await getSchedule(tx, cfId(20)),
      await listReminders(tx, cfId(20)),
      await listSchedulings(tx, [cfId(20)]),
      await listTargets(tx, cfId(20)),
      await listResponses(tx, cfId(20), FULL_PAGE),
    ]);

    expect(seen).toEqual([
      { rows: [], total: 0 },
      null,
      null,
      null,
      [],
      new Map([[cfId(20), { schedule: null, reminders: [] }]]),
      [],
      { rows: [], total: 0 },
    ]);
    expect(await inTenant(tenantB, (tx) => findSurvey(tx, cfId(20)))).toMatchObject({ tenant_id: tenantB });
  });

  it('rejects a read outside its tenant transaction', async () => {
    let ended: TenantTx | undefined;
    await inTenant(tenantA, async (tx) => {
      ended = tx;
    });

    await expect(listSurveys(ended as TenantTx, { siteId: 'tenant-a', ...FULL_PAGE })).rejects.toBeInstanceOf(OutsideTenantTransactionError);
    await expect(listSchedulings(ended as TenantTx, [cfId(1)])).rejects.toBeInstanceOf(OutsideTenantTransactionError);
    await expect(findSurvey(ended as TenantTx, cfId(1))).rejects.toBeInstanceOf(OutsideTenantTransactionError);
  });

  it.each(['executing', 'importing', 'import-pending'])('blocks reads of a unit in a window %s phase, and only that unit', async (phase) => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'closed', holder_id = 'window-1', phase = $1 WHERE unit = $2`, [
        phase,
        'surveys.survey_target',
      ]),
    );
    const budget = { budgetMs: 300 };

    await expect(withGatedTenant(handle.app, tenantA, (tx) => getSurvey(tx, cfId(1)), budget)).rejects.toBeInstanceOf(UnitReadBlockedError);
    await expect(withGatedTenant(handle.app, tenantA, (tx) => listTargets(tx, cfId(1)), budget)).rejects.toBeInstanceOf(UnitReadBlockedError);
    expect(await withGatedTenant(handle.app, tenantA, (tx) => listSurveys(tx, { siteId: 'tenant-a', ...FULL_PAGE }), budget)).toEqual({
      rows: [],
      total: 0,
    });
  });

  it.each(['surveys.survey_schedule', 'surveys.survey_reminder'])('blocks a batched scheduling read behind a closed %s gate, but not an empty one', async (unit) => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'closed', holder_id = 'window-1', phase = 'executing' WHERE unit = $1`, [unit]),
    );
    const budget = { budgetMs: 300 };

    await expect(withGatedTenant(handle.app, tenantA, (tx) => listSchedulings(tx, [cfId(1)]), budget)).rejects.toBeInstanceOf(
      UnitReadBlockedError,
    );
    expect(await withGatedTenant(handle.app, tenantA, (tx) => listSchedulings(tx, []), budget)).toEqual(new Map());
  });
});
