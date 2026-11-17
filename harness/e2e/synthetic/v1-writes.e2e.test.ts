// Successful /v1 writes of finance, surveys, communications, reporting and timesheets under cut-over table v0002: each
// module's seeded role user, adopted into identity, writes through web's gateway relay; the 200 answer is checked
// against the service contract and the write is read back over /v1.
import { readFileSync } from 'node:fs';
import { Roles } from '@opt2/platform/auth';
import { assertResponseMatchesOpenApi } from '@opt2/platform/testing';
import { beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { parse } from 'yaml';

import { FIXTURES_UNAVAILABLE, type FixtureStatus } from '../../src/golden/catalogue.js';
import { loadSeedStore, type SeedStore } from '../../src/golden/session.js';
import { repoPath } from '../../src/lib/paths.js';
import { openIdentitySession, type IdentitySession, type RelayCall } from '../helpers/identity-session.js';
import { fixtureStatus, requireTableVersion } from '../helpers/stack.js';

const TABLE_VERSION = 'v0002';
/** Run-unique text the writes carry, so each read-back finds this run's row. */
const MARKER = `opt2-e2e-v1-${Date.now().toString(36)}`;
const SHEET_PAGE_SIZE = 100;
const TEMPLATE_PAGE_SIZE = 1000;
/** Collection writes validate their token under the empty route id. */
const COLLECTION_CSRF_CONTEXT = '';

interface FinanceRecord {
  record_id: string;
  title: string;
  amount: string;
  period: string;
  state: string;
  version: number;
  lastupdatebyid: string;
}

interface FinanceVersion {
  version: number;
  action: string;
  title: string;
  actor_user_id: string;
}

interface Survey {
  surveyId: string;
}

interface SurveyTarget {
  siteId: string;
  groupName: string | null;
}

interface MessageTemplate {
  template_id: string;
  siteid: string;
  name: string;
  subject: string;
  body_text: string;
  body_html: string;
}

interface TemplatePage {
  items: MessageTemplate[];
  totalpages: number;
}

interface ExportJob {
  job_id: string;
  siteid: string;
  definition_id: string;
  format: string;
  state: string;
  requested_by_id: string;
  error: string;
}

interface Sheet {
  timesheetId: string;
  personId: string;
  status: string;
}

interface SheetDay {
  dayId: string;
  state: string;
  lastUpdateById: string | null;
  allowedActions: string[];
}

interface SheetDetail extends Sheet {
  days: SheetDay[];
}

interface DayActionResult {
  dayId: string;
  timesheetId: string;
  action: string;
  fromState: string;
  toState: string;
  blackout: boolean;
}

const contracts = new Map<string, object>();

/** The parsed `services/<service>/contracts/openapi.yaml`, read once. */
function contractOf(service: string): object {
  let doc = contracts.get(service);
  if (doc === undefined) {
    doc = parse(readFileSync(repoPath('services', service, 'contracts', 'openapi.yaml'), 'utf8')) as object;
    contracts.set(service, doc);
  }
  return doc;
}

/** Whether two CF UUIDs are equal, ignoring case. */
function sameId(actual: string | null | undefined, expected: string): boolean {
  return typeof actual === 'string' && actual.toUpperCase() === expected.toUpperCase();
}

/** Relays `call` and returns its body once the answer is a 200 that the service contract declares. */
async function contractCall<T>(actor: IdentitySession, service: string, call: RelayCall): Promise<T> {
  const result = await actor.relay(service, call);
  const label = `${call.method} ${service} ${call.path} as ${actor.role}`;
  expect(result.status, `${label} answered ${result.status}: ${result.text.slice(0, 500)}`).toBe(200);
  return assertResponseMatchesOpenApi(contractOf(service), {
    method: call.method,
    path: call.path,
    status: result.status,
    contentType: result.headers['content-type'],
    body: result.text,
  }) as T;
}

/** Opens `role`'s identity session and checks its user token carries the role. */
async function actorFor(role: string): Promise<IdentitySession> {
  const actor = await openIdentitySession(role);
  expect(actor.claims.roles, `user token of ${actor.username}`).toContain(role);
  return actor;
}

/** Upper-cased `reserved.rehearsal.persons`, which only the GS-PE-RH scenarios may touch. */
function reservedPersons(seed: SeedStore): ReadonlySet<string> {
  const rehearsal = seed.select({ as: 'rehearsal', source: 'reserved', path: 'reserved.rehearsal' }) as { persons?: unknown };
  const { persons } = rehearsal;
  if (!Array.isArray(persons) || !persons.every((person): person is string => typeof person === 'string')) {
    throw new Error('reserved.rehearsal.persons in the seed config is not a list of ids');
  }
  return new Set(persons.map((person) => person.toUpperCase()));
}

/** The first day the employee may submit, on a sheet outside the reserved persons, draft sheets first on each page. */
async function submittableDay(employee: IdentitySession, reserved: ReadonlySet<string>): Promise<{ sheet: Sheet; day: SheetDay }> {
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = await contractCall<{ items: Sheet[]; total: number }>(employee, 'timesheets', {
      method: 'GET',
      path: '/v1/timesheets/sheets',
      query: { pageIndex: String(pageIndex), itemsPerPage: String(SHEET_PAGE_SIZE) },
    });
    const candidates = page.items
      .filter((sheet) => sheet.status !== 'APPROVED' && !reserved.has(sheet.personId.toUpperCase()))
      .sort((a, b) => Number(b.status === 'DRAFT') - Number(a.status === 'DRAFT'));
    for (const sheet of candidates) {
      const detail = await contractCall<SheetDetail>(employee, 'timesheets', {
        method: 'GET',
        path: `/v1/timesheets/sheets/${sheet.timesheetId}`,
      });
      const day = detail.days.find((candidate) => candidate.allowedActions.includes('submit'));
      if (day !== undefined) return { sheet, day };
    }
    if (pageIndex * SHEET_PAGE_SIZE >= page.total) {
      throw new Error(`${employee.site} has no day ${employee.role} may submit outside reserved.rehearsal`);
    }
  }
}

/** The site's template `templateId` from the `/v1` template list, or undefined when no page holds it. */
async function listedTemplate(sender: IdentitySession, templateId: string): Promise<MessageTemplate | undefined> {
  for (let pageIndex = 1; ; pageIndex += 1) {
    const page = await contractCall<{ data: TemplatePage }>(sender, 'communications', {
      method: 'GET',
      path: '/v1/templates',
      query: { siteid: sender.site, pageIndex: String(pageIndex), itemsPerPage: String(TEMPLATE_PAGE_SIZE) },
    });
    const found = page.data.items.find((template) => template.template_id === templateId);
    if (found !== undefined || pageIndex >= page.data.totalpages) return found;
  }
}

describe('synthetic /v1 writes through the gateway relay', () => {
  let fixtures: FixtureStatus;
  let seed: SeedStore;

  beforeAll(async () => {
    await requireTableVersion(TABLE_VERSION);
    fixtures = fixtureStatus();
    seed = loadSeedStore();
  });

  /** Skips the test when the legacy fixtures, which seed the module role groups, are unavailable. */
  function requireFixtures(ctx: TestContext): void {
    if (!fixtures.available) ctx.skip(`${FIXTURES_UNAVAILABLE}: ${fixtures.reason ?? 'no reason recorded'}`);
  }

  it('finance: a preparer edit writes the record and a new version', async (ctx) => {
    requireFixtures(ctx);
    const preparer = await actorFor(Roles.financePreparer);
    const listed = await contractCall<{ data: FinanceRecord[] }>(preparer, 'finance', {
      method: 'GET',
      path: '/v1/finance/records',
      query: { state: 'IN-PROGRESS', pageSize: '1' },
    });
    const record = listed.data[0];
    if (record === undefined) throw new Error(`${preparer.site} has no IN-PROGRESS finance record to edit`);
    const id = record.record_id;
    const title = `${MARKER} finance`;

    const edited = await contractCall<{ data: FinanceRecord }>(preparer, 'finance', {
      method: 'POST',
      path: `/v1/finance/records/${id}/transitions/edit`,
      headers: await preparer.csrfHeaders(id),
      json: { title, amount: record.amount, period: record.period },
    });
    expect(edited.data).toMatchObject({
      record_id: id,
      state: 'IN-PROGRESS',
      title,
      amount: record.amount,
      period: record.period,
      version: record.version + 1,
    });
    expect(sameId(edited.data.lastupdatebyid, preparer.userId), 'lastupdatebyid is the preparer').toBe(true);

    const read = await contractCall<{ data: FinanceRecord & { versions: FinanceVersion[] } }>(preparer, 'finance', {
      method: 'GET',
      path: `/v1/finance/records/${id}`,
    });
    expect(read.data).toMatchObject({ title, state: 'IN-PROGRESS', version: edited.data.version });
    const version = read.data.versions.find((row) => row.version === edited.data.version);
    expect(version).toMatchObject({ action: 'edit', title });
    expect(sameId(version?.actor_user_id, preparer.userId), 'the version row names the preparer').toBe(true);
  });

  it('surveys: a manager bulk-targets a survey', async (ctx) => {
    requireFixtures(ctx);
    const manager = await actorFor(Roles.surveysManager);
    const site = { siteid: manager.site };
    const surveys = await contractCall<{ data: Survey[] }>(manager, 'surveys', {
      method: 'GET',
      path: '/v1/surveys',
      query: { ...site, itemsPerPage: '1' },
    });
    const survey = surveys.data[0];
    if (survey === undefined) throw new Error(`${manager.site} has no survey to target`);
    const targetsPath = `/v1/surveys/${survey.surveyId}/targets` as const;
    const before = await contractCall<{ data: SurveyTarget[] }>(manager, 'surveys', { method: 'GET', path: targetsPath, query: site });
    const groupName = `${MARKER} surveys`;

    const bulk = await contractCall<{ data: { inserted: number; total: number } }>(manager, 'surveys', {
      method: 'POST',
      path: `${targetsPath}/bulk`,
      query: site,
      headers: await manager.csrfHeaders(survey.surveyId),
      json: { targets: [{ siteId: manager.site, groupName }] },
    });
    expect(bulk.data).toEqual({ inserted: 1, total: before.data.length + 1 });

    const after = await contractCall<{ data: SurveyTarget[] }>(manager, 'surveys', { method: 'GET', path: targetsPath, query: site });
    expect(after.data).toHaveLength(before.data.length + 1);
    const added = after.data.filter((target) => target.groupName === groupName);
    expect(added.map((target) => target.siteId.toLowerCase())).toEqual([manager.site.toLowerCase()]);
  });

  it('communications: a sender stores a template', async (ctx) => {
    requireFixtures(ctx);
    const sender = await actorFor(Roles.communicationsSender);
    const input = { name: `${MARKER} communications`, subject: `${MARKER} {{name}}`, bodyText: 'Hello {{name}}' };

    const created = await contractCall<{ data: MessageTemplate }>(sender, 'communications', {
      method: 'POST',
      path: '/v1/templates',
      query: { siteid: sender.site },
      headers: await sender.csrfHeaders(COLLECTION_CSRF_CONTEXT),
      json: input,
    });
    expect(created.data).toMatchObject({
      siteid: sender.site,
      name: input.name,
      subject: input.subject,
      body_text: input.bodyText,
      body_html: '',
    });

    expect(await listedTemplate(sender, created.data.template_id)).toEqual(created.data);
  });

  it('reporting: an exporter queues an export job', async (ctx) => {
    requireFixtures(ctx);
    const exporter = await actorFor(Roles.reportingExporter);
    const definition = seed.select({
      as: 'definition',
      source: 'dataset',
      path: 'fixtures.synthetic.export_definition',
      where: { siteID: exporter.site, source: 'finance.records' },
    }) as { definition_id?: unknown };
    const definitionId = definition.definition_id;
    if (typeof definitionId !== 'string') throw new Error(`the seeded ${exporter.site} export definition has no definition_id`);

    const created = await contractCall<{ data: ExportJob }>(exporter, 'reporting', {
      method: 'POST',
      path: '/v1/reporting/exports',
      query: { siteid: exporter.site },
      headers: await exporter.csrfHeaders(COLLECTION_CSRF_CONTEXT),
      json: { definitionId, format: 'csv' },
    });
    expect(created.data).toMatchObject({ siteid: exporter.site, format: 'csv', state: 'queued' });
    expect(sameId(created.data.definition_id, definitionId), 'the job names the definition').toBe(true);
    expect(sameId(created.data.requested_by_id, exporter.userId), 'the job names the exporter').toBe(true);

    const read = await contractCall<{ data: ExportJob }>(exporter, 'reporting', {
      method: 'GET',
      path: `/v1/reporting/exports/${created.data.job_id}`,
    });
    const { job_id, siteid, definition_id, format, requested_by_id } = created.data;
    expect(read.data).toMatchObject({ job_id, siteid, definition_id, format, requested_by_id });
    expect(read.data.state, `export job ${job_id} error: ${read.data.error}`).not.toBe('failed');
  });

  it('timesheets: an employee submits a day', async (ctx) => {
    requireFixtures(ctx);
    const employee = await actorFor(Roles.timesheetsEmployee);
    const { sheet, day } = await submittableDay(employee, reservedPersons(seed));

    const result = await contractCall<DayActionResult>(employee, 'timesheets', {
      method: 'POST',
      path: `/v1/timesheets/days/${day.dayId}/submit`,
      headers: await employee.csrfHeaders(day.dayId),
      json: {},
    });
    expect(result).toMatchObject({
      dayId: day.dayId,
      timesheetId: sheet.timesheetId,
      action: 'submit',
      fromState: day.state,
      toState: 'SUBMITTED',
      blackout: false,
    });

    const read = await contractCall<SheetDetail>(employee, 'timesheets', {
      method: 'GET',
      path: `/v1/timesheets/sheets/${sheet.timesheetId}`,
    });
    const stored = read.days.find((candidate) => candidate.dayId === day.dayId);
    expect(stored?.state).toBe('SUBMITTED');
    expect(sameId(stored?.lastUpdateById, employee.userId), 'lastUpdateById is the employee').toBe(true);
  });
});
