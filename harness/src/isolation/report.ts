// Isolation report: merges every service's test/isolation results, the end-to-end gateway matrix and the live catalog
// checks into opt2/reports/isolation.json.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isTopicName, readTopicSchema, topicMeta, topicSchemaRelativePath } from '@opt2/platform/events';
import { z } from '@opt2/platform/service-kit';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA } from '@opt2/platform/testing';

import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, reportsDir, stateDir, type EnvLike } from '../lib/paths.js';
import { createCatalogClient, type CatalogClient } from '../lib/pg.js';
import { readPin, type Pin } from '../lib/pin.js';
import { readJson, stableStringify, writeJsonReport } from '../lib/report.js';
import { vitestResultPath } from '../reporting/speed.js';
import { deriveTopology, type Topology } from '../repro/pubsub-topology.js';
import {
  ROLE_SUFFIXES,
  SERVICE_SCHEMAS,
  runCatalogChecks,
  type CatalogRunResult,
  type RlsCatalogSummary,
  type RoleFindings,
} from './catalog.js';
import type { CaseResult, GatewayIsolationResult } from './gateway-matrix.js';

/** Recorded as the report's `generatedBy`. */
export const GENERATED_BY = 'harness/src/isolation/report.ts';

/** File name of the report under the reports directory. */
export const REPORT_FILE = 'isolation.json';

/** The end-to-end result file, relative to `OPT2_STATE_DIR`. */
export const E2E_RESULT_RELATIVE = 'results/e2e-isolation.json';

/** How state-directory paths are shown in the report, so no host path reaches the committed file. */
const STATE_LABEL = '${OPT2_STATE_DIR}';

/** Reason the gateway matrix gives a case it skipped because the legacy fixtures are unavailable (`golden/catalogue.ts`). */
const FIXTURES_UNAVAILABLE = 'skipped: fixtures unavailable';

/** One service package whose `test/isolation` results feed the report. */
export interface IsolationPackage {
  service: string;
  schema: string;
  /** Repository-relative folder, `services/<service>`. */
  pkg: string;
}

/** The ten services and the stub, in report order. */
export const ISOLATION_PACKAGES: readonly IsolationPackage[] = Object.freeze(
  SERVICE_SCHEMAS.map(({ service, schema }) => Object.freeze({ service, schema, pkg: `services/${service}` })),
);

/** Categories counted on the service rows. */
export const SERVICE_CATEGORIES = Object.freeze(['crossTenantReads', 'crossTenantWrites', 'pooledConnectionReuse'] as const);

/** Categories counted on the event-consumer rows. */
export const EVENT_CATEGORIES = Object.freeze(['tenantlessRejected', 'fanoutRegistryOnly', 'crossTenantEffects'] as const);

/** A category an isolation assertion is counted under. */
export type IsolationCategory =
  | (typeof SERVICE_CATEGORIES)[number]
  | (typeof EVENT_CATEGORIES)[number]
  | 'grant'
  | 'catalog';

/** Category of an assertion no matcher accepts; its failures are still findings. */
export const UNCATEGORISED = 'uncategorised';

/** {@link IsolationCategory} or {@link UNCATEGORISED}. */
export type AssertionCategory = IsolationCategory | typeof UNCATEGORISED;

/** Whether an assertion's vitest `fullName` belongs to a category. */
export type TitleMatcher = (fullName: string) => boolean;

const TOKEN_SEPARATORS = /[\s,;:()[\]{}'"`]+/;

/** The whitespace- and punctuation-separated words of `fullName`, without leading or trailing dots. */
function titleTokens(fullName: string): string[] {
  return fullName
    .split(TOKEN_SEPARATORS)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .filter((token) => token !== '');
}

/** Whether `fullName` names an event topic or a `<consumer>.<topic>` subscription. */
function namesTopic(fullName: string): boolean {
  return titleTokens(fullName).some((token) =>
    [token, token.slice(token.indexOf('.') + 1)].some((candidate) => isTopicName(candidate)),
  );
}

function matching(...patterns: RegExp[]): TitleMatcher {
  return (fullName) => patterns.some((pattern) => pattern.test(fullName));
}

/**
 * Title matchers per category, tried in this order. Each matches the title `defineIsolationSuite` of
 * `@opt2/platform/testing` generates for the category; the tenantless and fan-out matchers also accept the services'
 * own phrasings of the same case, and `crossTenantEffects` takes any remaining assertion that names an event topic.
 */
export const ISOLATION_CATEGORIES: Readonly<Record<IsolationCategory, TitleMatcher>> = Object.freeze({
  tenantlessRejected: matching(/\b(?:without a tenant|tenant-?less)\b.*\bdead-letter/i),
  fanoutRegistryOnly: matching(/\bfan(?:-out| out|s[- ]out)\b/i),
  grant: matching(/\bgrant to tenant \S+ admits tenant \S+ and not tenant \S+$/),
  pooledConnectionReuse: matching(/\bpooled connection reused after a tenant \S+ transaction\b/),
  crossTenantReads: matching(/\btenant \S+ sees only its own rows in \S+$/),
  crossTenantWrites: matching(/\btenant \S+ cannot insert, move into, update or delete rows of tenant \S+ in \S+$/),
  catalog: matching(
    /\bevery tenant table has forced RLS with USING and WITH CHECK\b/,
    /\bthe repository guard refuses tenant work outside withTenant\b/,
  ),
  crossTenantEffects: namesTopic,
});

const CATEGORY_ORDER = Object.freeze(Object.keys(ISOLATION_CATEGORIES) as IsolationCategory[]);

/** The first category whose matcher accepts `fullName`, or {@link UNCATEGORISED}. */
export function categoriseAssertion(fullName: string): AssertionCategory {
  return CATEGORY_ORDER.find((category) => ISOLATION_CATEGORIES[category](fullName)) ?? UNCATEGORISED;
}

const ASSERTION_STATUSES = Object.freeze(['passed', 'failed', 'skipped', 'pending', 'todo', 'disabled'] as const);

/** Status of one vitest assertion; every status but `passed` and `failed` means the assertion did not run. */
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

/** The vitest JSON reporter fields the report reads; other fields pass through. */
export const vitestJsonSchema = z.looseObject({
  testResults: z.array(
    z.looseObject({
      name: z.string(),
      assertionResults: z.array(
        z.looseObject({
          ancestorTitles: z.array(z.string()),
          title: z.string(),
          fullName: z.string(),
          status: z.enum(ASSERTION_STATUSES),
          failureMessages: z.array(z.string()).nullish(),
        }),
      ),
    }),
  ),
});

/** A parsed vitest JSON results file. */
export type VitestJson = z.infer<typeof vitestJsonSchema>;

const CASE_RESULTS = Object.freeze(['pass', 'violation', 'inconclusive', 'skipped'] as const) satisfies readonly CaseResult[];

type AssertNever<T extends never> = T;
// Fails to compile when the gateway matrix gains a case result this schema does not accept.
type UnlistedCaseResult = AssertNever<Exclude<CaseResult, (typeof CASE_RESULTS)[number]>>;

const count = z.number().int().nonnegative();

/**
 * The end-to-end result file: one gateway matrix run, when it was written and the gateway it ran against. Parsing keeps
 * only the case fields the report reads.
 */
export const endToEndResultSchema = z.looseObject({
  writtenAt: z.string(),
  baseUrl: z.string().optional(),
  gateway: z.object({
    crossTenantReads: count,
    crossTenantWrites: count,
    surveyGrantOnly: z.boolean(),
    cases: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        result: z.enum(CASE_RESULTS),
        reason: z.string().optional(),
      }),
    ),
  }),
});

/** A parsed end-to-end result file. */
export type EndToEndResult = z.infer<typeof endToEndResultSchema>;

/** `${OPT2_STATE_DIR}/results/e2e-isolation.json`. */
export function e2eIsolationResultPath(env: EnvLike = process.env): string {
  return path.join(stateDir(env), ...E2E_RESULT_RELATIVE.split('/'));
}

/** Options of {@link writeEndToEndResult}. */
export interface EndToEndWriteOptions {
  /** Gateway base URL the run used, shown as the report's `endToEnd.via`. */
  baseUrl?: string;
  clock?: () => Date;
}

/** Writes one gateway matrix run to {@link e2eIsolationResultPath}, creating its directory; returns the file path. */
export async function writeEndToEndResult(
  result: GatewayIsolationResult,
  env: EnvLike = process.env,
  opts: EndToEndWriteOptions = {},
): Promise<string> {
  const file = e2eIsolationResultPath(env);
  const body: z.input<typeof endToEndResultSchema> = {
    writtenAt: (opts.clock ?? (() => new Date()))().toISOString(),
    baseUrl: opts.baseUrl,
    gateway: result,
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stableStringify(body), 'utf8');
  return file;
}

/** One assertion of a package's `test/isolation/` files. */
export interface IsolationAssertion {
  file: string;
  fullName: string;
  status: AssertionStatus;
  category: AssertionCategory;
  failureMessages: string[];
}

/** Assertion outcomes of one category. */
export interface CategoryTally {
  passed: number;
  failed: number;
  /** Skipped, pending, todo or disabled. */
  notRun: number;
}

/** The isolation assertions of one package's vitest results and their tallies per category. */
export interface PackageResultSummary {
  pkg: string;
  /** Whether a results file was read. */
  present: boolean;
  assertions: IsolationAssertion[];
  categories: Record<AssertionCategory, CategoryTally>;
}

function emptyTallies(): Record<AssertionCategory, CategoryTally> {
  const tallies = {} as Record<AssertionCategory, CategoryTally>;
  for (const category of [...CATEGORY_ORDER, UNCATEGORISED] as const) tallies[category] = { passed: 0, failed: 0, notRun: 0 };
  return tallies;
}

/** Whether test file `name` (absolute as vitest reports it, or package-relative) lies under `<pkg>/test/isolation/`. */
function isIsolationFile(name: string, pkg: string): boolean {
  const file = name.split('\\').join('/');
  return file.includes(`/${pkg}/test/isolation/`) || file.startsWith(`${pkg}/test/isolation/`) || file.startsWith('test/isolation/');
}

/** Categorises and tallies the assertions of `json` that come from `pkg`'s `test/isolation/` files; `null` is no file. */
export function summarisePackageResults(pkg: string, json: VitestJson | null): PackageResultSummary {
  const categories = emptyTallies();
  const assertions: IsolationAssertion[] = [];
  for (const file of json?.testResults ?? []) {
    if (!isIsolationFile(file.name, pkg)) continue;
    for (const result of file.assertionResults) {
      const category = categoriseAssertion(result.fullName);
      const tally = categories[category];
      if (result.status === 'passed') tally.passed += 1;
      else if (result.status === 'failed') tally.failed += 1;
      else tally.notRun += 1;
      assertions.push({
        file: file.name,
        fullName: result.fullName,
        status: result.status,
        category,
        failureMessages: result.failureMessages ?? [],
      });
    }
  }
  return { pkg, present: json !== null, assertions, categories };
}

/** What a reused pooled connection showed after a tenant transaction. */
export type PooledConnectionReuse = {
  /** Failed reuse assertions whose reused connection still saw rows or the tenant setting. */
  rowsSeen: number;
  /** True only when reuse assertions exist and every one passed, its write probe included. */
  writeBlocked: boolean;
};

/** One service row of the report. */
export type ServiceIsolationRow = {
  service: string;
  schema: string;
  crossTenantReads: number;
  crossTenantWrites: number;
  pooledConnectionReuse: PooledConnectionReuse;
  rlsCatalog: RlsCatalogSummary;
  /** The vitest results file read, under `${OPT2_STATE_DIR}`; null when absent. */
  source: string | null;
};

/** One event-consumer subscription row of the report. */
export type ConsumerIsolationRow = {
  subscription: string;
  tenantlessRejected: boolean;
  /** Null when the topic declares no `x-opt2-tenant-fanout`. */
  fanoutRegistryOnly: boolean | null;
  crossTenantEffects: number;
};

/** The end-to-end gateway figures; counts are null when the result file is absent. */
export type EndToEndIsolation = {
  via: string;
  crossTenantReads: number | null;
  crossTenantWrites: number | null;
  surveyGrantOnly: boolean | null;
  fanoutRegistryOnly: boolean | null;
  source: string | null;
};

/** Body of `opt2/reports/isolation.json`. */
export type IsolationReport = {
  sourceSha: string;
  generatedBy: string;
  generatedAt: string;
  status: 'generated';
  tenants: { a: string; b: string; umbrella: string; idRule: string };
  passCondition: string;
  services: ServiceIsolationRow[];
  consumers: ConsumerIsolationRow[];
  roles: RoleFindings;
  endToEnd: EndToEndIsolation;
  result: 'pass' | 'fail';
};

/** One reason the report fails; `service` names the service it is attributed to, when any. */
export interface IsolationFinding {
  scope: string;
  detail: string;
  service?: string;
}

/** A push subscription as the consumer rows need it. */
export interface ConsumerSubscription {
  subscription: string;
  /** Consuming service package, `services/<consumer>`'s folder name. */
  consumer: string;
  topic: string;
  /** Whether the topic schema declares `x-opt2-tenant-fanout`. */
  fanout: boolean;
}

/** One package's vitest results as read. */
export interface PackageResultInput extends IsolationPackage {
  /** The results file as shown in the report. */
  path: string;
  json: VitestJson | null;
}

/** Inputs of {@link buildIsolationReport}. */
export interface IsolationReportInput {
  sha: string;
  generatedAt: string;
  packages: readonly PackageResultInput[];
  endToEnd: EndToEndResult | null;
  catalog: CatalogRunResult;
  subscriptions: readonly ConsumerSubscription[];
}

/** The report with every finding, the services those findings or non-zero counts fail, and the allowed skipped e2e cases. */
export interface IsolationBuild {
  report: IsolationReport;
  findings: IsolationFinding[];
  servicesFailing: string[];
  endToEndSkipped: string[];
}

/** The pass condition the report states. */
export const PASS_CONDITION =
  'Zero cross-tenant reads and writes for every service, every event consumer and end to end through the gateway; ' +
  'RLS enabled and forced with USING and WITH CHECK on every tenant table; no service role with rolsuper or ' +
  'rolbypassrls, or a member of such a role directly or transitively; tenantless events dead-lettered; fan-out only to ' +
  'registry-derived tenants; survey responses only for granted tenants; and no finding.';

const TENANT_ID_RULE = `tenantIdForSite(siteID): UUIDv5 of the lower-cased siteID; ${[TENANT_A, TENANT_B, TENANT_UMBRELLA]
  .map((tenant) => `${tenant.siteId} = ${tenant.tenantId}`)
  .join(', ')}`;

// The expect message defineIsolationSuite gives the reused connection's post-transaction view.
const ROWS_SEEN_MESSAGE = 'the same connection after the transaction';

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function passedAll(assertions: readonly IsolationAssertion[]): boolean {
  return assertions.length > 0 && assertions.every((assertion) => assertion.status === 'passed');
}

function failedCount(assertions: readonly IsolationAssertion[]): number {
  return assertions.filter((assertion) => assertion.status === 'failed').length;
}

function ofCategory(summary: PackageResultSummary, category: AssertionCategory): IsolationAssertion[] {
  return summary.assertions.filter((assertion) => assertion.category === category);
}

function pooledReuseOf(summary: PackageResultSummary): PooledConnectionReuse {
  const reuse = ofCategory(summary, 'pooledConnectionReuse');
  const rowsSeen = reuse.filter(
    (assertion) => assertion.status === 'failed' && assertion.failureMessages.some((message) => message.includes(ROWS_SEEN_MESSAGE)),
  ).length;
  return { rowsSeen, writeBlocked: passedAll(reuse) };
}

/** The service row of `pkg` and its findings: no results, nothing shown, assertions not run or failed, no RLS counts. */
function serviceRow(
  pkg: IsolationPackage,
  input: PackageResultInput | undefined,
  summary: PackageResultSummary,
  catalog: CatalogRunResult,
  findings: IsolationFinding[],
): ServiceIsolationRow {
  const found = (detail: string): void => {
    findings.push({ scope: pkg.pkg, service: pkg.service, detail });
  };
  if (input === undefined || input.json === null) {
    found(`no vitest results${input === undefined ? '' : ` at ${input.path}`}; isolation was not shown`);
  } else if (summary.assertions.length === 0) {
    found(`no assertions from ${pkg.pkg}/test/isolation/ in ${input.path}; isolation was not shown`);
  } else {
    for (const category of SERVICE_CATEGORIES) {
      if (ofCategory(summary, category).length === 0) found(`no ${category} assertions under test/isolation/`);
    }
    const notRun = summary.assertions.filter((assertion) => assertion.status !== 'passed' && assertion.status !== 'failed');
    if (notRun.length > 0) {
      found(`${notRun.length} isolation assertions did not run (skipped, pending, todo or disabled); isolation was not shown`);
    }
    for (const assertion of summary.assertions) {
      if (assertion.status === 'failed') found(`failed [${assertion.category}]: ${assertion.fullName}`);
    }
  }

  const rls = catalog.rlsCatalog[pkg.schema];
  if (rls === undefined) found(`no RLS catalog counts for schema ${pkg.schema}`);
  return {
    service: pkg.service,
    schema: pkg.schema,
    crossTenantReads: failedCount(ofCategory(summary, 'crossTenantReads')),
    crossTenantWrites: failedCount(ofCategory(summary, 'crossTenantWrites')),
    pooledConnectionReuse: pooledReuseOf(summary),
    rlsCatalog: rls === undefined ? { tables: 0, enabled: 0, forced: 0, usingAndWithCheck: 0 } : { ...rls },
    source: input?.json == null ? null : input.path,
  };
}

/** Whether `fullName` names `subscription` or its topic as a whole word. */
function namesSubscription(fullName: string, subscription: ConsumerSubscription): boolean {
  return titleTokens(fullName).some((token) => token === subscription.subscription || token === subscription.topic);
}

/**
 * The consumer row of `subscription` and its findings. Per event category, the consumer package's assertions naming the
 * subscription or its topic apply; when none does, every assertion of that category in the package applies.
 */
function consumerRow(
  subscription: ConsumerSubscription,
  summaries: ReadonlyMap<string, PackageResultSummary>,
  findings: IsolationFinding[],
): ConsumerIsolationRow {
  const found = (detail: string): void => {
    findings.push({ scope: `consumer ${subscription.subscription}`, service: subscription.consumer, detail });
  };
  const summary = summaries.get(subscription.consumer);
  if (summary === undefined) found(`consumer ${subscription.consumer} is not one of the isolation packages`);
  const applicable = (category: AssertionCategory): IsolationAssertion[] => {
    const all = summary === undefined ? [] : ofCategory(summary, category);
    const named = all.filter((assertion) => namesSubscription(assertion.fullName, subscription));
    return named.length > 0 ? named : all;
  };

  const tenantless = applicable('tenantlessRejected');
  const fanout = subscription.fanout ? applicable('fanoutRegistryOnly') : [];
  const effects = applicable('crossTenantEffects');
  const tenantlessRejected = passedAll(tenantless);
  const fanoutRegistryOnly = subscription.fanout ? passedAll(fanout) : null;
  if (!tenantlessRejected) {
    found(tenantless.length === 0 ? 'no tenantless-event assertion in its consumer package' : 'tenantless-event assertions did not all pass');
  }
  if (fanoutRegistryOnly === false) {
    found(
      fanout.length === 0
        ? `fan-out topic ${subscription.topic} has no fan-out assertion in its consumer package`
        : 'fan-out assertions did not all pass',
    );
  }
  return {
    subscription: subscription.subscription,
    tenantlessRejected,
    fanoutRegistryOnly,
    crossTenantEffects: failedCount([...new Set([...tenantless, ...fanout, ...effects])]),
  };
}

/** The service owning catalog finding `object`: `<schema>`, `<schema>.<table>` or a `<schema>_<suffix>` role. */
function serviceOfCatalogObject(object: string): string | undefined {
  return ISOLATION_PACKAGES.find(
    ({ schema }) =>
      object === schema || object.startsWith(`${schema}.`) || ROLE_SUFFIXES.some((suffix) => object === `${schema}_${suffix}`),
  )?.service;
}

/** The end-to-end figures and their findings; fixture-unavailable skips are collected into `skipped` instead. */
function endToEndOf(result: EndToEndResult | null, findings: IsolationFinding[], skipped: string[]): EndToEndIsolation {
  const found = (detail: string): void => {
    findings.push({ scope: 'endToEnd', detail });
  };
  if (result === null) {
    found(`no end-to-end result at ${STATE_LABEL}/${E2E_RESULT_RELATIVE}; harness/e2e/isolation writes it after the gateway matrix`);
    return { via: 'gateway', crossTenantReads: null, crossTenantWrites: null, surveyGrantOnly: null, fanoutRegistryOnly: null, source: null };
  }
  const { gateway } = result;
  for (const c of gateway.cases) {
    if (c.result === 'skipped' && c.reason === FIXTURES_UNAVAILABLE) skipped.push(c.id);
    else if (c.result !== 'pass') found(`case ${c.id} ${c.result}${c.reason === undefined ? '' : `: ${c.reason}`}`);
  }
  if (gateway.crossTenantReads > 0) found(`${gateway.crossTenantReads} cross-tenant reads through the gateway`);
  if (gateway.crossTenantWrites > 0) found(`${gateway.crossTenantWrites} cross-tenant writes through the gateway`);
  if (!gateway.surveyGrantOnly) found('surveyGrantOnly is false: no survey-grant case showed responses admitted for granted sites only');
  return {
    via: result.baseUrl === undefined ? 'gateway' : `gateway ${result.baseUrl}`,
    crossTenantReads: gateway.crossTenantReads,
    crossTenantWrites: gateway.crossTenantWrites,
    surveyGrantOnly: gateway.surveyGrantOnly,
    // The gateway matrix has no fan-out case; registry-only fan-out is shown on the consumer rows.
    fanoutRegistryOnly: null,
    source: `${STATE_LABEL}/${E2E_RESULT_RELATIVE}`,
  };
}

/** Merges the package results, the end-to-end run and the catalog checks into the report; does no IO. */
export function buildIsolationReport(input: IsolationReportInput): IsolationBuild {
  const findings: IsolationFinding[] = [];
  const inputs = new Map(input.packages.map((pkgInput) => [pkgInput.pkg, pkgInput]));
  const summaries = new Map<string, PackageResultSummary>();
  const services = ISOLATION_PACKAGES.map((pkg) => {
    const pkgInput = inputs.get(pkg.pkg);
    const summary = summarisePackageResults(pkg.pkg, pkgInput?.json ?? null);
    summaries.set(pkg.service, summary);
    return serviceRow(pkg, pkgInput, summary, input.catalog, findings);
  });

  // Dead-letter topics and their replay pull subscriptions carry no event topic, so they get no consumer row.
  const consumers = input.subscriptions
    .filter((subscription) => isTopicName(subscription.topic))
    .sort((a, b) => compareText(a.subscription, b.subscription))
    .map((subscription) => consumerRow(subscription, summaries, findings));

  for (const { kind, object, detail } of input.catalog.findings) {
    findings.push({
      scope: 'catalog',
      service: serviceOfCatalogObject(object),
      detail: `${kind} ${object}${detail === undefined ? '' : `: ${detail}`}`,
    });
  }

  const endToEndSkipped: string[] = [];
  const endToEnd = endToEndOf(input.endToEnd, findings, endToEndSkipped);
  const counts = [
    ...services.flatMap((row) => [row.crossTenantReads, row.crossTenantWrites, row.pooledConnectionReuse.rowsSeen]),
    ...consumers.map((row) => row.crossTenantEffects),
    endToEnd.crossTenantReads ?? 0,
    endToEnd.crossTenantWrites ?? 0,
  ];
  const { roles } = input.catalog;
  const report: IsolationReport = {
    sourceSha: input.sha,
    generatedBy: GENERATED_BY,
    generatedAt: input.generatedAt,
    status: 'generated',
    tenants: { a: TENANT_A.siteId, b: TENANT_B.siteId, umbrella: TENANT_UMBRELLA.siteId, idRule: TENANT_ID_RULE },
    passCondition: PASS_CONDITION,
    services,
    consumers,
    roles: {
      rolbypassrls: [...roles.rolbypassrls],
      rolsuper: [...roles.rolsuper],
      membershipViolations: roles.membershipViolations.map((violation) => ({ ...violation, via: [...violation.via] })),
    },
    endToEnd,
    result: findings.length === 0 && counts.every((n) => n === 0) ? 'pass' : 'fail',
  };
  const failing = new Set(findings.map((finding) => finding.service));
  return {
    report,
    findings,
    servicesFailing: ISOLATION_PACKAGES.map(({ service }) => service).filter((service) => failing.has(service)),
    endToEndSkipped: endToEndSkipped.sort(compareText),
  };
}

/** Whether the schema of `topic` under `repoRoot` declares `x-opt2-tenant-fanout`. */
function declaresFanout(topic: string, repoRoot: string): boolean {
  return topicMeta(readTopicSchema(path.join(repoRoot, topicSchemaRelativePath(topic)))).fanout !== undefined;
}

/** The topology's push subscriptions with consumer, topic and fan-out declaration, sorted by subscription. */
export function consumerSubscriptions(
  topology: Pick<Topology, 'subscriptions'>,
  repoRoot: string = REPO_ROOT,
): ConsumerSubscription[] {
  const entries = Object.entries(topology.subscriptions);
  const fanout = new Map([...new Set(entries.map(([, entry]) => entry.topic))].map((topic) => [topic, declaresFanout(topic, repoRoot)]));
  return entries
    .map(([subscription, entry]) => ({
      subscription,
      consumer: entry.consumer,
      topic: entry.topic,
      fanout: fanout.get(entry.topic) === true,
    }))
    .sort((a, b) => compareText(a.subscription, b.subscription));
}

/** `file` as shown in the report: relative to the state directory `state`, under {@link STATE_LABEL}. */
function stateLabel(state: string, file: string): string {
  return `${STATE_LABEL}/${path.relative(state, file).split(path.sep).join('/')}`;
}

/** `readJson` of `file` with `schema`, or null when the file does not exist. */
async function readOptionalJson<T>(file: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await readJson(file, schema);
  } catch (err) {
    if (((err as Error).cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw err;
  }
}

/** Runs the catalog checks over a client of `open`, closing it afterwards. */
async function catalogChecks(env: EnvLike, open: (env: EnvLike) => Promise<CatalogClient>): Promise<CatalogRunResult> {
  const client = await open(env);
  try {
    return await runCatalogChecks(client);
  } finally {
    await client.close();
  }
}

/** Injectable inputs of {@link main}; each defaults to the real process. */
export interface IsolationDeps {
  env?: EnvLike;
  clock?: () => Date;
  pin?: () => Pin;
  /** Opens the read-only catalog client; default `createCatalogClient(env)`. */
  openCatalog?: (env: EnvLike) => Promise<CatalogClient>;
  /** Default `deriveTopology('local', REPO_ROOT)`. */
  topology?: () => Pick<Topology, 'subscriptions'>;
}

const USAGE = 'report:isolation [--help]';
const HELP = `${USAGE}

Writes the tenant-isolation report isolation.json: one row per service package with its failed cross-tenant read,
write and pooled-connection assertions and its RLS catalog counts; one row per event-consumer subscription; the
privileged service roles; and the end-to-end gateway matrix figures.

Reads, under \${OPT2_STATE_DIR}:
  test-all/vitest/<pkg-slug>.json  vitest JSON of each services/<svc> package (harness/repro/test-all.sh stage 3)
  ${E2E_RESULT_RELATIVE}      the gateway matrix run written by harness/e2e/isolation
plus the PostgreSQL catalog as PG_USER (read-only) and the local Pub/Sub topology derived from the contracts.
Writes to OPT2_REPORTS_DIR (default opt2/reports).

Output: one JSON summary line on stdout listing every finding. Exit: 0 every count zero and no finding, 1 otherwise
or on a failure, 2 usage error.`;

/** CLI entry: reads every input, builds the report and writes it; exits 0 only on a pass. */
export async function main(argv: string[], deps: IsolationDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE, help: HELP });
  const env = deps.env ?? process.env;
  const pin = (deps.pin ?? readPin)();
  const state = stateDir(env);
  const packages: PackageResultInput[] = [];
  for (const pkg of ISOLATION_PACKAGES) {
    const file = vitestResultPath(pkg.pkg, env);
    packages.push({ ...pkg, path: stateLabel(state, file), json: await readOptionalJson(file, vitestJsonSchema) });
  }
  const endToEnd = await readOptionalJson(e2eIsolationResultPath(env), endToEndResultSchema);
  const catalog = await catalogChecks(env, deps.openCatalog ?? ((catalogEnv) => createCatalogClient(catalogEnv)));
  const subscriptions = consumerSubscriptions((deps.topology ?? (() => deriveTopology('local', REPO_ROOT)))());

  const built = buildIsolationReport({
    sha: pin.sha,
    generatedAt: (deps.clock ?? (() => new Date()))().toISOString(),
    packages,
    endToEnd,
    catalog,
    subscriptions,
  });
  const written = await writeJsonReport(path.join(reportsDir(env), REPORT_FILE), built.report, {
    generatedBy: GENERATED_BY,
    pin: () => pin,
  });
  const { result, endToEnd: endToEndRow } = built.report;
  return {
    code: result === 'pass' ? 0 : 1,
    summary: {
      written: written.path,
      result,
      findings: built.findings.length,
      findingDetails: built.findings.map((finding) => `${finding.scope}: ${finding.detail}`),
      endToEnd: endToEndRow,
      endToEndSkipped: built.endToEndSkipped,
      servicesFailing: built.servicesFailing,
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);

