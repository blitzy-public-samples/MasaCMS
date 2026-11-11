// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey create, list and detail against a throwaway `surveys` schema: fixture defaults, title validation, notFound, isolation and gates. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GateRaceError, UnitNotAuthoritativeError, ensureUnitGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { fixedClock } from '@opt2/platform/service-kit';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  SURVEY_STATUS,
  SURVEY_STATUSES,
  createSurvey,
  getSurvey,
  listSurveys,
  requireSurvey,
  type CreateSurveyInput,
  type DomainDeps,
} from '../../src/domain/surveys.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { createSurveysRepository, type SurveysRepository } from '../../src/repo/repository.js';
import { UNITS } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 9, 0, 0, 123);
const USER_ID = '11111111-2222-3333-4444555566667777';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

describe('SURVEY_STATUS', () => {
  it('names every status as itself and cannot change', () => {
    expect(Object.entries(SURVEY_STATUS)).toEqual(SURVEY_STATUSES.map((status) => [status, status]));
    expect(Object.isFrozen(SURVEY_STATUS)).toBe(true);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('surveys domain against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: DomainDeps;
  let sites = 0;
  let siteA: string;
  let tenantA: string;
  let tenantB: string;

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
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    sites += 1;
    siteA = `surveys-domain-a-${sites}`;
    tenantA = tenantIdForSite(siteA);
    tenantB = tenantIdForSite(`surveys-domain-b-${sites}`);
  });

  function create(input: CreateSurveyInput, against: DomainDeps = deps) {
    return createSurvey(against, { tenantId: tenantA, siteId: siteA, userId: USER_ID, input });
  }

  function countSurveys(tenantId: string): Promise<number> {
    return handle.app.withTenant(tenantId, async (tx: TenantTx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT count(*)::integer AS n FROM ${handle.schema}.survey`);
      return rows[0]?.n ?? 0;
    });
  }

  it('creates a DRAFT survey with a CF UUID, the clock time and the creator, and returns the detail getSurvey reads', async () => {
    const created = await create({ title: 'Pulse' });

    expect(created.survey).toMatchObject({
      tenant_id: tenantA,
      siteid: siteA,
      title: 'Pulse',
      status: SURVEY_STATUS.DRAFT,
      createdbyid: USER_ID,
      lastupdate: null,
      lastupdatebyid: null,
      launched_at: null,
    });
    expect(created.survey.survey_id).toMatch(CF_UUID);
    expect(created.survey.created.getTime()).toBe(T0.getTime());
    expect(created).toMatchObject({ schedule: null, reminders: [], targets: [] });
    await expect(getSurvey(deps, { tenantId: tenantA, surveyId: created.survey.survey_id })).resolves.toEqual(created);
    await expect(handle.app.withTenant(tenantA, (tx) => requireSurvey(tx, created.survey.survey_id))).resolves.toEqual(created.survey);
  });

  it.each([
    ['absent', {}],
    ['null', { title: null }],
    ['empty', { title: '' }],
    ['blank once trimmed', { title: ' \t\r\n\u0001' }],
    ['longer than 255 characters', { title: 'x'.repeat(256) }],
    ['a struct', { title: { text: 'Pulse' } }],
    ['an array', { title: ['Pulse'] }],
  ])('answers invalidParameters for a title that is %s and writes nothing', async (_case, input: CreateSurveyInput) => {
    const error = await create(input).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LegacyApiError);
    expect(error).toMatchObject({ type: 'invalidParameters' });
    expect(await countSurveys(tenantA)).toBe(0);
  });

  it.each([
    ['255 characters', 'y'.repeat(255), 'y'.repeat(255)],
    ['surrounding spaces', '  Pulse  ', '  Pulse  '],
    ['a number', 42, '42'],
  ])('stores a title of %s as given', async (_case, title, stored) => {
    const created = await create({ title });

    expect(created.survey.title).toBe(stored);
  });

  it('answers the fixture notFound with its default message for an unknown id and for another tenant\'s survey', async () => {
    const { survey } = await create({ title: 'Pulse' });

    for (const [tenantId, surveyId] of [
      [tenantA, UNKNOWN_ID],
      [tenantB, survey.survey_id],
    ] as const) {
      for (const attempt of [
        () => getSurvey(deps, { tenantId, surveyId }),
        () => handle.app.withTenant(tenantId, (tx) => requireSurvey(tx, surveyId)),
      ]) {
        const error = await attempt().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(FixtureApiError);
        expect(error).toMatchObject({ type: 'notFound', messageOverride: undefined });
      }
    }
  });

  it('lists the site\'s surveys by creation time and id with the total, paged, and none of another tenant\'s', async () => {
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await create({ title })).survey.survey_id);
    }
    ids.sort();

    const all = await listSurveys(deps, { tenantId: tenantA, filters: { siteId: siteA } });
    const second = await listSurveys(deps, { tenantId: tenantA, filters: { siteId: siteA, pageIndex: 2, itemsPerPage: 2 } });
    const other = await listSurveys(deps, { tenantId: tenantB, filters: { siteId: siteA } });

    expect(all.rows.map((row) => row.survey_id)).toEqual(ids);
    expect(all.total).toBe(3);
    expect(second.rows.map((row) => row.survey_id)).toEqual(ids.slice(2));
    expect(second.total).toBe(3);
    expect(other).toEqual({ rows: [], total: 0 });
  });

  it('re-runs the create after a gate race and stores exactly one survey', async () => {
    let races = 0;
    const racing: SurveysRepository = {
      ...deps.repository,
      insertSurvey: async (tx, input, ctx) => {
        const row = await deps.repository.insertSurvey(tx, input, ctx);
        if (races === 0) {
          races += 1;
          throw new GateRaceError(['surveys.survey']);
        }
        return row;
      },
    };

    const created = await create({ title: 'Pulse' }, { ...deps, repository: racing });

    expect(races).toBe(1);
    expect(await countSurveys(tenantA)).toBe(1);
    await expect(getSurvey(deps, { tenantId: tenantA, surveyId: created.survey.survey_id })).resolves.toEqual(created);
  });

  it('propagates the unavailability of a legacy-authoritative survey unit unchanged', async () => {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'legacy' WHERE unit = 'surveys.survey'`),
    );

    await expect(create({ title: 'Pulse' })).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(await countSurveys(tenantA)).toBe(0);
  });
});
