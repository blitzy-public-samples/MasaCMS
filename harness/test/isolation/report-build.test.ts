// Isolation report: assertion categories, package summaries, the end-to-end result file, the pure builder and the CLI.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type CatalogFinding } from '@opt2/platform/testing';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { FIXTURES_UNAVAILABLE } from '../../src/golden/catalogue.js';
import { evaluateCatalog, type CatalogRows, type CatalogRunResult } from '../../src/isolation/catalog.js';
import type { CaseResult, GatewayIsolationResult, IsolationCase } from '../../src/isolation/gateway-matrix.js';
import {
  E2E_RESULT_RELATIVE,
  EVENT_CATEGORIES,
  GENERATED_BY,
  ISOLATION_CATEGORIES,
  ISOLATION_PACKAGES,
  PASS_CONDITION,
  REPORT_FILE,
  SERVICE_CATEGORIES,
  UNCATEGORISED,
  buildIsolationReport,
  categoriseAssertion,
  consumerSubscriptions,
  e2eIsolationResultPath,
  endToEndResultSchema,
  main,
  summarisePackageResults,
  vitestJsonSchema,
  writeEndToEndResult,
  type AssertionCategory,
  type AssertionStatus,
  type ConsumerSubscription,
  type EndToEndResult,
  type IsolationReport,
  type IsolationReportInput,
  type PackageResultInput,
  type VitestJson,
} from '../../src/isolation/report.js';
import { HelpRequest, UsageError } from '../../src/lib/cli.js';
import type { EnvLike } from '../../src/lib/paths.js';
import type { CatalogClient } from '../../src/lib/pg.js';
import type { Pin } from '../../src/lib/pin.js';
import { vitestResultPath } from '../../src/reporting/speed.js';
import type { SubscriptionEntry, Topology } from '../../src/repro/pubsub-topology.js';

type Assertion = VitestJson['testResults'][number]['assertionResults'][number];
type ConsumerRow = IsolationReport['consumers'][number];

const SHA = '0123456789abcdef0123456789abcdef01234567';
const PIN: Pin = {
  sha: SHA,
  subject: 'Increase version to 7.6.1 in package files and configuration',
  repository: 'https://example.invalid/masacms.git',
  confirmedAt: '2026-06-30T11:00:00.000Z',
  confirmCommand: 'tsx src/reporting/check-pin.ts --confirm',
};
const GENERATED_AT = '2026-06-30T12:00:00.000Z';
const CLOCK = (): Date => new Date(GENERATED_AT);
const ROOT = '/work/checkout';
const GATEWAY_URL = 'http://127.0.0.1:20100';
const E2E_SOURCE = `\${OPT2_STATE_DIR}/${E2E_RESULT_RELATIVE}`;
const NO_E2E_RESULT = `no end-to-end result at ${E2E_SOURCE}; harness/e2e/isolation writes it after the gateway matrix`;
const ROWS_SEEN = 'the same connection after the transaction, in person: expected { n: 1 } to equal { n: 0 }';
const NO_RLS_COUNTS = { tables: 0, enabled: 0, forced: 0, usingAndWithCheck: 0 };

const CATALOG_ROWS = JSON.parse(
  readFileSync(new URL('../fixtures/catalog/pg-catalog-rows.sample.json', import.meta.url), 'utf8'),
) as CatalogRows;

const ARCHIVED: ConsumerSubscription = {
  subscription: 'timesheets.people.person.archived.v1',
  consumer: 'timesheets',
  topic: 'people.person.archived.v1',
  fanout: true,
};
const CHANGED: ConsumerSubscription = {
  subscription: 'identity.people.person.changed.v1',
  consumer: 'identity',
  topic: 'people.person.changed.v1',
  fanout: false,
};
const DLQ_REPLAY: ConsumerSubscription = {
  subscription: 'timesheets.people.person.archived.v1.dlq.replay',
  consumer: 'timesheets',
  topic: 'timesheets.people.person.archived.v1.dlq',
  fanout: false,
};

/** One vitest assertion result whose full name is `fullName`. */
function assertion(
  fullName: string,
  status: AssertionStatus = 'passed',
  failureMessages: string[] | null = [],
): Assertion {
  return { ancestorTitles: ['tenant isolation'], title: fullName, fullName, status, failureMessages };
}

/** Vitest JSON with one test file per entry. */
function vitestJson(...files: { name: string; assertions: Assertion[] }[]): VitestJson {
  return { testResults: files.map(({ name, assertions }) => ({ name, assertionResults: assertions })) };
}

/** Absolute vitest file name of an isolation suite of `pkg`. */
function isolationFile(pkg: string): string {
  return `${ROOT}/${pkg}/test/isolation/tenant.isolation.test.ts`;
}

/** Vitest JSON of one isolation suite of `pkg` holding `assertions`. */
function isolationJson(pkg: string, assertions: Assertion[]): VitestJson {
  return vitestJson({ name: isolationFile(pkg), assertions });
}

/** Title `defineIsolationSuite` gives the cross-tenant read case of `table`. */
function readTitle(table: string): string {
  return `tenant A sees only its own rows in ${table}`;
}

/** Title `defineIsolationSuite` gives the cross-tenant write case of `table`. */
function writeTitle(table: string): string {
  return `tenant A cannot insert, move into, update or delete rows of tenant B in ${table}`;
}

/** Title `defineIsolationSuite` gives the pooled-connection reuse case of `table`. */
function reuseTitle(table: string): string {
  return `a pooled connection reused after a tenant A transaction sees no rows of ${table} and cannot write it`;
}

/** Title of a tenantless-event case on `subscription`. */
function tenantlessTitle(subscription: string): string {
  return `an event without a tenant on ${subscription} is acked, dead-lettered as missing-tenant and changes no rows`;
}

/** Title of a fan-out case on `topic`. */
function fanoutTitle(topic: string): string {
  return `a ${topic} fan-out from umbrella reaches tenant A once each and never tenant B`;
}

/** Title of a delivery-effect case on `subscription`. */
function effectTitle(subscription: string): string {
  return `${subscription} applies a redelivered event once`;
}

/** Passing read, write and pooled-reuse assertions over `table`. */
function serviceAssertions(table: string): Assertion[] {
  return [assertion(readTitle(table)), assertion(writeTitle(table)), assertion(reuseTitle(table))];
}

/** Passing tenantless, fan-out (when the topic fans out) and delivery-effect assertions of `subscription`. */
function eventAssertions(subscription: ConsumerSubscription): Assertion[] {
  return [
    assertion(tenantlessTitle(subscription.subscription)),
    ...(subscription.fanout ? [assertion(fanoutTitle(subscription.topic))] : []),
    assertion(effectTitle(subscription.subscription)),
  ];
}

/** `${OPT2_STATE_DIR}`-relative label of the vitest results file of `service`. */
function resultLabel(service: string): string {
  return `\${OPT2_STATE_DIR}/test-all/vitest/services-${service}.json`;
}

/** Inputs of every isolation package with passing service assertions, plus `extra[service]` where given. */
function passingPackages(extra: Readonly<Record<string, Assertion[]>> = {}): PackageResultInput[] {
  return ISOLATION_PACKAGES.map((pkg) => ({
    ...pkg,
    path: resultLabel(pkg.service),
    json: isolationJson(pkg.pkg, [...serviceAssertions(pkg.schema), ...(extra[pkg.service] ?? [])]),
  }));
}

/** `packages` with the results of `service` replaced by `json`. */
function withResults(
  packages: readonly PackageResultInput[],
  service: string,
  json: VitestJson | null,
): PackageResultInput[] {
  return packages.map((input) => (input.service === service ? { ...input, json } : input));
}

/** The committed catalog rows with their unforced table and their BYPASSRLS role repaired. */
function compliantRows(): CatalogRows {
  const rows = structuredClone(CATALOG_ROWS);
  for (const table of rows.tables) {
    if (table.schema === 'timesheets' && table.table === 'blackout') table.relforcerowsecurity = true;
  }
  for (const role of rows.roles) if (role.rolname === 'finance_app') role.rolbypassrls = false;
  return rows;
}

/** The compliant catalog rows with people.person left unforced and finance_app given BYPASSRLS. */
function defectiveRows(): CatalogRows {
  const rows = compliantRows();
  for (const table of rows.tables) {
    if (table.schema === 'people' && table.table === 'person') table.relforcerowsecurity = false;
  }
  for (const role of rows.roles) if (role.rolname === 'finance_app') role.rolbypassrls = true;
  return rows;
}

/** A gateway matrix case `id` with `result` and, when given, `reason`. */
function gatewayCase(id: string, result: CaseResult, reason?: string): IsolationCase {
  return {
    id,
    family: 'content',
    kind: 'read-list',
    actor: 'a',
    owner: 'b',
    method: 'GET',
    route: '/_api/json/v1/{site}/content',
    expected: 'no-owner-rows',
    result,
    observed: { status: 200, leakedIds: 0 },
    ...(reason === undefined ? {} : { reason }),
  };
}

/** A gateway run with zero cross-tenant counts and grant-only survey responses, then `overrides`. */
function gatewayRun(cases: IsolationCase[], overrides: Partial<GatewayIsolationResult> = {}): GatewayIsolationResult {
  return { crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: true, cases, ...overrides };
}

/** The parsed end-to-end result file of `gateway` run against `baseUrl`. */
function endToEnd(gateway: GatewayIsolationResult, baseUrl?: string): EndToEndResult {
  return endToEndResultSchema.parse({ writtenAt: GENERATED_AT, baseUrl, gateway });
}

/** Report input every check passes, with `overrides` applied. */
function passingInput(overrides: Partial<IsolationReportInput> = {}): IsolationReportInput {
  return {
    sha: SHA,
    generatedAt: GENERATED_AT,
    packages: passingPackages({ timesheets: eventAssertions(ARCHIVED), identity: eventAssertions(CHANGED) }),
    endToEnd: endToEnd(
      gatewayRun([
        gatewayCase('content:read-list:a->b', 'pass'),
        gatewayCase('surveys:survey-grant:a->b', 'skipped', FIXTURES_UNAVAILABLE),
        gatewayCase('finance:read-list:a->b', 'skipped', FIXTURES_UNAVAILABLE),
      ]),
      GATEWAY_URL,
    ),
    catalog: evaluateCatalog(compliantRows()),
    subscriptions: [ARCHIVED, DLQ_REPLAY, CHANGED],
    ...overrides,
  };
}

/** The passing input with the results of `service` replaced by an isolation suite holding `assertions`. */
function inputWithAssertions(service: string, assertions: Assertion[], overrides: Partial<IsolationReportInput> = {}) {
  const input = passingInput(overrides);
  return { ...input, packages: withResults(input.packages, service, isolationJson(`services/${service}`, assertions)) };
}

/** The service row of `service` in `report`. */
function serviceRowOf(report: IsolationReport, service: string): IsolationReport['services'][number] {
  const row = report.services.find((candidate) => candidate.service === service);
  if (row === undefined) throw new Error(`report has no service row ${service}`);
  return row;
}

describe('categoriseAssertion', () => {
  it.each<[string, AssertionCategory]>([
    ['tenant isolation: people tenant A sees only its own rows in person', 'crossTenantReads'],
    ['tenant B cannot insert, move into, update or delete rows of tenant umbrella in person', 'crossTenantWrites'],
    [reuseTitle('person'), 'pooledConnectionReuse'],
    [tenantlessTitle(ARCHIVED.subscription), 'tenantlessRejected'],
    ['a Tenant-less delivery is Dead-Lettered', 'tenantlessRejected'],
    [fanoutTitle(ARCHIVED.topic), 'fanoutRegistryOnly'],
    ['the consumer fans out only to registry tenants', 'fanoutRegistryOnly'],
    ['a tenant A survey grant to tenant B admits tenant B and not tenant umbrella', 'grant'],
    ['every tenant table has forced RLS with USING and WITH CHECK, and no schema role can bypass it', 'catalog'],
    ['the repository guard refuses tenant work outside withTenant', 'catalog'],
    [effectTitle(ARCHIVED.subscription), 'crossTenantEffects'],
    ['a redelivered (people.person.changed.v1.) event changes nothing', 'crossTenantEffects'],
    ['formats the person list', UNCATEGORISED],
    ['tenant A sees only its own rows in person, then more', UNCATEGORISED],
  ])('files %j under %s', (fullName, category) => {
    expect(categoriseAssertion(fullName)).toBe(category);
  });

  it('tries every category the report counts and nothing else', () => {
    expect(Object.keys(ISOLATION_CATEGORIES).sort()).toEqual(
      [...SERVICE_CATEGORIES, ...EVENT_CATEGORIES, 'grant', 'catalog'].sort(),
    );
    expect(SERVICE_CATEGORIES).toEqual(['crossTenantReads', 'crossTenantWrites', 'pooledConnectionReuse']);
    expect(EVENT_CATEGORIES).toEqual(['tenantlessRejected', 'fanoutRegistryOnly', 'crossTenantEffects']);
  });
});

describe('ISOLATION_PACKAGES', () => {
  it('lists the ten services and the stub with their schema and services/ folder', () => {
    expect(ISOLATION_PACKAGES.map(({ service, schema, pkg }) => `${service}:${schema}:${pkg}`)).toEqual([
      'identity:identity:services/identity',
      'people:people:services/people',
      'programs-sites:programs_sites:services/programs-sites',
      'strategies-content:content:services/strategies-content',
      'communications:communications:services/communications',
      'reporting:reporting:services/reporting',
      'surveys:surveys:services/surveys',
      'timesheets:timesheets:services/timesheets',
      'finance:finance:services/finance',
      'e-signature:esignature:services/e-signature',
      'stub:stub:services/stub',
    ]);
    expect(Object.isFrozen(ISOLATION_PACKAGES)).toBe(true);
    expect(ISOLATION_PACKAGES.every((pkg) => Object.isFrozen(pkg))).toBe(true);
  });
});

describe('vitestJsonSchema', () => {
  it('accepts reporter output with extra fields and null failure messages, keeping the extra fields', () => {
    const raw = {
      numTotalTests: 1,
      testResults: [
        {
          name: isolationFile('services/people'),
          status: 'passed',
          assertionResults: [
            { ancestorTitles: [], title: 't', fullName: 't', status: 'passed', failureMessages: null, duration: 3 },
          ],
        },
      ],
    };

    expect(vitestJsonSchema.parse(raw)).toEqual(raw);
  });

  it('rejects an assertion status vitest does not report', () => {
    const flaky = { ...assertion('t'), status: 'flaky' };
    const raw = { testResults: [{ name: 'test/isolation/a.test.ts', assertionResults: [flaky] }] };

    expect(vitestJsonSchema.safeParse(raw).success).toBe(false);
  });
});

describe('summarisePackageResults', () => {
  it('reports an absent results file with every category at zero', () => {
    const summary = summarisePackageResults('services/people', null);

    expect(summary.present).toBe(false);
    expect(summary.assertions).toEqual([]);
    expect(Object.keys(summary.categories).sort()).toEqual([...Object.keys(ISOLATION_CATEGORIES), UNCATEGORISED].sort());
    expect(Object.values(summary.categories).every((tally) => tally.passed + tally.failed + tally.notRun === 0)).toBe(true);
  });

  it.each([
    [`${ROOT}/services/people/test/isolation/person.test.ts`, true],
    ['services/people/test/isolation/person.test.ts', true],
    ['test/isolation/person.test.ts', true],
    ['C:\\work\\services\\people\\test\\isolation\\person.test.ts', true],
    [`${ROOT}/services/people/test/unit/person.test.ts`, false],
    [`${ROOT}/services/identity/test/isolation/person.test.ts`, false],
  ])('reads %s as an isolation file of services/people: %s', (name, included) => {
    const json = vitestJson({ name, assertions: [assertion(readTitle('person'))] });

    const summary = summarisePackageResults('services/people', json);

    expect(summary.present).toBe(true);
    expect(summary.assertions).toHaveLength(included ? 1 : 0);
  });

  it('tallies passed, failed and not-run assertions per category and keeps their failure messages', () => {
    const json = isolationJson('services/people', [
      assertion(readTitle('person')),
      assertion(readTitle('outbox'), 'failed', ['expected 1 to be 0']),
      assertion(writeTitle('person'), 'skipped', null),
      assertion(writeTitle('outbox'), 'todo'),
      assertion('formats the person list', 'failed', null),
    ]);

    const summary = summarisePackageResults('services/people', json);

    expect(summary.categories.crossTenantReads).toEqual({ passed: 1, failed: 1, notRun: 0 });
    expect(summary.categories.crossTenantWrites).toEqual({ passed: 0, failed: 0, notRun: 2 });
    expect(summary.categories[UNCATEGORISED]).toEqual({ passed: 0, failed: 1, notRun: 0 });
    expect(summary.assertions.map(({ category, status, failureMessages }) => [category, status, failureMessages])).toEqual([
      ['crossTenantReads', 'passed', []],
      ['crossTenantReads', 'failed', ['expected 1 to be 0']],
      ['crossTenantWrites', 'skipped', []],
      ['crossTenantWrites', 'todo', []],
      [UNCATEGORISED, 'failed', []],
    ]);
    expect(summary.assertions[0]?.file).toBe(isolationFile('services/people'));
  });
});

describe('endToEndResultSchema', () => {
  it.each([
    ['a negative read count', { crossTenantReads: -1 }],
    ['a fractional write count', { crossTenantWrites: 0.5 }],
    ['a case result the matrix does not produce', { cases: [{ ...gatewayCase('x', 'pass'), result: 'error' }] }],
  ])('rejects %s', (_label, override) => {
    const body = { writtenAt: GENERATED_AT, gateway: { ...gatewayRun([gatewayCase('x', 'pass')]), ...override } };

    expect(endToEndResultSchema.safeParse(body).success).toBe(false);
  });
});

describe('end-to-end result file', () => {
  let state: string;
  let env: EnvLike;

  beforeEach(async () => {
    state = await mkdtemp(path.join(os.tmpdir(), 'opt2-isolation-e2e-'));
    env = { OPT2_STATE_DIR: state };
  });

  afterEach(async () => {
    await rm(state, { recursive: true, force: true });
  });

  it('lives at results/e2e-isolation.json under the state directory', () => {
    expect(e2eIsolationResultPath(env)).toBe(path.join(state, 'results', 'e2e-isolation.json'));
  });

  it('round-trips a gateway run through the file, keeping only the case fields the report reads', async () => {
    const cases = [
      gatewayCase('content:read-list:a->b', 'pass'),
      gatewayCase('surveys:survey-grant:a->b', 'skipped', FIXTURES_UNAVAILABLE),
    ];

    const file = await writeEndToEndResult(gatewayRun(cases, { crossTenantReads: 2 }), env, {
      baseUrl: GATEWAY_URL,
      clock: CLOCK,
    });

    expect(file).toBe(e2eIsolationResultPath(env));
    const text = await readFile(file, 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(['baseUrl', 'gateway', 'writtenAt']);
    expect(endToEndResultSchema.parse(JSON.parse(text))).toEqual({
      writtenAt: GENERATED_AT,
      baseUrl: GATEWAY_URL,
      gateway: {
        crossTenantReads: 2,
        crossTenantWrites: 0,
        surveyGrantOnly: true,
        cases: [
          { id: 'content:read-list:a->b', kind: 'read-list', result: 'pass' },
          { id: 'surveys:survey-grant:a->b', kind: 'read-list', result: 'skipped', reason: FIXTURES_UNAVAILABLE },
        ],
      },
    });
  });

  it('stamps the current time and omits the base URL when none is given', async () => {
    const before = Date.now();

    const file = await writeEndToEndResult(gatewayRun([]), env);

    const body = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(body).not.toHaveProperty('baseUrl');
    expect(Date.parse(String(body.writtenAt))).toBeGreaterThanOrEqual(before);
  });
});

describe('buildIsolationReport', () => {
  it('passes when every service, consumer, catalog check and gateway case is clean', () => {
    const built = buildIsolationReport(passingInput());
    const { report } = built;

    expect(built.findings).toEqual([]);
    expect(built.servicesFailing).toEqual([]);
    expect(built.endToEndSkipped).toEqual(['finance:read-list:a->b', 'surveys:survey-grant:a->b']);
    expect(report.result).toBe('pass');
    expect(report).toMatchObject({
      sourceSha: SHA,
      generatedBy: GENERATED_BY,
      generatedAt: GENERATED_AT,
      status: 'generated',
      passCondition: PASS_CONDITION,
      tenants: { a: TENANT_A.siteId, b: TENANT_B.siteId, umbrella: TENANT_UMBRELLA.siteId },
    });
    for (const tenant of [TENANT_A, TENANT_B, TENANT_UMBRELLA]) {
      expect(report.tenants.idRule).toContain(`${tenant.siteId} = ${tenant.tenantId}`);
    }
    expect(report.services.map((row) => row.service)).toEqual(ISOLATION_PACKAGES.map((pkg) => pkg.service));
    expect(serviceRowOf(report, 'people')).toEqual({
      service: 'people',
      schema: 'people',
      crossTenantReads: 0,
      crossTenantWrites: 0,
      pooledConnectionReuse: { rowsSeen: 0, writeBlocked: true },
      rlsCatalog: { tables: 2, enabled: 2, forced: 2, usingAndWithCheck: 2 },
      source: resultLabel('people'),
    });
    expect(report.consumers).toEqual([
      { subscription: CHANGED.subscription, tenantlessRejected: true, fanoutRegistryOnly: null, crossTenantEffects: 0 },
      { subscription: ARCHIVED.subscription, tenantlessRejected: true, fanoutRegistryOnly: true, crossTenantEffects: 0 },
    ]);
    expect(report.roles).toEqual({ rolbypassrls: [], rolsuper: [], membershipViolations: [] });
    expect(report.endToEnd).toEqual({
      via: `gateway ${GATEWAY_URL}`,
      crossTenantReads: 0,
      crossTenantWrites: 0,
      surveyGrantOnly: true,
      fanoutRegistryOnly: null,
      source: E2E_SOURCE,
    });
  });

  it.each([
    ['crossTenantReads', readTitle('person')],
    ['crossTenantWrites', writeTitle('person')],
  ] as const)('counts a failed %s assertion on its service row and fails the report', (field, title) => {
    const assertions = serviceAssertions('person').map((entry) =>
      entry.fullName === title ? assertion(title, 'failed', ['tenant B row visible']) : entry,
    );

    const built = buildIsolationReport(inputWithAssertions('people', assertions));

    expect(serviceRowOf(built.report, 'people')[field]).toBe(1);
    expect(built.findings).toEqual([{ scope: 'services/people', service: 'people', detail: `failed [${field}]: ${title}` }]);
    expect(built.servicesFailing).toEqual(['people']);
    expect(built.report.result).toBe('fail');
  });

  it.each([
    ['still saw rows', [ROWS_SEEN], 1],
    ['could still write', ['expected the write to be refused'], 0],
  ])('shows a pooled connection that %s as not write-blocked', (_label, failureMessages, rowsSeen) => {
    const assertions = [
      assertion(readTitle('person')),
      assertion(writeTitle('person')),
      assertion(reuseTitle('person'), 'failed', failureMessages),
    ];

    const built = buildIsolationReport(inputWithAssertions('people', assertions));

    expect(serviceRowOf(built.report, 'people').pooledConnectionReuse).toEqual({ rowsSeen, writeBlocked: false });
    expect(built.findings.map((finding) => finding.detail)).toEqual([
      `failed [pooledConnectionReuse]: ${reuseTitle('person')}`,
    ]);
    expect(built.report.result).toBe('fail');
  });

  it.each<[string, (packages: readonly PackageResultInput[]) => PackageResultInput[], string]>([
    [
      'no package input',
      (packages) => packages.filter((input) => input.service !== 'people'),
      'no vitest results; isolation was not shown',
    ],
    [
      'no results file',
      (packages) => withResults(packages, 'people', null),
      `no vitest results at ${resultLabel('people')}; isolation was not shown`,
    ],
    [
      'no isolation assertions',
      (packages) =>
        withResults(
          packages,
          'people',
          vitestJson({ name: `${ROOT}/services/people/test/unit/a.test.ts`, assertions: serviceAssertions('person') }),
        ),
      `no assertions from services/people/test/isolation/ in ${resultLabel('people')}; isolation was not shown`,
    ],
    [
      'no write assertions',
      (packages) =>
        withResults(
          packages,
          'people',
          isolationJson('services/people', [assertion(readTitle('person')), assertion(reuseTitle('person'))]),
        ),
      'no crossTenantWrites assertions under test/isolation/',
    ],
    [
      'an assertion that did not run',
      (packages) =>
        withResults(
          packages,
          'people',
          isolationJson('services/people', [...serviceAssertions('person'), assertion('a grant to tenant B', 'skipped')]),
        ),
      '1 isolation assertions did not run (skipped, pending, todo or disabled); isolation was not shown',
    ],
  ])('fails a service whose results show %s', (_label, edit, detail) => {
    const input = passingInput();

    const built = buildIsolationReport({ ...input, packages: edit(input.packages) });

    expect(built.findings).toEqual([{ scope: 'services/people', service: 'people', detail }]);
    expect(built.servicesFailing).toEqual(['people']);
    expect(built.report.result).toBe('fail');
  });

  it('shows a missing results file as no source and zero counts', () => {
    const input = passingInput();

    const { report } = buildIsolationReport({ ...input, packages: withResults(input.packages, 'people', null) });

    expect(serviceRowOf(report, 'people')).toMatchObject({
      crossTenantReads: 0,
      crossTenantWrites: 0,
      pooledConnectionReuse: { rowsSeen: 0, writeBlocked: false },
      source: null,
    });
  });

  it('fails a service whose schema has no RLS catalog counts and shows them as zero', () => {
    const input = passingInput();
    const rlsCatalog = Object.fromEntries(
      Object.entries(input.catalog.rlsCatalog).filter(([schema]) => schema !== 'programs_sites'),
    );

    const built = buildIsolationReport({ ...input, catalog: { ...input.catalog, rlsCatalog } });

    expect(serviceRowOf(built.report, 'programs-sites').rlsCatalog).toEqual(NO_RLS_COUNTS);
    expect(built.findings).toEqual([
      {
        scope: 'services/programs-sites',
        service: 'programs-sites',
        detail: 'no RLS catalog counts for schema programs_sites',
      },
    ]);
    expect(built.servicesFailing).toEqual(['programs-sites']);
  });

  it.each<[CatalogFinding, string | undefined, string]>([
    [
      { kind: 'rls-not-forced', object: 'timesheets.blackout', detail: 'missing FORCE ROW LEVEL SECURITY' },
      'timesheets',
      'rls-not-forced timesheets.blackout: missing FORCE ROW LEVEL SECURITY',
    ],
    [
      { kind: 'rls-disabled', object: 'programs_sites', detail: 'no tenant-owned tables' },
      'programs-sites',
      'rls-disabled programs_sites: no tenant-owned tables',
    ],
    [
      { kind: 'role-bypassrls', object: 'finance_app', detail: 'role has BYPASSRLS' },
      'finance',
      'role-bypassrls finance_app: role has BYPASSRLS',
    ],
    [
      { kind: 'role-member-of-privileged', object: 'esignature_migrator' },
      'e-signature',
      'role-member-of-privileged esignature_migrator',
    ],
    [
      { kind: 'role-superuser', object: 'gateway_owner', detail: 'role has SUPERUSER' },
      undefined,
      'role-superuser gateway_owner: role has SUPERUSER',
    ],
  ])('reports catalog finding %j against its owning service', (finding, service, detail) => {
    const input = passingInput();

    const built = buildIsolationReport({ ...input, catalog: { ...input.catalog, findings: [finding] } });

    expect(built.findings).toEqual([{ scope: 'catalog', service, detail }]);
    expect(built.servicesFailing).toEqual(service === undefined ? [] : [service]);
    expect(built.report.result).toBe('fail');
  });

  it('copies the privileged service roles without sharing the catalog arrays', () => {
    const roles: CatalogRunResult['roles'] = {
      rolbypassrls: ['finance_app'],
      rolsuper: ['people_owner'],
      membershipViolations: [{ member: 'people_app', ancestor: 'postgres', via: ['people_owner'] }],
    };
    const input = passingInput();

    const { report } = buildIsolationReport({ ...input, catalog: { ...input.catalog, roles } });
    roles.rolbypassrls.push('identity_app');
    roles.membershipViolations[0]?.via.push('identity_owner');

    expect(report.roles).toEqual({
      rolbypassrls: ['finance_app'],
      rolsuper: ['people_owner'],
      membershipViolations: [{ member: 'people_app', ancestor: 'postgres', via: ['people_owner'] }],
    });
  });

  it.each<[string, Assertion[], Omit<ConsumerRow, 'subscription'>, string[]]>([
    [
      'has no tenantless-event assertion',
      [assertion(effectTitle(ARCHIVED.subscription)), assertion(fanoutTitle(ARCHIVED.topic))],
      { tenantlessRejected: false, fanoutRegistryOnly: true, crossTenantEffects: 0 },
      ['no tenantless-event assertion in its consumer package'],
    ],
    [
      'fails its tenantless-event assertion',
      [assertion(tenantlessTitle(ARCHIVED.subscription), 'failed'), assertion(fanoutTitle(ARCHIVED.topic))],
      { tenantlessRejected: false, fanoutRegistryOnly: true, crossTenantEffects: 1 },
      ['tenantless-event assertions did not all pass'],
    ],
    [
      'has no fan-out assertion on a fan-out topic',
      [assertion(tenantlessTitle(ARCHIVED.subscription))],
      { tenantlessRejected: true, fanoutRegistryOnly: false, crossTenantEffects: 0 },
      [`fan-out topic ${ARCHIVED.topic} has no fan-out assertion in its consumer package`],
    ],
    [
      'fails its fan-out assertion',
      [assertion(tenantlessTitle(ARCHIVED.subscription)), assertion(fanoutTitle(ARCHIVED.topic), 'failed')],
      { tenantlessRejected: true, fanoutRegistryOnly: false, crossTenantEffects: 1 },
      ['fan-out assertions did not all pass'],
    ],
    [
      'applies an event to another tenant',
      [
        assertion(tenantlessTitle(ARCHIVED.subscription)),
        assertion(fanoutTitle(ARCHIVED.topic)),
        assertion(effectTitle(ARCHIVED.subscription), 'failed'),
      ],
      { tenantlessRejected: true, fanoutRegistryOnly: true, crossTenantEffects: 1 },
      [],
    ],
  ])('fails a consumer that %s', (_label, events, row, consumerFindings) => {
    const assertions = [...serviceAssertions('blackout'), ...events];

    const built = buildIsolationReport(inputWithAssertions('timesheets', assertions, { subscriptions: [ARCHIVED] }));

    expect(built.report.consumers).toEqual([{ subscription: ARCHIVED.subscription, ...row }]);
    const scope = `consumer ${ARCHIVED.subscription}`;
    expect(built.findings.filter((finding) => finding.scope === scope).map((finding) => finding.detail)).toEqual(
      consumerFindings,
    );
    expect(built.servicesFailing).toEqual(['timesheets']);
    expect(built.report.result).toBe('fail');
  });

  it('applies the assertions naming a subscription, and every assertion of the category when none does', () => {
    const archived: ConsumerSubscription = { ...ARCHIVED, fanout: false };
    const changed: ConsumerSubscription = {
      subscription: 'timesheets.people.person.changed.v1',
      consumer: 'timesheets',
      topic: 'people.person.changed.v1',
      fanout: false,
    };
    const group: ConsumerSubscription = {
      subscription: 'timesheets.identity.group.changed.v1',
      consumer: 'timesheets',
      topic: 'identity.group.changed.v1',
      fanout: false,
    };
    const assertions = [
      ...serviceAssertions('blackout'),
      assertion(tenantlessTitle(archived.subscription)),
      assertion(tenantlessTitle(changed.subscription), 'failed'),
    ];

    const { report } = buildIsolationReport(
      inputWithAssertions('timesheets', assertions, { subscriptions: [group, changed, archived] }),
    );

    expect(report.consumers).toEqual([
      { subscription: group.subscription, tenantlessRejected: false, fanoutRegistryOnly: null, crossTenantEffects: 1 },
      { subscription: archived.subscription, tenantlessRejected: true, fanoutRegistryOnly: null, crossTenantEffects: 0 },
      { subscription: changed.subscription, tenantlessRejected: false, fanoutRegistryOnly: null, crossTenantEffects: 1 },
    ]);
  });

  it('fails a consumer whose service is not an isolation package', () => {
    const search: ConsumerSubscription = {
      subscription: 'search.people.person.changed.v1',
      consumer: 'search',
      topic: 'people.person.changed.v1',
      fanout: false,
    };

    const built = buildIsolationReport(passingInput({ subscriptions: [search] }));

    expect(built.findings).toEqual(
      ['consumer search is not one of the isolation packages', 'no tenantless-event assertion in its consumer package'].map(
        (detail) => ({ scope: `consumer ${search.subscription}`, service: 'search', detail }),
      ),
    );
    expect(built.servicesFailing).toEqual([]);
    expect(built.report.result).toBe('fail');
  });

  it('fails when the end-to-end result is missing and shows its figures as null', () => {
    const built = buildIsolationReport(passingInput({ endToEnd: null }));

    expect(built.findings).toEqual([{ scope: 'endToEnd', detail: NO_E2E_RESULT }]);
    expect(built.report.endToEnd).toEqual({
      via: 'gateway',
      crossTenantReads: null,
      crossTenantWrites: null,
      surveyGrantOnly: null,
      fanoutRegistryOnly: null,
      source: null,
    });
    expect(built.servicesFailing).toEqual([]);
    expect(built.report.result).toBe('fail');
  });

  it('reports every gateway case that did not pass, the cross-tenant counts and an ungranted survey response', () => {
    const run = gatewayRun(
      [
        gatewayCase('content:read-list:a->b', 'pass'),
        gatewayCase('user:read-by-id:b->a', 'violation'),
        gatewayCase('finance:write-foreign-id:a->umbrella', 'inconclusive', 'owner re-read failed'),
        gatewayCase('timesheets:read-list:a->b', 'skipped', 'not run'),
      ],
      { crossTenantReads: 2, crossTenantWrites: 1, surveyGrantOnly: false },
    );

    const built = buildIsolationReport(passingInput({ endToEnd: endToEnd(run) }));

    expect(built.findings).toEqual(
      [
        'case user:read-by-id:b->a violation',
        'case finance:write-foreign-id:a->umbrella inconclusive: owner re-read failed',
        'case timesheets:read-list:a->b skipped: not run',
        '2 cross-tenant reads through the gateway',
        '1 cross-tenant writes through the gateway',
        'surveyGrantOnly is false: no survey-grant case showed responses admitted for granted sites only',
      ].map((detail) => ({ scope: 'endToEnd', detail })),
    );
    expect(built.endToEndSkipped).toEqual([]);
    expect(built.report.endToEnd).toEqual({
      via: 'gateway',
      crossTenantReads: 2,
      crossTenantWrites: 1,
      surveyGrantOnly: false,
      fanoutRegistryOnly: null,
      source: E2E_SOURCE,
    });
    expect(built.report.result).toBe('fail');
  });
});

describe('consumerSubscriptions', () => {
  let repoRoot: string;

  /** A push subscription entry of `consumer` on `topic`. */
  function entry(consumer: string, topic: string): SubscriptionEntry {
    const subscription = `${consumer}.${topic}`;
    return {
      topic,
      consumer,
      push_path: `/internal/v1/events/${subscription}`,
      ordering: true,
      dead_letter_topic: `${subscription}.dlq`,
      max_delivery_attempts: 5,
      dlq_replay_subscription: `${subscription}.dlq.replay`,
    };
  }

  /** Writes the payload schema of `topic` under `repoRoot` with the given root declarations. */
  async function writeTopicSchema(topic: string, declarations: Record<string, string>): Promise<void> {
    const service = topic.split('.')[0] ?? '';
    const file = path.join(repoRoot, 'services', service, 'contracts', 'events', `${topic}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ type: 'object', ...declarations }), 'utf8');
  }

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(os.tmpdir(), 'opt2-isolation-repo-'));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it('lists every push subscription sorted, with the fan-out its topic schema declares', async () => {
    await writeTopicSchema('people.person.archived.v1', { 'x-opt2-kind': 'process', 'x-opt2-tenant-fanout': 'userPool' });
    await writeTopicSchema('people.person.changed.v1', { 'x-opt2-kind': 'state' });
    const topology: Pick<Topology, 'subscriptions'> = {
      subscriptions: {
        'timesheets.people.person.archived.v1': entry('timesheets', 'people.person.archived.v1'),
        'identity.people.person.changed.v1': entry('identity', 'people.person.changed.v1'),
        'reporting.people.person.archived.v1': entry('reporting', 'people.person.archived.v1'),
      },
    };

    expect(consumerSubscriptions(topology, repoRoot)).toEqual([
      {
        subscription: 'identity.people.person.changed.v1',
        consumer: 'identity',
        topic: 'people.person.changed.v1',
        fanout: false,
      },
      {
        subscription: 'reporting.people.person.archived.v1',
        consumer: 'reporting',
        topic: 'people.person.archived.v1',
        fanout: true,
      },
      {
        subscription: 'timesheets.people.person.archived.v1',
        consumer: 'timesheets',
        topic: 'people.person.archived.v1',
        fanout: true,
      },
    ]);
  });

  it('throws when a subscribed topic has no schema under the repository root', () => {
    const topology = {
      subscriptions: { 'timesheets.people.person.archived.v1': entry('timesheets', 'people.person.archived.v1') },
    };

    expect(() => consumerSubscriptions(topology, repoRoot)).toThrow(/ENOENT/);
  });
});

describe('main', () => {
  let scratch: string;
  let env: EnvLike;

  /** A catalog client answering each catalog query from `rows` by the catalog relation it reads. */
  function catalogClient(rows: CatalogRows): CatalogClient & { close: Mock<() => Promise<void>> } {
    return {
      async query<T>(sql: string): Promise<T[]> {
        const answer = sql.includes('pg_auth_members')
          ? rows.memberships
          : sql.includes('pg_policies')
            ? rows.policies
            : sql.includes('pg_class')
              ? rows.tables
              : sql.includes('pg_roles')
                ? rows.roles
                : undefined;
        if (answer === undefined) throw new Error(`unexpected catalog query: ${sql}`);
        return structuredClone(answer) as unknown as T[];
      },
      close: vi.fn(async () => {}),
    };
  }

  /** Writes `text` as the vitest results file of `pkg` under the state directory. */
  async function writeResults(pkg: string, text: string): Promise<void> {
    const file = vitestResultPath(pkg, env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, 'utf8');
  }

  /** `main` over `client` with the fixed pin and clock and no event subscriptions. */
  function run(client: CatalogClient, argv: string[] = []): ReturnType<typeof main> {
    return main(argv, {
      env,
      clock: CLOCK,
      pin: () => PIN,
      openCatalog: async () => client,
      topology: () => ({ subscriptions: {} }),
    });
  }

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'opt2-isolation-main-'));
    env = { OPT2_STATE_DIR: path.join(scratch, 'state'), OPT2_REPORTS_DIR: path.join(scratch, 'reports') };
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('writes a passing report and exits 0 when every input is clean', async () => {
    for (const pkg of ISOLATION_PACKAGES) {
      await writeResults(pkg.pkg, JSON.stringify(isolationJson(pkg.pkg, serviceAssertions(pkg.schema))));
    }
    await writeEndToEndResult(gatewayRun([gatewayCase('content:read-list:a->b', 'pass')]), env, {
      baseUrl: GATEWAY_URL,
      clock: CLOCK,
    });
    const client = catalogClient(compliantRows());

    const outcome = await run(client);

    const written = path.join(scratch, 'reports', REPORT_FILE);
    expect(outcome).toEqual({
      code: 0,
      summary: {
        written,
        result: 'pass',
        findings: 0,
        findingDetails: [],
        endToEnd: {
          via: `gateway ${GATEWAY_URL}`,
          crossTenantReads: 0,
          crossTenantWrites: 0,
          surveyGrantOnly: true,
          fanoutRegistryOnly: null,
          source: E2E_SOURCE,
        },
        endToEndSkipped: [],
        servicesFailing: [],
      },
    });
    const report = JSON.parse(await readFile(written, 'utf8')) as IsolationReport;
    expect(report).toMatchObject({
      sourceSha: SHA,
      generatedBy: GENERATED_BY,
      generatedAt: GENERATED_AT,
      result: 'pass',
      consumers: [],
    });
    expect(report.services.map((row) => row.source)).toEqual(ISOLATION_PACKAGES.map((pkg) => resultLabel(pkg.service)));
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('fails with every finding when results are missing and the catalog shows RLS and role defects', async () => {
    const client = catalogClient(defectiveRows());

    const outcome = await run(client);

    expect(outcome.code).toBe(1);
    expect(outcome.summary).toMatchObject({
      result: 'fail',
      servicesFailing: ISOLATION_PACKAGES.map((pkg) => pkg.service),
    });
    expect(outcome.summary?.findingDetails).toEqual(
      expect.arrayContaining([
        `services/people: no vitest results at ${resultLabel('people')}; isolation was not shown`,
        'catalog: rls-not-forced people.person: missing FORCE ROW LEVEL SECURITY',
        'catalog: role-bypassrls finance_app: role has BYPASSRLS',
        `endToEnd: ${NO_E2E_RESULT}`,
      ]),
    );
    const report = JSON.parse(await readFile(path.join(scratch, 'reports', REPORT_FILE), 'utf8')) as IsolationReport;
    expect(report.result).toBe('fail');
    expect(report.roles.rolbypassrls).toEqual(['finance_app']);
    expect(serviceRowOf(report, 'people').rlsCatalog).toEqual({ tables: 2, enabled: 2, forced: 1, usingAndWithCheck: 2 });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('closes the catalog client when a catalog query fails', async () => {
    const client = catalogClient(compliantRows());
    client.query = async () => {
      throw new Error('permission denied for table pg_authid');
    };

    await expect(run(client)).rejects.toThrow('permission denied for table pg_authid');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('rejects a results file that is not JSON, naming the file', async () => {
    await writeResults('services/people', '{"testResults": [');

    await expect(run(catalogClient(compliantRows()))).rejects.toThrow(
      `${vitestResultPath('services/people', env)}: is not valid JSON`,
    );
  });

  it('refuses to open the default catalog client without PostgreSQL settings', async () => {
    const outcome = main([], { env, clock: CLOCK, pin: () => PIN, topology: () => ({ subscriptions: {} }) });

    await expect(outcome).rejects.toThrow(
      'PostgreSQL catalog client settings missing or invalid: PG_HOST, PG_USER, PG_DATABASE',
    );
  });

  it.each([
    ['--help', HelpRequest],
    ['--verbose', UsageError],
  ] as const)('rejects %s without opening the catalog', async (flag, errorClass) => {
    const client = catalogClient(compliantRows());

    await expect(run(client, [flag])).rejects.toBeInstanceOf(errorClass);
    expect(client.close).not.toHaveBeenCalled();
  });
});
