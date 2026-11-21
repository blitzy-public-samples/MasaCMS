// Isolation report over the committed vitest and catalog samples, the committed report shape and the CLI's real defaults.
// Cases report-build.test.ts already covers (title table, package list, result-file path, missing inputs) are not repeated.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from '@opt2/platform/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { SERVICE_SCHEMAS, evaluateCatalog, type CatalogRows } from '../../src/isolation/catalog.js';
import type { GatewayIsolationResult } from '../../src/isolation/gateway-matrix.js';
import {
  ISOLATION_CATEGORIES,
  ISOLATION_PACKAGES,
  REPORT_FILE,
  UNCATEGORISED,
  buildIsolationReport,
  categoriseAssertion,
  consumerSubscriptions,
  endToEndResultSchema,
  main,
  summarisePackageResults,
  vitestJsonSchema,
  writeEndToEndResult,
  type AssertionCategory,
  type ConsumerIsolationRow,
  type ConsumerSubscription,
  type IsolationDeps,
  type IsolationReport,
  type IsolationReportInput,
  type ServiceIsolationRow,
  type VitestJson,
} from '../../src/isolation/report.js';
import { runCli } from '../../src/lib/cli.js';
import { REPO_ROOT, opt2Path, type EnvLike } from '../../src/lib/paths.js';
import type { CatalogClient } from '../../src/lib/pg.js';
import { vitestResultPath } from '../../src/reporting/speed.js';
import { deriveTopology, type SubscriptionEntry, type Topology } from '../../src/repro/pubsub-topology.js';

type JsonObject = Record<string, unknown>;
type CommittedReport = JsonObject & { status: string; services: JsonObject[] };

const VITEST_SAMPLE: unknown = JSON.parse(
  await readFile(new URL('../fixtures/reporting/vitest-results.sample.json', import.meta.url), 'utf8'),
);
const CATALOG_ROWS = JSON.parse(
  await readFile(new URL('../fixtures/catalog/pg-catalog-rows.sample.json', import.meta.url), 'utf8'),
) as CatalogRows;
const COMMITTED_PATH = opt2Path('reports', REPORT_FILE);
const COMMITTED = JSON.parse(await readFile(COMMITTED_PATH, 'utf8')) as CommittedReport;
const PIN_SHA = (JSON.parse(await readFile(opt2Path('source-pin.json'), 'utf8')) as { sha: string }).sha;

const GENERATED_AT = '2026-06-30T12:00:00.000Z';
const CLOCK = (): Date => new Date(GENERATED_AT);
const CONSUMER_KEYS = ['crossTenantEffects', 'fanoutRegistryOnly', 'subscription', 'tenantlessRejected'];
const ARCHIVED = 'timesheets.people.person.archived.v1';
const SCHEDULED = 'communications.surveys.survey.scheduled.v1';
const CLEAN_RUN: GatewayIsolationResult = { crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: true, cases: [] };

/** A push subscription entry of `consumer` on `topic`, shaped as `deriveTopology` writes it. */
function subscriptionEntry(consumer: string, topic: string): SubscriptionEntry {
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

const TOPOLOGY: Pick<Topology, 'subscriptions'> = {
  subscriptions: {
    [ARCHIVED]: subscriptionEntry('timesheets', 'people.person.archived.v1'),
    [SCHEDULED]: subscriptionEntry('communications', 'surveys.survey.scheduled.v1'),
  },
};
const TOPOLOGY_SUBSCRIPTIONS = consumerSubscriptions(TOPOLOGY);
const CONTRACT_SUBSCRIPTIONS = consumerSubscriptions(deriveTopology('local', REPO_ROOT));

/** A fresh parse of the committed vitest sample of services/people. */
function sample(): VitestJson {
  return vitestJsonSchema.parse(structuredClone(VITEST_SAMPLE));
}

/** `json` with every test file moved from services/people to services/<svc>. */
function withPackagePath(json: VitestJson, svc: string): VitestJson {
  const copy = structuredClone(json);
  for (const file of copy.testResults) file.name = file.name.replace('/services/people/', `/services/${svc}/`);
  return copy;
}

/** `json` with the passing tenantless, fan-out and effect cases `defineIsolationSuite` names per subscription of `svc`. */
function withConsumerEvidence(json: VitestJson, svc: string, subscriptions: readonly ConsumerSubscription[]): VitestJson {
  const copy = structuredClone(json);
  const file = copy.testResults.find((entry) => entry.name.includes('/test/isolation/'));
  if (file === undefined) throw new Error('the sample has no test/isolation/ file');
  for (const { subscription, consumer, topic, fanout } of subscriptions) {
    if (consumer !== svc) continue;
    const titles = [
      `an event without a tenant on ${subscription} is acked, dead-lettered as missing-tenant and changes no rows`,
      ...(fanout ? [`a ${topic} fan-out from umbrella reaches tenant A and tenant umbrella once each and never tenant B`] : []),
      `a tenant A delivery on ${subscription} is acked and changes no rows of tenant B or tenant umbrella`,
    ];
    for (const title of titles) {
      file.assertionResults.push({ ancestorTitles: [], title, fullName: title, status: 'passed', failureMessages: [] });
    }
  }
  return copy;
}

/** The assertions of the sample's `test/isolation/` file. */
function isolationAssertions(json: VitestJson): VitestJson['testResults'][number]['assertionResults'] {
  return json.testResults.filter((file) => file.name.includes('/test/isolation/')).flatMap((file) => file.assertionResults);
}

/** The committed catalog rows as they stand, with their unforced table and their BYPASSRLS role. */
function committedRows(): CatalogRows {
  return structuredClone(CATALOG_ROWS);
}

/** The committed catalog rows with their two defects repaired. */
function compliantRows(): CatalogRows {
  const rows = committedRows();
  for (const table of rows.tables) {
    if (table.schema === 'timesheets' && table.table === 'blackout') table.relforcerowsecurity = true;
  }
  for (const role of rows.roles) if (role.rolname === 'finance_app') role.rolbypassrls = false;
  return rows;
}

/** The compliant rows plus people_app reaching a BYPASSRLS role through people_owner. */
function rowsWithMembershipViolation(): CatalogRows {
  const rows = compliantRows();
  const escalation = {
    member: 'people_app',
    ancestor: 'cloudsqlsuperuser',
    via: ['people_owner'],
    rolsuper: false,
    rolbypassrls: true,
  };
  return { ...rows, memberships: [...rows.memberships, escalation] };
}

/** Report input: the sample with the fixed topology's named evidence per package, the compliant catalog, a clean gateway run. */
function passingInput(overrides: Partial<IsolationReportInput> = {}): IsolationReportInput {
  return {
    sha: PIN_SHA,
    generatedAt: GENERATED_AT,
    packages: ISOLATION_PACKAGES.map((pkg) => ({
      ...pkg,
      path: `\${OPT2_STATE_DIR}/test-all/vitest/services-${pkg.service}.json`,
      json: withConsumerEvidence(withPackagePath(sample(), pkg.service), pkg.service, TOPOLOGY_SUBSCRIPTIONS),
    })),
    endToEnd: endToEndResultSchema.parse({ writtenAt: GENERATED_AT, gateway: CLEAN_RUN }),
    catalog: evaluateCatalog(compliantRows()),
    subscriptions: TOPOLOGY_SUBSCRIPTIONS,
    ...overrides,
  };
}

/** `input` with the first isolation assertion of `category` in the results of `service`, naming `naming` if given, failed. */
function withFailedAssertion(
  input: IsolationReportInput,
  service: string,
  category: AssertionCategory,
  naming?: string,
): IsolationReportInput {
  const packages = input.packages.map((pkg) => {
    if (pkg.service !== service || pkg.json === null) return pkg;
    const json = structuredClone(pkg.json);
    const target = isolationAssertions(json).find(
      (assertion) =>
        categoriseAssertion(assertion.fullName) === category && (naming === undefined || assertion.fullName.includes(naming)),
    );
    if (target === undefined) throw new Error(`the input has no matching ${category} assertion`);
    target.status = 'failed';
    target.failureMessages = ['AssertionError: expected 1 to be 0 // Object.is equality'];
    return { ...pkg, json };
  });
  return { ...input, packages };
}

/** `input` with its gateway run changed by `overrides`. */
function withGatewayRun(input: IsolationReportInput, overrides: Partial<GatewayIsolationResult>): IsolationReportInput {
  const gateway = { ...CLEAN_RUN, ...overrides };
  return { ...input, endToEnd: endToEndResultSchema.parse({ writtenAt: GENERATED_AT, gateway }) };
}

/** Sorted own keys of `value`. */
function keysOf(value: unknown): string[] {
  return Object.keys(value as object).sort();
}

/** The service row of `service` in `report`. */
function rowOf(report: IsolationReport, service: string): ServiceIsolationRow {
  const row = report.services.find((candidate) => candidate.service === service);
  if (row === undefined) throw new Error(`report has no service row ${service}`);
  return row;
}

/** The consumer row of `subscription` in `report`. */
function consumerOf(report: IsolationReport, subscription: string): ConsumerIsolationRow {
  const row = report.consumers.find((candidate) => candidate.subscription === subscription);
  if (row === undefined) throw new Error(`report has no consumer row ${subscription}`);
  return row;
}

/** Asserts `report` has the key set of the committed report, placeholder or generated, at every level it fills. */
function expectCommittedShape(report: IsolationReport): void {
  const committedRow = COMMITTED.services[0];
  expect(keysOf(report)).toEqual(keysOf(COMMITTED));
  for (const field of ['tenants', 'roles', 'endToEnd'] as const) {
    expect(keysOf(report[field])).toEqual(keysOf(COMMITTED[field]));
  }
  for (const row of report.services) {
    expect(keysOf(row)).toEqual(keysOf(committedRow));
    expect(keysOf(row.pooledConnectionReuse)).toEqual(keysOf(committedRow?.pooledConnectionReuse));
    expect(keysOf(row.rlsCatalog)).toEqual(keysOf(committedRow?.rlsCatalog));
  }
  for (const row of report.consumers) expect(keysOf(row)).toEqual(CONSUMER_KEYS);
  expect(report.services.map((row) => row.service)).toEqual(COMMITTED.services.map((row) => row.service));
  expect(report.services.map((row) => row.schema)).toEqual(SERVICE_SCHEMAS.map(({ schema }) => schema));
}

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

describe('the committed vitest sample', () => {
  it('parses as vitest JSON, and a results file without testResults is rejected', () => {
    const raw = structuredClone(VITEST_SAMPLE) as JsonObject;
    delete raw.testResults;

    expect(sample().testResults).toHaveLength(3);
    expect(() => vitestJsonSchema.parse(raw)).toThrow(z.ZodError);
  });

  it('files each isolation assertion under its own category, together covering every category', () => {
    const categories = isolationAssertions(sample()).map((assertion) => categoriseAssertion(assertion.fullName));

    expect(categories).not.toContain(UNCATEGORISED);
    expect(new Set(categories).size).toBe(categories.length);
    expect([...categories].sort()).toEqual(Object.keys(ISOLATION_CATEGORIES).sort());
  });

  it.each([
    '[events:duplicateDelivery] duplicate delivery causes one effect',
    'person joins first and last name into the display name',
    'formats dates',
  ])('leaves %j uncategorised', (fullName) => {
    expect(categoriseAssertion(fullName)).toBe(UNCATEGORISED);
  });

  it('summarises only the isolation file, so the failed events assertion and the unit assertions are left out', () => {
    const json = sample();
    const failed = json.testResults.flatMap((file) =>
      file.assertionResults.filter((assertion) => assertion.status === 'failed').map(() => file.name),
    );

    const summary = summarisePackageResults('services/people', json);

    expect(failed).toEqual(['/workspace/opt2/services/people/test/events/archive-events.test.ts']);
    expect(summary.present).toBe(true);
    expect(summary.assertions.map((assertion) => assertion.file)).toEqual(
      isolationAssertions(json).map(() => '/workspace/opt2/services/people/test/isolation/tenant-isolation.test.ts'),
    );
    for (const category of Object.keys(ISOLATION_CATEGORIES) as AssertionCategory[]) {
      expect(summary.categories[category]).toEqual({ passed: 1, failed: 0, notRun: 0 });
    }
    expect(summary.categories[UNCATEGORISED]).toEqual({ passed: 0, failed: 0, notRun: 0 });
  });
});

describe('buildIsolationReport over the samples', () => {
  it('emits the committed report shape, one row per service in schema order', () => {
    const { report } = buildIsolationReport(passingInput());

    expectCommittedShape(report);
    expect(report.consumers.map((row) => row.subscription)).toEqual([SCHEDULED, ARCHIVED]);
  });

  it('passes when every package shows the clean sample, the catalog is compliant and the gateway run is clean', () => {
    const built = buildIsolationReport(passingInput());
    const { report } = built;

    expect(built.findings).toEqual([]);
    expect(built.servicesFailing).toEqual([]);
    expect(report).toMatchObject({ sourceSha: PIN_SHA, status: 'generated', result: 'pass' });
    expect(report.passCondition.length).toBeGreaterThan(0);
    for (const row of report.services) {
      expect(row).toMatchObject({
        crossTenantReads: 0,
        crossTenantWrites: 0,
        pooledConnectionReuse: { rowsSeen: 0, writeBlocked: true },
      });
      const { tables, enabled, forced, usingAndWithCheck } = row.rlsCatalog;
      expect(tables).toBeGreaterThan(0);
      expect([enabled, forced, usingAndWithCheck]).toEqual([tables, tables, tables]);
    }
    expect(report.consumers).toEqual([
      { subscription: SCHEDULED, tenantlessRejected: true, fanoutRegistryOnly: null, crossTenantEffects: 0 },
      { subscription: ARCHIVED, tenantlessRejected: true, fanoutRegistryOnly: true, crossTenantEffects: 0 },
    ]);
    expect(report.roles).toEqual({ rolbypassrls: [], rolsuper: [], membershipViolations: [] });
    expect(report.endToEnd).toMatchObject({ crossTenantReads: 0, crossTenantWrites: 0, surveyGrantOnly: true });
  });

  it.each<[string, (input: IsolationReportInput) => IsolationReportInput, (report: IsolationReport) => unknown, unknown]>([
    [
      'the catalog shows the committed unforced table and BYPASSRLS role',
      (input) => ({ ...input, catalog: evaluateCatalog(committedRows()) }),
      (report) => [report.roles.rolbypassrls, rowOf(report, 'timesheets').rlsCatalog],
      [['finance_app'], { tables: 1, enabled: 1, forced: 0, usingAndWithCheck: 1 }],
    ],
    [
      'one service shows a cross-tenant write',
      (input) => withFailedAssertion(input, 'people', 'crossTenantWrites'),
      (report) => rowOf(report, 'people').crossTenantWrites,
      1,
    ],
    [
      'the gateway shows a cross-tenant read',
      (input) => withGatewayRun(input, { crossTenantReads: 1 }),
      (report) => report.endToEnd.crossTenantReads,
      1,
    ],
    [
      'the gateway admitted a survey response for an ungranted site',
      (input) => withGatewayRun(input, { surveyGrantOnly: false }),
      (report) => report.endToEnd.surveyGrantOnly,
      false,
    ],
    [
      'a consumer applies an event to another tenant',
      (input) => withFailedAssertion(input, 'timesheets', 'crossTenantEffects', ARCHIVED),
      (report) => consumerOf(report, ARCHIVED).crossTenantEffects,
      1,
    ],
    [
      'a consumer does not dead-letter a tenantless event',
      (input) => withFailedAssertion(input, 'communications', 'tenantlessRejected', SCHEDULED),
      (report) => consumerOf(report, SCHEDULED).tenantlessRejected,
      false,
    ],
    [
      'a service role is a member of a BYPASSRLS role',
      (input) => ({ ...input, catalog: evaluateCatalog(rowsWithMembershipViolation()) }),
      (report) => report.roles.membershipViolations,
      [{ member: 'people_app', ancestor: 'cloudsqlsuperuser', via: ['people_owner'] }],
    ],
  ])('fails when %s', (_label, edit, probe, expected) => {
    const { report } = buildIsolationReport(edit(passingInput()));

    expect(probe(report)).toEqual(expected);
    expect(report.result).toBe('fail');
  });

  it('fails an uncovered consumer of a package whose other consumer is covered, without crediting it that evidence', () => {
    const covered = TOPOLOGY_SUBSCRIPTIONS.find((subscription) => subscription.subscription === ARCHIVED);
    if (covered === undefined) throw new Error(`the fixed topology has no ${ARCHIVED}`);
    const uncovered: ConsumerSubscription = {
      subscription: 'timesheets.programs-sites.site.changed.v1',
      consumer: 'timesheets',
      topic: 'programs-sites.site.changed.v1',
      fanout: false,
    };

    const built = buildIsolationReport(passingInput({ subscriptions: [covered, uncovered] }));

    expect(built.report.consumers).toEqual([
      { subscription: ARCHIVED, tenantlessRejected: true, fanoutRegistryOnly: true, crossTenantEffects: 0 },
      { subscription: uncovered.subscription, tenantlessRejected: false, fanoutRegistryOnly: null, crossTenantEffects: null },
    ]);
    const naming = `naming ${uncovered.subscription} or ${uncovered.topic} in its consumer package`;
    expect(built.findings).toEqual(
      [`no tenantless-event assertion ${naming}`, `no cross-tenant effect assertion ${naming}`].map((detail) => ({
        scope: `consumer ${uncovered.subscription}`,
        service: 'timesheets',
        detail,
      })),
    );
    expect(built.servicesFailing).toEqual(['timesheets']);
    expect(built.report.result).toBe('fail');
  });

  it('gives equal reports for equal inputs and leaves its input unchanged, even when the report is edited', () => {
    const input = passingInput({ catalog: evaluateCatalog(rowsWithMembershipViolation()) });
    const before = structuredClone(input);

    const first = buildIsolationReport(input);
    const second = buildIsolationReport(structuredClone(input));
    rowOf(first.report, 'identity').rlsCatalog.tables += 1;
    first.report.roles.membershipViolations[0]?.via.push('identity_owner');

    expect(input).toEqual(before);
    expect(buildIsolationReport(input)).toEqual(second);
  });
});

describe('endToEndResultSchema', () => {
  it.each(['surveyGrantOnly', 'crossTenantWrites', 'cases'] as const)('rejects a gateway run without %s', (field) => {
    const gateway: Partial<GatewayIsolationResult> = { ...CLEAN_RUN };
    delete gateway[field];

    expect(endToEndResultSchema.safeParse({ writtenAt: GENERATED_AT, gateway }).success).toBe(false);
  });
});

describe('main', () => {
  let state: string;
  let reports: string;
  let env: EnvLike;
  let committedBytes: Buffer;

  /** Writes the sample with named evidence of every contract subscription as each package's results, and `gateway`. */
  async function arrange(gateway: GatewayIsolationResult = CLEAN_RUN): Promise<void> {
    for (const pkg of ISOLATION_PACKAGES) {
      const file = vitestResultPath(pkg.pkg, env);
      const json = withConsumerEvidence(withPackagePath(sample(), pkg.service), pkg.service, CONTRACT_SUBSCRIPTIONS);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(json), 'utf8');
    }
    await writeEndToEndResult(gateway, env, { clock: CLOCK });
  }

  /** Deps with the fixed clock and topology, the real pin, and a catalog client over `rows`. */
  function deps(rows: CatalogRows): IsolationDeps {
    return { env, clock: CLOCK, openCatalog: async () => catalogClient(rows), topology: () => TOPOLOGY };
  }

  /** The report main wrote, once the temp reports dir is shown to hold only it and the committed report unchanged. */
  async function writtenReport(): Promise<IsolationReport> {
    expect(await readFile(COMMITTED_PATH)).toEqual(committedBytes);
    expect(await readdir(reports)).toEqual([REPORT_FILE]);
    return JSON.parse(await readFile(join(reports, REPORT_FILE), 'utf8')) as IsolationReport;
  }

  beforeEach(async () => {
    state = await mkdtemp(join(tmpdir(), 'opt2-isolation-state-'));
    reports = await mkdtemp(join(tmpdir(), 'opt2-isolation-reports-'));
    env = { OPT2_STATE_DIR: state, OPT2_REPORTS_DIR: reports };
    committedBytes = await readFile(COMMITTED_PATH);
  });

  afterEach(async () => {
    await rm(state, { recursive: true, force: true });
    await rm(reports, { recursive: true, force: true });
  });

  it('writes a passing report with the pinned SHA, the current time and the contracts topology by default', async () => {
    await arrange();
    const client = catalogClient(compliantRows());
    const before = Date.now();

    const outcome = await main([], { env, openCatalog: async () => client });

    const after = Date.now();
    expect(outcome).toMatchObject({
      code: 0,
      summary: { written: join(reports, REPORT_FILE), result: 'pass', findings: 0 },
    });
    const report = await writtenReport();
    expectCommittedShape(report);
    expect(report).toMatchObject({ sourceSha: PIN_SHA, status: 'generated', result: 'pass' });
    expect(Date.parse(report.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(report.generatedAt)).toBeLessThanOrEqual(after);
    expect(report.consumers.map((row) => row.subscription)).toEqual(
      consumerSubscriptions(deriveTopology('local', REPO_ROOT)).map(({ subscription }) => subscription),
    );
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('exits 1 and still writes the failing report when the catalog shows the committed defects', async () => {
    await arrange();

    const outcome = await main([], deps(committedRows()));

    expect(outcome).toMatchObject({ code: 1, summary: { result: 'fail', servicesFailing: ['timesheets', 'finance'] } });
    const report = await writtenReport();
    expect(report).toMatchObject({ sourceSha: PIN_SHA, generatedAt: GENERATED_AT, result: 'fail' });
    expect(report.roles.rolbypassrls).toEqual(['finance_app']);
    expect(rowOf(report, 'timesheets').rlsCatalog).toMatchObject({ tables: 1, forced: 0 });
  });

  it.each<[string, GatewayIsolationResult, number, string]>([
    ['a clean gateway run', CLEAN_RUN, 0, 'pass'],
    ['a gateway run with a cross-tenant write', { ...CLEAN_RUN, crossTenantWrites: 1 }, 1, 'fail'],
  ])('prints one JSON summary line through runCli for %s', async (_label, gateway, code, result) => {
    await arrange(gateway);
    const chunks: string[] = [];
    const exit = vi.fn();

    const exitCode = await runCli((argv) => main(argv, deps(compliantRows())), {
      argv: [],
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit,
      command: 'report:isolation',
    });

    expect(exitCode).toBe(code);
    expect(exit).toHaveBeenCalledWith(code);
    const [line, ...rest] = chunks.join('').split('\n');
    expect(rest).toEqual(['']);
    expect(JSON.parse(line ?? '')).toMatchObject({ command: 'report:isolation', ok: code === 0, code, result });
    expect((await writtenReport()).result).toBe(result);
  });
});
