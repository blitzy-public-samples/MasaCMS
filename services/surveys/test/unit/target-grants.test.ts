// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey-response grants kept by the repository's generic `survey` and `survey_target` writes against a throwaway `surveys` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, ensureUnitGates } from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { withMetadata, writeGrant, type QueryConfig, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, createThrowawaySchema, fixedClock, pgAvailable, seedRegistry, type ThrowawaySchema } from '@opt2/platform/testing';
import { applyBulkTarget } from '../../src/domain/bulk-target.js';
import { SURVEY_RESPONSE_GRANT } from '../../src/repo/grants.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { SURVEY_TARGET, UNITS, type SurveyResponseRow, type SurveyRow, type SurveyTargetRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 14, 5, 9, 123);
const USER_ID = '11111111-2222-3333-4444555566667777';
const TABLE = SURVEY_TARGET.table;
// Long enough for an unblocked transaction of a few statements to commit.
const PENDING_MS = 250;

type Write = 'upsert' | 'update';
/** Where the first of two overlapping transactions is held: before COMMIT, or before its first `tenant_grant` statement. */
type Hold = 'commit' | 'grant';
/** One transaction's work over `db` on the survey and the ids of its seeded targets. */
type Op = (db: TenantDb, surveyId: string, seeded: readonly string[]) => Promise<unknown>;
/** Site and group of each target seeded before two transactions overlap. */
type Seed = ReadonlyArray<[string, string | null]>;
/** Another survey's expected target count and grantees after two transactions overlap. */
type Elsewhere = [surveyId: string, count: number, grantees: string[]];

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('survey-response grants of generic survey and survey_target writes', () => {
  let handle: ThrowawaySchema;
  let repository: SurveysRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repository = createSurveysRepository({ clock: fixedClock(NOW), schema: handle.schema });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app, handle.schema);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setTargetGate('open');
  });

  function setTargetGate(state: 'open' | 'legacy'): Promise<unknown> {
    return withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $2, holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`, [UNITS, state]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(TENANT_A.tenantId, fn);
  }

  function newSurvey(): Promise<SurveyRow> {
    return inTenant((tx) => repository.insertSurvey(tx, { siteId: TENANT_A.siteId, title: 'Pulse', createdById: USER_ID }));
  }

  function target(surveyId: string, siteid: string, groupName: string | null = null): Omit<SurveyTargetRow, 'tenant_id'> {
    return { target_id: cfUuid(), survey_id: surveyId, siteid, group_name: groupName, created: NOW };
  }

  /** Grantees of tenant A's `survey-response` grants on `surveyId`, sorted. */
  async function grantees(surveyId: string): Promise<string[]> {
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query<{ grantee_tenant: string }>(
        `SELECT grantee_tenant FROM ${handle.schema}.tenant_grant WHERE grantor_tenant = $1 AND kind = $2 AND resource_id = $3 ORDER BY grantee_tenant`,
        [TENANT_A.tenantId, SURVEY_RESPONSE_GRANT, surveyId],
      ),
    );
    return rows.map((row) => row.grantee_tenant);
  }

  /** Grantees of a stored tenant A survey: its own tenant's grant plus `others`, sorted. */
  function withOwner(...others: string[]): string[] {
    return [TENANT_A.tenantId, ...others].sort();
  }

  /** Moves the stored `row` to `patch` through the generic `write`. */
  function move(tx: TenantTx, write: Write, row: Omit<SurveyTargetRow, 'tenant_id'>, patch: Partial<SurveyTargetRow>): Promise<unknown> {
    return write === 'upsert'
      ? repository.upsert(tx, TABLE, { ...row, ...patch })
      : repository.update(tx, TABLE, { target_id: row.target_id }, patch);
  }

  async function targetCount(surveyId: string): Promise<number> {
    const { rows } = await inTenant((tx) =>
      tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.survey_target WHERE survey_id = $1`, [surveyId]),
    );
    return rows[0]?.n ?? 0;
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  /** `handle.app` whose tenant transactions call `reached` at `hold` and wait there for `release`. */
  function holdingDb(hold: Hold, reached: () => void, release: Promise<void>): TenantDb {
    const pause = async (): Promise<void> => {
      reached();
      await release;
    };
    return {
      schema: handle.app.schema,
      withTenant<T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
        return handle.app.withTenant(tenantId, async (tx) => {
          if (hold === 'commit') {
            const result = await fn(tx);
            await pause();
            return result;
          }
          let paused = false;
          const query = (async (text: string | QueryConfig, values?: unknown[]) => {
            if (!paused && /\btenant_grant\b/.test(typeof text === 'string' ? text : text.text)) {
              paused = true;
              await pause();
            }
            return tx.query(text, values);
          }) as TenantTx['query'];
          return fn({ ...tx, query });
        });
      },
      withMetadata: (fn) => handle.app.withMetadata(fn),
      end: () => Promise.resolve(),
    };
  }

  /** Runs `second` while `first` is held at `hold`, then releases `first`; true when `second` was still waiting at the release. */
  async function overlap(first: Op, hold: Hold, second: Op, surveyId: string, seeded: readonly string[]): Promise<boolean> {
    const reached = deferred();
    const release = deferred();
    const held = first(holdingDb(hold, reached.resolve, release.promise), surveyId, seeded);
    await Promise.race([reached.promise, held]);
    let settled = false;
    const waiting = second(handle.app, surveyId, seeded);
    void Promise.allSettled([waiting]).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, PENDING_MS));
    const pending = !settled;
    release.resolve();
    await Promise.all([held, waiting]);
    return pending;
  }

  const deleteSeeded =
    (n: number): Op =>
    (db, _surveyId, seeded) =>
      db.withTenant(TENANT_A.tenantId, (tx) => repository.delete(tx, TABLE, { target_id: seeded[n] }));
  const insertNew: Op = (db, surveyId) =>
    db.withTenant(TENANT_A.tenantId, (tx) => repository.insert(tx, TABLE, target(surveyId, 'tenant-b', 'Late')));
  const bulkTargeting: Op = (db, surveyId) =>
    applyBulkTarget(
      { db, repository, clock: fixedClock(NOW) },
      { tenantId: TENANT_A.tenantId, surveyId, input: [{ siteID: 'tenant-b', groupName: 'Bulk' }] },
    );
  const sharedTargetId = cfUuid();
  const otherSurveyId = cfUuid();
  const upsertShared =
    (elsewhere: boolean): Op =>
    (db, surveyId) =>
      db.withTenant(TENANT_A.tenantId, (tx) =>
        repository.upsert(tx, TABLE, { ...target(elsewhere ? otherSurveyId : surveyId, 'tenant-b'), target_id: sharedTargetId }),
      );

  it.each([
    ['a cross-site target', 'tenant-b', [TENANT_B.tenantId]],
    ['a cross-site target in another case with trailing spaces', 'TENANT-B  ', [TENANT_B.tenantId]],
    ['an own-site target', 'tenant-a', []],
    ['an own-site target in another case with a trailing space', 'Tenant-A ', []],
    ['a target of an unregistered site', 'tenant-z', []],
  ])('grants on a generic insert of %s exactly the tenants the registry gives', async (_label, siteid, expected) => {
    const survey = await newSurvey();
    await inTenant((tx) => repository.insert(tx, TABLE, target(survey.survey_id, siteid)));

    expect(await grantees(survey.survey_id)).toEqual(withOwner(...expected));
  });

  it('grants a tenant once for two targets of its site in another case, trailing spaces and group', async () => {
    const survey = await newSurvey();
    await inTenant(async (tx) => {
      await repository.insert(tx, TABLE, target(survey.survey_id, 'tenant-b'));
      await repository.upsert(tx, TABLE, target(survey.survey_id, 'TENANT-B ', 'Panel'));
    });

    expect(await grantees(survey.survey_id)).toEqual(withOwner(TENANT_B.tenantId));
  });

  it.each(
    (['upsert', 'update'] as const).flatMap((write) => [
      [write, 'drops the old tenant when no other target maps to it', false, [TENANT_UMBRELLA.tenantId]],
      [write, 'keeps the old tenant while another target maps to it', true, [TENANT_B.tenantId, TENANT_UMBRELLA.tenantId]],
    ]) as [Write, string, boolean, string[]][],
  )('re-syncs a generic %s moving a target to another site: %s', async (write, _label, sibling, expected) => {
    const survey = await newSurvey();
    const moved = target(survey.survey_id, 'tenant-b');
    await inTenant(async (tx) => {
      await repository.upsert(tx, TABLE, moved);
      if (sibling) await repository.upsert(tx, TABLE, target(survey.survey_id, 'Tenant-B', 'Panel'));
    });
    await inTenant((tx) => move(tx, write, moved, { siteid: 'umbrella' }));

    expect(await grantees(survey.survey_id)).toEqual(withOwner(...expected));
  });

  it.each(['upsert', 'update'] as const)('re-syncs both surveys when a generic %s moves a target to another survey', async (write) => {
    const [from, to] = [await newSurvey(), await newSurvey()];
    const moved = target(from.survey_id, 'tenant-b');
    await inTenant((tx) => repository.upsert(tx, TABLE, moved));
    await inTenant((tx) => move(tx, write, moved, { survey_id: to.survey_id }));

    expect(await grantees(from.survey_id)).toEqual(withOwner());
    expect(await grantees(to.survey_id)).toEqual(withOwner(TENANT_B.tenantId));
  });

  it('restores the grant of an unmoved target on a repeated upsert and changes nothing for an unknown update', async () => {
    const survey = await newSurvey();
    const row = target(survey.survey_id, 'tenant-b');
    await inTenant((tx) => repository.upsert(tx, TABLE, row));
    await withMetadata(handle.app, (tx) => tx.query(`DELETE FROM ${handle.schema}.tenant_grant WHERE resource_id = $1`, [survey.survey_id]));
    await inTenant((tx) => repository.upsert(tx, TABLE, { ...row, group_name: 'Panel' }));

    expect(await grantees(survey.survey_id)).toEqual([TENANT_B.tenantId]);
    expect(await inTenant((tx) => repository.update(tx, TABLE, { target_id: cfUuid() }, { siteid: 'umbrella' }))).toBeNull();
    expect(await grantees(survey.survey_id)).toEqual([TENANT_B.tenantId]);
  });

  it.each([
    ['the last target of its tenant', false, []],
    ['a target whose tenant another target still maps to', true, [TENANT_B.tenantId]],
  ])('a generic delete of %s re-syncs only its survey', async (_label, sibling, expected) => {
    const [survey, other] = [await newSurvey(), await newSurvey()];
    const removed = target(survey.survey_id, 'tenant-b');
    await inTenant(async (tx) => {
      await repository.upsert(tx, TABLE, removed);
      await repository.upsert(tx, TABLE, target(survey.survey_id, 'umbrella'));
      await repository.upsert(tx, TABLE, target(other.survey_id, 'tenant-b'));
      if (sibling) await repository.upsert(tx, TABLE, target(survey.survey_id, 'TENANT-B', 'Panel'));
      await writeGrant(tx, { grantee: TENANT_B.tenantId, kind: 'other-kind', resourceId: survey.survey_id });
    });
    const deleted = await inTenant((tx) => repository.delete(tx, TABLE, { target_id: removed.target_id }));
    const again = await inTenant((tx) => repository.delete(tx, TABLE, { target_id: removed.target_id }));

    expect(deleted).toMatchObject({ target_id: removed.target_id });
    expect(again).toBeNull();
    expect(await grantees(survey.survey_id)).toEqual(withOwner(...expected, TENANT_UMBRELLA.tenantId));
    expect(await grantees(other.survey_id)).toEqual(withOwner(TENANT_B.tenantId));
    const { rows } = await withMetadata(handle.app, (tx) =>
      tx.query(`SELECT 1 FROM ${handle.schema}.tenant_grant WHERE resource_id = $1 AND kind = 'other-kind'`, [survey.survey_id]),
    );
    expect(rows).toHaveLength(1);
  });

  it('writes its grants in the caller transaction, so a rollback leaves none', async () => {
    const survey = await newSurvey();
    const failure = new Error('rolled back');
    await expect(
      inTenant(async (tx) => {
        await repository.insert(tx, TABLE, target(survey.survey_id, 'tenant-b'));
        await repository.upsert(tx, TABLE, target(survey.survey_id, 'umbrella'));
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(await grantees(survey.survey_id)).toEqual(withOwner());
  });

  it('refuses a live generic upsert of a unit that is not target-authoritative before writing a grant', async () => {
    const survey = await newSurvey();
    await setTargetGate('legacy');

    await expect(inTenant((tx) => repository.upsert(tx, TABLE, target(survey.survey_id, 'tenant-b')))).rejects.toBeInstanceOf(
      UnitNotAuthoritativeError,
    );
    expect(await grantees(survey.survey_id)).toEqual(withOwner());
  });

  it.each(['insert', 'upsert'] as const)(
    'grants the survey tenant its own grant on a generic survey %s and drops only that grant with the survey',
    async (write) => {
      const surveyId = cfUuid();
      const row = { survey_id: surveyId, siteid: TENANT_A.siteId, title: 'T', status: 'DRAFT', created: NOW, createdbyid: USER_ID };
      const stored = await inTenant((tx) => repository[write]<SurveyRow>(tx, 'survey', row));
      await inTenant((tx) => repository.upsert(tx, TABLE, target(surveyId, 'tenant-b')));

      const key = { survey_id: surveyId };
      expect(stored.title).toBe('T');
      expect(await grantees(surveyId)).toEqual(withOwner(TENANT_B.tenantId));
      expect(await inTenant((tx) => repository.update<SurveyRow>(tx, 'survey', key, { title: 'V' }))).toMatchObject({ title: 'V' });
      expect(await grantees(surveyId)).toEqual(withOwner(TENANT_B.tenantId));
      expect(await inTenant((tx) => repository.delete<SurveyRow>(tx, 'survey', key))).toMatchObject({ title: 'V' });
      expect(await grantees(surveyId)).toEqual([TENANT_B.tenantId]);
      expect(await inTenant((tx) => repository.delete<SurveyRow>(tx, 'survey', key))).toBeNull();
    },
  );

  it('delegates generic writes of other tables unchanged and grants nothing for them', async () => {
    const surveyId = cfUuid();
    const row = {
      response_id: cfUuid(),
      survey_id: surveyId,
      siteid: 'tenant-a',
      respondentsiteid: 'tenant-b',
      respondent_user_id: USER_ID,
      answers: 'T',
      created: NOW,
    };
    const key = { response_id: row.response_id };
    const [inserted, upserted, updated, deleted] = await inTenant(async (tx) => [
      await repository.insert<SurveyResponseRow>(tx, 'survey_response', row),
      await repository.upsert<SurveyResponseRow>(tx, 'survey_response', { ...row, answers: 'U' }),
      await repository.update<SurveyResponseRow>(tx, 'survey_response', key, { answers: 'V' }),
      await repository.delete<SurveyResponseRow>(tx, 'survey_response', key),
    ]);

    expect([inserted.answers, upserted.answers, updated?.answers, deleted?.answers]).toEqual(['T', 'U', 'V', 'V']);
    expect(await grantees(surveyId)).toEqual([]);
  });

  const oneTarget: Seed = [['tenant-b', null]];
  const twoTargets: Seed = [
    ['tenant-b', null],
    ['TENANT-B', 'Panel'],
  ];
  const grantedB = [TENANT_B.tenantId];

  it.each<[string, Seed, Op, Hold, Op, number, string[], Elsewhere?]>([
    ['two tenant-b target deletes, the first held before commit', twoTargets, deleteSeeded(0), 'commit', deleteSeeded(1), 0, []],
    ['two tenant-b target deletes, the first held after its target scan', twoTargets, deleteSeeded(0), 'grant', deleteSeeded(1), 0, []],
    ['a last-target delete held after its target scan, then an insert', oneTarget, deleteSeeded(0), 'grant', insertNew, 1, grantedB],
    ['an insert held before commit, then a delete of the old target', oneTarget, insertNew, 'commit', deleteSeeded(0), 1, grantedB],
    ['live bulk targeting held before commit, then a generic delete', oneTarget, bulkTargeting, 'commit', deleteSeeded(0), 1, grantedB],
    [
      'first upserts of one new target under two surveys, the first held before commit',
      [],
      upsertShared(false),
      'commit',
      upsertShared(true),
      0,
      [],
      [otherSurveyId, 1, grantedB],
    ],
  ])('serializes %s, so the grants match the committed targets', async (_label, seed, first, hold, second, count, expected, elsewhere) => {
    const survey = await newSurvey();
    const seeded: string[] = [];
    for (const [siteid, groupName] of seed) {
      const row = target(survey.survey_id, siteid, groupName);
      await inTenant((tx) => repository.upsert(tx, TABLE, row));
      seeded.push(row.target_id);
    }

    expect(await overlap(first, hold, second, survey.survey_id, seeded)).toBe(true);
    expect(await targetCount(survey.survey_id)).toBe(count);
    expect(await grantees(survey.survey_id)).toEqual(withOwner(...expected));
    if (elsewhere !== undefined) {
      const [otherId, otherCount, otherGrantees] = elsewhere;
      expect(await targetCount(otherId)).toBe(otherCount);
      expect(await grantees(otherId)).toEqual(otherGrantees);
    }
  });
});
