// SYNTHETIC: surveys - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Survey-response grants through the fixture routes: grants bulk targeting writes, and responses checked against them and stored in the grantor tenant. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';
import { FIXTURE_ERROR_MAP } from '../../src/legacy/fixture-envelope.js';
import { FIXTURE_BASE } from '../../src/routes/fixture.js';
import { buildTestApp, headersFor, type RecordedTransaction, type RecordingDb, type TestApp } from '../helpers/app.js';

type Headers = Record<string, string>;
type Row = Record<string, unknown>;

/** The parts of a fixture envelope these cases read. */
interface FixtureBody {
  data?: Row & { items?: Row[] };
  error?: { code: string; message: string };
}

/** Where a request carries its params: the query string, a form body or a JSON body. */
type Carrier = 'query' | 'form' | 'json';

const CSRF_HEADERS: Headers = { 'x-csrf_token': 'CSRF-TOKEN', 'x-csrf_token_expires': '260630140509000' };
const INVALID_PARAMETERS = { code: 'invalid_request', message: 'Invalid parameters' };
const FORBIDDEN = { code: FIXTURE_ERROR_MAP.forbidden.code, message: FIXTURE_ERROR_MAP.forbidden.message };
const NOT_FOUND = { code: FIXTURE_ERROR_MAP.notFound.code, message: FIXTURE_ERROR_MAP.notFound.message };
// Spacing, JSON-looking text and non-ASCII text, none of which the store may normalise.
const ANSWERS = '  { "q1" : "yes" ,\n "q2":4.0 }  Ünïcödé 日本語 \u{1F389}\u00A0';

const GRANT_INSERT = /^INSERT INTO "?surveys"?\."?tenant_grant"?/;
const GRANT_READ = /\bFROM "?surveys"?\."?tenant_grant"?/;
const TARGET_INSERT = /^INSERT INTO "?surveys"?\."?survey_target"?/;
const RESPONSE_INSERT = /^INSERT INTO "?surveys"?\."?survey_response"?/;
const SURVEY_INSERT = /^INSERT INTO "?surveys"?\."?survey"? /;
const UNKNOWN_SURVEY_ID = '00000000-0000-0000-0000000000000000';

describe('survey-response grants and multi-site responses through the fixture routes', () => {
  let harness: TestApp<RecordingDb>;
  let manager: Headers;

  beforeEach(async () => {
    // buildTestApp seeds tenant_registry with tenant-a, tenant-b and umbrella through db.seedRegistry().
    harness = await buildTestApp();
    manager = await headersFor('surveys.manager');
  });

  afterEach(async () => {
    await harness.app.close();
  });

  /** POSTs `params` to `url` as `headers`, in the query string, a form body or a JSON body. */
  async function post(url: string, headers: Headers, params: Row, carrier: Carrier = 'json') {
    const base = { method: 'POST' as const, headers: { ...headers, ...CSRF_HEADERS } };
    if (carrier === 'json') {
      return harness.app.inject({ ...base, url, headers: { ...base.headers, 'content-type': 'application/json' }, payload: JSON.stringify(params) });
    }
    const encoded = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([name, value]) => [name, String(value)]))).toString();
    if (carrier === 'query') {
      return harness.app.inject({ ...base, url: `${url}?${encoded}` });
    }
    return harness.app.inject({
      ...base,
      url,
      headers: { ...base.headers, 'content-type': 'application/x-www-form-urlencoded' },
      payload: encoded,
    });
  }

  async function createSurvey(title: string): Promise<string> {
    const res = await post(FIXTURE_BASE, manager, { title });
    expect(res.statusCode).toBe(200);
    return String(res.json<FixtureBody>().data?.survey_id);
  }

  function bulkTarget(surveyId: string, siteIds: readonly string[]) {
    return post(`${FIXTURE_BASE}/${surveyId}/targets/bulk`, manager, { targets: siteIds.map((siteID) => ({ siteID })) });
  }

  /** A tenant-a survey targeting tenant-a and tenant-b. */
  async function targetedSurvey(): Promise<string> {
    const surveyId = await createSurvey('Pulse');
    expect((await bulkTarget(surveyId, [TENANT_A.siteId, TENANT_B.siteId])).statusCode).toBe(200);
    return surveyId;
  }

  function respond(surveyId: string, headers: Headers, params: Row = { answers: ANSWERS }, carrier: Carrier = 'json') {
    return post(`${FIXTURE_BASE}/${surveyId}/responses`, headers, params, carrier);
  }

  function listResponses(surveyId: string, headers: Headers) {
    return harness.app.inject({ method: 'GET', url: `${FIXTURE_BASE}/${surveyId}/responses`, headers });
  }

  function grants(): Row[] {
    return harness.db
      .rows('tenant_grant')
      .map(({ grantor_tenant, grantee_tenant, kind, resource_id }) => ({ grantor_tenant, grantee_tenant, kind, resource_id }));
  }

  /** Tenant A's own `survey-response` grant on its survey `surveyId`. */
  function ownGrant(surveyId: string): Row {
    return { grantor_tenant: TENANT_A.tenantId, grantee_tenant: TENANT_A.tenantId, kind: 'survey-response', resource_id: surveyId };
  }

  /** Transactions recorded from index `from` on, optionally only those that ran a statement matching `pattern`. */
  function transactionsSince(from: number, pattern?: RegExp): RecordedTransaction[] {
    return harness.db.transactions
      .slice(from)
      .filter((tx) => pattern === undefined || tx.statements.some((statement) => pattern.test(statement.text)));
  }

  function tenantsSince(from: number): Set<string | null> {
    return new Set(transactionsSince(from).map((tx) => tx.tenantId));
  }

  it('grants the survey tenant its own survey-response grant in the transaction that creates the survey', async () => {
    const from = harness.db.transactions.length;

    const surveyId = await createSurvey('Pulse');

    expect(grants()).toEqual([ownGrant(surveyId)]);
    const writes = transactionsSince(from, GRANT_INSERT);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ tenantId: TENANT_A.tenantId, committed: true });
    expect(writes[0]?.statements.some((statement) => SURVEY_INSERT.test(statement.text))).toBe(true);
  });

  describe('bulk targeting', () => {
    it('refuses a target list naming a site outside the registry and stores no target or grant for any site', async () => {
      const surveyId = await createSurvey('Pulse');

      // As surveys.cfc targetRows does for a site settingsManager does not know: invalidParameters before any target is stored.
      const res = await bulkTarget(surveyId, [TENANT_A.siteId, TENANT_B.siteId, 'not-registered']);

      expect(res.statusCode).toBe(400);
      expect(res.json<FixtureBody>().error).toEqual(INVALID_PARAMETERS);
      expect(harness.db.rows('survey_target')).toEqual([]);
      expect(grants()).toEqual([ownGrant(surveyId)]);
    });

    it('grants only the targeted site of another tenant, in the transaction that stores the targets', async () => {
      const surveyId = await createSurvey('Pulse');
      const from = harness.db.transactions.length;

      const res = await bulkTarget(surveyId, [TENANT_A.siteId, TENANT_B.siteId]);

      expect(res.statusCode).toBe(200);
      expect(res.json<FixtureBody>().data).toEqual({ inserted: 2, total: 2 });
      const targets = harness.db.rows('survey_target');
      expect(targets.map((row) => row.siteid).sort()).toEqual([TENANT_A.siteId, TENANT_B.siteId]);
      expect(targets.every((row) => row.tenant_id === TENANT_A.tenantId && row.survey_id === surveyId)).toBe(true);
      expect(grants()).toEqual([
        ownGrant(surveyId),
        { grantor_tenant: TENANT_A.tenantId, grantee_tenant: TENANT_B.tenantId, kind: 'survey-response', resource_id: surveyId },
      ]);
      const writes = transactionsSince(from, GRANT_INSERT);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ tenantId: TENANT_A.tenantId, committed: true });
      expect(writes[0]?.statements.some((statement) => TARGET_INSERT.test(statement.text))).toBe(true);
    });

    it('adds no target or grant when the same sites are targeted again', async () => {
      const surveyId = await targetedSurvey();

      const res = await bulkTarget(surveyId, [TENANT_A.siteId, TENANT_B.siteId]);

      expect(res.statusCode).toBe(200);
      expect(res.json<FixtureBody>().data).toEqual({ inserted: 0, total: 2 });
      expect(harness.db.rows('survey_target')).toHaveLength(2);
      expect(grants()).toHaveLength(2);
    });
  });

  describe('responses', () => {
    let respondentB: Headers;

    beforeEach(async () => {
      respondentB = await headersFor('system-user', { site: TENANT_B.siteId });
    });

    it('stores a granted site response in the grantor tenant under the survey site, answers byte-exact', async () => {
      const surveyId = await targetedSurvey();
      const from = harness.db.transactions.length;

      const res = await respond(surveyId, respondentB);

      expect(res.statusCode).toBe(200);
      expect(res.json<FixtureBody>().data).toMatchObject({
        survey_id: surveyId,
        siteid: TENANT_A.siteId,
        respondentsiteid: TENANT_B.siteId,
        answers: ANSWERS,
      });
      const [stored, ...others] = harness.db.rows('survey_response');
      expect(others).toEqual([]);
      expect(stored).toMatchObject({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, respondentsiteid: TENANT_B.siteId });
      expect(Buffer.from(String(stored?.answers), 'utf8')).toEqual(Buffer.from(ANSWERS, 'utf8'));
      const writes = transactionsSince(from, RESPONSE_INSERT);
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ tenantId: TENANT_A.tenantId, committed: true });
    });

    it.each([
      ['forbidden', 403, 'another tenant survey it holds no grant on', FORBIDDEN, false],
      ['notFound', 404, 'a survey id stored in no tenant', NOT_FOUND, true],
    ])('answers %s with %i for %s, probing no tenant but its own', async (_type, status, _label, error, unknown) => {
      await targetedSurvey();
      const ungranted = unknown ? UNKNOWN_SURVEY_ID : await createSurvey('Closed');
      const from = harness.db.transactions.length;

      const res = await respond(ungranted, respondentB);

      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual({ apiversion: 'v1', method: 'surveys.surveys.responses', error });
      expect(tenantsSince(from)).toEqual(new Set([null, TENANT_B.tenantId]));
      expect(transactionsSince(from, GRANT_READ).every((tx) => tx.tenantId === null)).toBe(true);
      expect(transactionsSince(from, GRANT_READ)).not.toHaveLength(0);
      expect(harness.db.rows('survey_response')).toEqual([]);
    });

    it.each<Carrier>(['json', 'form'])('ignores tenant and respondent claims in a %s body and stores under the grantor with the token site', async (carrier) => {
      const surveyId = await targetedSurvey();
      const from = harness.db.transactions.length;
      const claims = {
        answers: ANSWERS,
        tenantId: TENANT_UMBRELLA.tenantId,
        tid: TENANT_UMBRELLA.tenantId,
        respondentSiteID: TENANT_UMBRELLA.siteId,
      };

      const res = await respond(surveyId, respondentB, claims, carrier);

      expect(res.statusCode).toBe(200);
      expect(harness.db.rows('survey_response')).toEqual([
        expect.objectContaining({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, respondentsiteid: TENANT_B.siteId }),
      ]);
      expect(tenantsSince(from).has(TENANT_UMBRELLA.tenantId)).toBe(false);
    });

    // resolveSite reads siteid from the merged params, a JSON body included, so another site's siteid is refused, never ignored.
    it.each<[Carrier, string]>([
      ['query', TENANT_A.siteId],
      ['form', TENANT_A.siteId],
      ['json', TENANT_UMBRELLA.siteId],
    ])('refuses a %s siteid of %s with a tenant-b token and writes nothing', async (carrier, siteid) => {
      const surveyId = await targetedSurvey();
      const from = harness.db.transactions.length;

      const res = await respond(surveyId, respondentB, { siteid, answers: ANSWERS }, carrier);

      expect(res.statusCode).toBe(403);
      expect(res.json<FixtureBody>().error).toEqual(FORBIDDEN);
      expect(tenantsSince(from)).toEqual(new Set([null]));
      expect(harness.db.rows('survey_response')).toEqual([]);
    });

    it('stores an own-site response in the survey tenant without consulting a grant', async () => {
      const surveyId = await createSurvey('Pulse');
      const from = harness.db.transactions.length;

      const res = await respond(surveyId, await headersFor('system-user'));

      expect(res.statusCode).toBe(200);
      expect(harness.db.rows('survey_response')).toEqual([
        expect.objectContaining({ tenant_id: TENANT_A.tenantId, siteid: TENANT_A.siteId, respondentsiteid: TENANT_A.siteId }),
      ]);
      expect(transactionsSince(from, GRANT_READ)).toEqual([]);
      expect(tenantsSince(from)).toEqual(new Set([null, TENANT_A.tenantId]));
    });

    it('lists every response to the survey tenant manager and reveals none to another tenant manager', async () => {
      const surveyId = await targetedSurvey();
      const ids: string[] = [];
      for (const respondent of [respondentB, await headersFor('system-user')]) {
        const res = await respond(surveyId, respondent);
        expect(res.statusCode).toBe(200);
        ids.push(String(res.json<FixtureBody>().data?.response_id));
      }

      const own = await listResponses(surveyId, manager);
      const other = await listResponses(surveyId, await headersFor('surveys.manager', { site: TENANT_B.siteId }));

      expect(own.statusCode).toBe(200);
      const items = own.json<FixtureBody>().data?.items ?? [];
      expect(items.map((item) => item.response_id).sort()).toEqual([...ids].sort());
      expect(items.map((item) => item.respondentsiteid).sort()).toEqual([TENANT_A.siteId, TENANT_B.siteId]);
      expect(other.statusCode).toBe(404);
      expect(other.json<FixtureBody>().error).toEqual(NOT_FOUND);
      for (const id of ids) expect(other.body).not.toContain(id);
    });
  });
});
