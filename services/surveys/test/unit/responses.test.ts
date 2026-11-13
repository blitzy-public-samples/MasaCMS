// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey responses against a throwaway `surveys` schema: own-tenant and granted respondents, notFound and forbidden, byte-exact answers, lists and gates. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { UnitNotAuthoritativeError, ensureUnitGates } from '@opt2/platform/migration-kit';
import { withMetadata, writeGrant } from '@opt2/platform/tenancy';
import type { Clock } from '@opt2/platform/service-kit';
import { LegacyApiError } from '@opt2/platform/legacy-compat';
import {
  TENANT_A,
  TENANT_B,
  TENANT_LIST,
  createThrowawaySchema,
  pgAvailable,
  seedRegistry,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { applyBulkTarget } from '../../src/domain/bulk-target.js';
import { listResponsePage, submitResponse, type SubmitResponseInput } from '../../src/domain/responses.js';
import type { DomainDeps } from '../../src/domain/surveys.js';
import { FixtureApiError } from '../../src/legacy/fixture-envelope.js';
import { SURVEY_RESPONSE_GRANT } from '../../src/repo/grants.js';
import { createSurveysRepository } from '../../src/repo/repository.js';
import { UNITS, type SurveyRow } from '../../src/repo/tables.js';

const T0 = new Date(2026, 5, 30, 10, 15, 30, 250);
const MANAGER_ID = '11111111-2222-3333-4444555566667777';
const RESPONDENT_ID = '99999999-8888-7777-6666555544443333';
const UNKNOWN_ID = '00000000-0000-0000-0000000000000000';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const ANSWERS = '{"q1":"yes","q2":"4"}';

const available = Boolean(process.env.PG_HOST) && (await pgAvailable());

describe.skipIf(!available)('survey responses against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let deps: DomainDeps;
  let now = T0;
  const clock: Clock = { now: () => new Date(now.getTime()) };

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'surveys',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await seedRegistry(handle.app, handle.schema);
    deps = { db: handle.app, repository: createSurveysRepository({ clock, schema: handle.schema }), clock };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    now = T0;
    await setGate(UNITS, 'open');
  });

  function setGate(units: readonly string[], state: 'open' | 'legacy'): Promise<unknown> {
    return withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $2, holder_id = NULL, phase = 'quiet' WHERE unit = ANY($1::text[])`, [units, state]),
    );
  }

  function newSurvey(owner: TenantFixture = TENANT_A): Promise<SurveyRow> {
    return handle.app.withTenant(owner.tenantId, (tx) =>
      deps.repository.insertSurvey(tx, { siteId: owner.siteId, title: 'Pulse', createdById: MANAGER_ID }),
    );
  }

  function target(surveyId: string, siteID: string): Promise<unknown> {
    return applyBulkTarget(deps, { tenantId: TENANT_A.tenantId, surveyId, input: [{ siteID }] });
  }

  function submit(as: TenantFixture, surveyId: string, input: SubmitResponseInput, site: string = as.siteId) {
    return submitResponse(deps, { tenantId: as.tenantId, site, userId: RESPONDENT_ID, surveyId, input });
  }

  /** Stored responses to `surveyId` per tenant fixture key, read in each tenant. */
  async function storedCounts(surveyId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const tenant of TENANT_LIST) {
      counts[tenant.key] = await handle.app.withTenant(tenant.tenantId, async (tx) => {
        const { rows } = await tx.query<{ n: number }>(
          `SELECT count(*)::integer AS n FROM ${handle.schema}.survey_response WHERE survey_id = $1`,
          [surveyId],
        );
        return rows[0]?.n ?? 0;
      });
    }
    return counts;
  }

  async function expectError(promise: Promise<unknown>, type: string, kind: typeof FixtureApiError | typeof LegacyApiError): Promise<void> {
    const error: unknown = await promise.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(kind);
    expect(error).toMatchObject({ type });
  }

  it('stores an own-tenant response under the survey site with the respondent and clock time', async () => {
    const survey = await newSurvey();
    const row = await submit(TENANT_A, survey.survey_id, { answers: ANSWERS });
    expect(row).toEqual({
      tenant_id: TENANT_A.tenantId,
      response_id: expect.stringMatching(CF_UUID),
      survey_id: survey.survey_id,
      siteid: TENANT_A.siteId,
      respondentsiteid: TENANT_A.siteId,
      respondent_user_id: RESPONDENT_ID,
      answers: ANSWERS,
      created: T0,
    });
    expect(await storedCounts(survey.survey_id)).toEqual({ A: 1, B: 0, umbrella: 0 });
  });

  it.each([
    ['as the target names it', TENANT_B.siteId],
    ['in another case, as SQL Server collation matches it', 'TENANT-B'],
  ])('stores a targeted site response in the grantor tenant, site %s', async (_label, site) => {
    const survey = await newSurvey();
    await target(survey.survey_id, TENANT_B.siteId);
    const row = await submit(TENANT_B, survey.survey_id, { answers: ANSWERS }, site);
    expect(row).toMatchObject({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, respondentsiteid: site });
    expect(await storedCounts(survey.survey_id)).toEqual({ A: 1, B: 0, umbrella: 0 });
    const listed = await listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: survey.survey_id, params: {} });
    expect(listed.list.map((r) => r.respondentsiteid)).toEqual([site]);
  });

  it.each([
    ['forbidden', 'an untargeted survey of another site', false, ANSWERS],
    ['forbidden', 'an untargeted survey of another site, before checking empty answers', false, ''],
    ['notFound', 'an unknown survey', true, ANSWERS],
  ])('answers %s and writes nothing for %s', async (type, _label, unknown, answers) => {
    const survey = await newSurvey();
    const surveyId = unknown ? UNKNOWN_ID : survey.survey_id;
    await expectError(submit(TENANT_B, surveyId, { answers }), type, FixtureApiError);
    expect(await storedCounts(surveyId)).toEqual({ A: 0, B: 0, umbrella: 0 });
  });

  it('answers forbidden and writes nothing when a grant outlives the survey target', async () => {
    const survey = await newSurvey();
    await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
      writeGrant(tx, { grantee: TENANT_B.tenantId, kind: SURVEY_RESPONSE_GRANT, resourceId: survey.survey_id }),
    );
    // The site check precedes the answers check, so empty answers still answer forbidden.
    await expectError(submit(TENANT_B, survey.survey_id, { answers: '' }), 'forbidden', FixtureApiError);
    expect(await storedCounts(survey.survey_id)).toEqual({ A: 0, B: 0, umbrella: 0 });
  });

  it.each<[string, unknown]>([
    ['absent', undefined],
    ['empty', ''],
    ['an object', { q1: 'yes' }],
    ['an array', ['yes']],
  ])('answers invalidParameters and writes nothing when answers are %s', async (_label, answers) => {
    const survey = await newSurvey();
    await expectError(submit(TENANT_A, survey.survey_id, { answers }), 'invalidParameters', LegacyApiError);
    expect(await storedCounts(survey.survey_id)).toEqual({ A: 0, B: 0, umbrella: 0 });
  });

  it('checks the survey before the answers', async () => {
    await expectError(submit(TENANT_A, UNKNOWN_ID, { answers: '' }), 'notFound', FixtureApiError);
  });

  it.each([
    ['JSON-looking text with spacing', '  { "q1" : "yes" ,\n "q2":4.0 }  '],
    ['unicode', 'Ünïcödé 日本語 \u{1F389} \u00A0'],
    ['whitespace only', ' \t\r\n '],
    ['JSON scalars as text', 'null'],
  ])('stores and lists %s byte-exact', async (_label, answers) => {
    const survey = await newSurvey();
    const row = await submit(TENANT_A, survey.survey_id, { answers });
    expect(row.answers).toBe(answers);
    const listed = await listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: survey.survey_id, params: {} });
    expect(listed.list.map((r) => Buffer.from(r.answers, 'utf8'))).toEqual([Buffer.from(answers, 'utf8')]);
  });

  it('lists every response by creation time and id, and only in the survey tenant', async () => {
    const survey = await newSurvey();
    await target(survey.survey_id, TENANT_B.siteId);
    const stored = [];
    for (const [offset, as] of [[2000, TENANT_A], [0, TENANT_B], [1000, TENANT_A]] as const) {
      now = new Date(T0.getTime() + offset);
      stored.push(await submit(as, survey.survey_id, { answers: ANSWERS }));
    }
    const listed = await listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: survey.survey_id, params: {} });
    expect(listed.totalItems).toBe(3);
    expect(listed.list.map((r) => r.response_id)).toEqual([stored[1], stored[2], stored[0]].map((r) => r?.response_id));
    await expectError(
      listResponsePage(deps, { tenantId: TENANT_B.tenantId, surveyId: survey.survey_id, params: {} }),
      'notFound',
      FixtureApiError,
    );

    const page = await listResponsePage(deps, {
      tenantId: TENANT_A.tenantId,
      surveyId: survey.survey_id,
      params: { pageIndex: '2', itemsPerPage: '1' },
    });
    expect(page).toEqual({ list: [listed.list[1]], pageIndex: 2, itemsPerPage: 1, totalItems: 3 });
    const past = await listResponsePage(deps, {
      tenantId: TENANT_A.tenantId,
      surveyId: survey.survey_id,
      params: { pageIndex: '4', itemsPerPage: '1' },
    });
    expect(past).toEqual({ list: [], pageIndex: 4, itemsPerPage: 1, totalItems: 3 });
  });

  it('pages with the fixture defaults and validates paging after the survey check', async () => {
    const survey = await newSurvey();
    await submit(TENANT_A, survey.survey_id, { answers: ANSWERS });
    const page = await listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: survey.survey_id, params: {} });
    expect(page).toMatchObject({ pageIndex: 1, itemsPerPage: 50, totalItems: 1 });
    const bad = { pageIndex: '0' };
    await expectError(
      listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: survey.survey_id, params: bad }),
      'invalidParameters',
      LegacyApiError,
    );
    await expectError(listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: UNKNOWN_ID, params: bad }), 'notFound', FixtureApiError);
    await expectError(listResponsePage(deps, { tenantId: TENANT_A.tenantId, surveyId: UNKNOWN_ID, params: {} }), 'notFound', FixtureApiError);
  });

  it.each([
    ['own tenant', TENANT_A],
    ['granted tenant', TENANT_B],
  ])('refuses a response while the response unit is legacy-authoritative (%s)', async (_label, as) => {
    const survey = await newSurvey();
    await target(survey.survey_id, TENANT_B.siteId);
    await setGate(['surveys.survey_response'], 'legacy');
    await expect(submit(as, survey.survey_id, { answers: ANSWERS })).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    expect(await storedCounts(survey.survey_id)).toEqual({ A: 0, B: 0, umbrella: 0 });
  });
});
