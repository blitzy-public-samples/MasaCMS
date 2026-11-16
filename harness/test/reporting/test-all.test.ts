import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIXTURES_UNAVAILABLE } from '../../src/golden/catalogue.js';
import { ROLE_SUFFIXES, SERVICE_SCHEMAS, type RoleFindings } from '../../src/isolation/catalog.js';
import type { ConsumerIsolationRow, IsolationReport, ServiceIsolationRow } from '../../src/isolation/report.js';
import { runCli } from '../../src/lib/cli.js';
import { REPO_ROOT } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import { TEN_SERVICES, type ServiceName } from '../../src/reporting/check-reviewability.js';
import { vitestResultPath } from '../../src/reporting/speed.js';
import {
  BASELINE_UNMET_ITEM,
  CLOUD_PATHS_UNTESTED,
  CLOUD_PATHS_UNTESTED_STATEMENT,
  FIXTURE_UNMET_ITEMS,
  GENERATED_BY,
  LAST_STAGE,
  SERVICE_ROLE_SUFFIXES,
  STAGE_NAMES,
  buildServiceMatrix,
  buildTestAllReport,
  deriveExitCode,
  displayPath,
  formatDuration,
  isolationInputSchema,
  main,
  packageKey,
  readTestAllInputs,
  renderTestAllMarkdown,
  resolveStages,
  stageRecordPath,
  type IsolationInput,
  type MatrixInputs,
  type ParityInput,
  type Source,
  type StageRecord,
  type StageResult,
  type TestAllInputs,
  type VitestInput,
} from '../../src/reporting/test-all.js';

const SHA = readPin().sha;
const AT = '2026-06-30T10:00:00.000Z';
const CATEGORIES = ['contract', 'isolation', 'events', 'security'] as const;

function record(stage: number, result: StageResult = 'pass', extra: Partial<StageRecord> = {}): StageRecord {
  return {
    stage,
    name: STAGE_NAMES[stage] ?? '',
    result,
    startedAt: AT,
    finishedAt: AT,
    durationMs: 1000,
    evidence: [`evidence-${stage}`],
    ...extra,
  };
}

function vitestFor(service: string, statuses: Partial<Record<(typeof CATEGORIES)[number], readonly string[]>> = {}): VitestInput {
  return {
    testResults: CATEGORIES.map((category) => {
      const tests = statuses[category] ?? ['passed'];
      return {
        name: `/repo/services/${service}/test/${category}/${category}.test.ts`,
        status: tests.includes('failed') ? 'failed' : 'passed',
        assertionResults: tests.map((status) => ({ status })),
      };
    }),
  };
}

function vitestSources(build: (service: ServiceName) => VitestInput | null): Record<ServiceName, Source<VitestInput>> {
  return Object.fromEntries(
    TEN_SERVICES.map((service) => [service, { path: `vitest/${service}.json`, data: build(service) }]),
  ) as Record<ServiceName, Source<VitestInput>>;
}

/** Inputs of a run where every stage, cell and fixture check passes. */
function passingInputs(): TestAllInputs {
  return {
    records: STAGE_NAMES.map((_, n) => record(n)),
    parity: {
      path: 'opt2/reports/parity.json',
      data: {
        status: 'complete',
        scenarios: TEN_SERVICES.map((service, i) => ({ id: `GS-${i}`, service, result: 'pass' as const })),
        unmetWithheld: [],
      },
    },
    vitest: vitestSources((service) => vitestFor(service)),
    isolation: {
      path: 'opt2/reports/isolation.json',
      data: {
        status: 'generated',
        services: TEN_SERVICES.map((service) => ({ service, crossTenantReads: 0, crossTenantWrites: 0 })),
      },
    },
    events: {
      path: 'opt2/reports/events.json',
      data: { status: 'generated', result: 'pass', topics: [{ producer: 'people', consumers: ['timesheets'] }] },
    },
    security: { path: '${OPT2_STATE_DIR}/security/summary.json', data: { verdict: 'clean', exitCode: 0 } },
    fixtures: { available: true, reason: null },
    generatedAt: AT,
    evidence: {
      fixtures: '${OPT2_STATE_DIR}/fixtures.json',
      rollback: 'opt2/reports/rollback-rehearsal.md',
      baseline: 'opt2/reports/baseline.json',
    },
  };
}

function matrixInputs(overrides: Partial<MatrixInputs> = {}): MatrixInputs {
  return { ...passingInputs(), packages: [], ...overrides };
}

function row(matrix: ReturnType<typeof buildServiceMatrix>, service: ServiceName) {
  const found = matrix.find((entry) => entry.service === service);
  if (found === undefined) throw new Error(`no row for ${service}`);
  return found;
}

type WrittenIsolation = Pick<IsolationReport, 'status' | 'services' | 'consumers' | 'roles' | 'result'>;

const IDENTITY_CONSUMER = 'identity.programs-sites.site.changed.v1';
const COMMUNICATIONS_CONSUMER = 'communications.identity.login-mail.requested.v1';
const ISOLATION_PASS = { state: 'pass', reason: '1 isolation files, 1 of 1 tests passed; iso.json: no cross-tenant reads or writes' };

/** A clean isolation.json body in the shape harness/src/isolation/report.ts writes. */
function writtenIsolation(): WrittenIsolation {
  return {
    status: 'generated',
    services: SERVICE_SCHEMAS.map(({ service, schema }) => ({
      service,
      schema,
      crossTenantReads: 0,
      crossTenantWrites: 0,
      pooledConnectionReuse: { rowsSeen: 0, writeBlocked: true },
      rlsCatalog: { tables: 4, enabled: 4, forced: 4, usingAndWithCheck: 4 },
      source: `\${OPT2_STATE_DIR}/test-all/vitest/services-${service}.json`,
    })),
    consumers: [
      { subscription: COMMUNICATIONS_CONSUMER, tenantlessRejected: true, fanoutRegistryOnly: null, crossTenantEffects: 0 },
      { subscription: IDENTITY_CONSUMER, tenantlessRejected: true, fanoutRegistryOnly: true, crossTenantEffects: 0 },
    ],
    roles: { rolbypassrls: [], rolsuper: [], membershipViolations: [] },
    result: 'pass',
  };
}

/** Role findings with nothing privileged except `patch`. */
function rolesWith(patch: Partial<RoleFindings>): RoleFindings {
  return { rolbypassrls: [], rolsuper: [], membershipViolations: [], ...patch };
}

/** The clean consumer rows with `patch` applied to `subscription`. */
function consumersWith(patch: Partial<ConsumerIsolationRow>, subscription = IDENTITY_CONSUMER): ConsumerIsolationRow[] {
  return writtenIsolation().consumers.map((entry) => (entry.subscription === subscription ? { ...entry, ...patch } : entry));
}

/** The clean report parsed by the reader's schema, with identity's row and top-level fields patched. */
function isolationWith(identity: Partial<ServiceIsolationRow> = {}, top: Partial<WrittenIsolation> = {}): Source<IsolationInput> {
  const body = writtenIsolation();
  const services = body.services.map((entry) => (entry.service === 'identity' ? { ...entry, ...identity } : entry));
  return { path: 'iso.json', data: isolationInputSchema.parse({ ...body, services, ...top }) };
}

describe('resolveStages', () => {
  it('names every stage and keeps recorded results', () => {
    const stages = resolveStages(STAGE_NAMES.map((_, n) => record(n)));
    expect(stages.map((stage) => stage.name)).toEqual([...STAGE_NAMES]);
    expect(stages.every((stage) => stage.result === 'pass' && stage.durationMs === 1000)).toBe(true);
  });

  it('marks missing records after a failure not-run, and a missing record before any failure fail', () => {
    const records: (StageRecord | null)[] = [record(0), null, record(2, 'fail', { reason: 'boom' }), null];
    const stages = resolveStages(records);
    expect(stages[1]).toMatchObject({ result: 'fail', reason: 'stage record missing', durationMs: null, evidence: [] });
    expect(stages[2]).toMatchObject({ result: 'fail', reason: 'boom' });
    expect(stages.slice(3).every((stage) => stage.result === 'not-run' && stage.reason === 'stage 1 failed')).toBe(true);
    expect(stages).toHaveLength(LAST_STAGE + 1);
  });
});

describe('buildTestAllReport and deriveExitCode', () => {
  it('reports exit code 0 when every stage, cell and fixture check passes', () => {
    const report = buildTestAllReport(passingInputs());
    expect(report).toMatchObject({ exitCode: 0, result: 'pass', status: 'generated', generatedBy: GENERATED_BY, unmet: [] });
    expect(report.fixtures).toEqual({ available: true, reason: null, source: '${OPT2_STATE_DIR}/fixtures.json' });
    expect(report.cloudPathsUntested).toBe(CLOUD_PATHS_UNTESTED_STATEMENT);
    expect(report.serviceMatrix.map((entry) => entry.service)).toEqual([...TEN_SERVICES]);
  });

  it('reports exit code 2 for withheld parity only, one item per scenario citing its decision-list entries', () => {
    const inputs = passingInputs();
    const refs = ['opt2/decision-list.json#actionVariants/a', 'opt2/decision-list.json#actionVariants/b'];
    inputs.parity.data = {
      status: 'complete',
      scenarios: TEN_SERVICES.map((service, i) =>
        i === 0
          ? { id: 'GS-ID-05', service, result: 'withheld' as const, decisionListRef: refs }
          : { id: `GS-${i}`, service, result: 'excepted' as const },
      ),
      unmetWithheld: refs.map((ref) => ({ id: 'GS-ID-05', decisionListRef: ref, proposal: 'people owns the delete' })),
    };
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(2);
    expect(report.result).toBe('unmet');
    expect(report.serviceMatrix[0]?.parity).toEqual({ state: 'unmet', reason: `withheld: GS-ID-05 (${refs.join(', ')})` });
    expect(report.unmet.map((item) => item.item)).toEqual(['Parity: GS-ID-05 withheld', 'Done: ten services: identity parity']);
    expect(report.unmet[0]?.evidence).toEqual(['opt2/reports/parity.json', ...refs]);
    expect(report.unmet[0]?.reason).toContain('proposal: people owns the delete');
  });

  it('reports exit code 2 with both fixture items when the fixtures are unavailable', () => {
    const inputs = passingInputs();
    inputs.fixtures = { available: false, reason: 'CREATE SCHEMA denied' };
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(2);
    expect(report.unmet.map((item) => item.item)).toEqual([...FIXTURE_UNMET_ITEMS]);
    expect(report.unmet[0]?.reason).toContain('CREATE SCHEMA denied');
    expect(report.unmet[1]?.evidence).toContain('opt2/reports/rollback-rehearsal.md');
  });

  it('reports exit code 1 for a failed stage, with later missing stages not-run', () => {
    const inputs = passingInputs();
    inputs.records = [record(0), record(1), record(2), record(3), record(4, 'fail')];
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(1);
    expect(report.result).toBe('fail');
    expect(report.stages.slice(5).map((stage) => stage.result)).toEqual(Array(LAST_STAGE - 4).fill('not-run'));
    expect(report.unmet).toEqual([]);
  });

  it('reports exit code 1 for a missing stage record without an earlier failure', () => {
    const inputs = passingInputs();
    inputs.records = inputs.records.map((entry, n) => (n === 6 ? null : entry));
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(1);
    expect(report.stages[6]).toMatchObject({ result: 'fail', reason: 'stage record missing' });
    expect(report.stages[7]?.result).toBe('pass');
  });

  it('keeps running after a timing-variance baseline and reports it unmet with the baseline evidence', () => {
    const inputs = passingInputs();
    inputs.records = inputs.records.map((entry, n) => (n === 1 ? record(1, 'timing-variance', { evidence: [] }) : entry));
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(2);
    expect(report.unmet).toEqual([
      { item: BASELINE_UNMET_ITEM, reason: expect.stringContaining('timing-variance'), evidence: ['opt2/reports/baseline.json'] },
    ]);
  });

  it.each([
    ['unmet', undefined, 'unmet'],
    ['skipped', 'fixtures unavailable', 'skipped: fixtures unavailable'],
    ['not-run', undefined, 'not-run'],
  ] as const)('lists a %s stage without own items as one unmet item', (result, reason, expected) => {
    const inputs = passingInputs();
    inputs.records = inputs.records.map((entry, n) => (n === 8 ? record(8, result, reason === undefined ? {} : { reason }) : entry));
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(2);
    expect(report.unmet).toEqual([{ item: `Stage 8: ${STAGE_NAMES[8]}`, reason: expected, evidence: ['evidence-8'] }]);
  });

  it("lists a stage's own unmet items instead of the stage, merging evidence of repeated items", () => {
    const inputs = passingInputs();
    const unmet = [
      { item: 'rollback seam leg', reason: 'archive skipped' },
      { item: 'rollback seam leg', reason: 'again' },
    ];
    inputs.records = inputs.records.map((entry, n) => (n === 8 ? record(8, 'unmet', { unmet }) : entry));
    const report = buildTestAllReport(inputs);
    expect(report.unmet).toEqual([{ item: 'rollback seam leg', reason: 'archive skipped', evidence: ['evidence-8'] }]);
  });

  it('derives the exit code from stages, matrix cells and unmet items alone', () => {
    const matrix = buildServiceMatrix(matrixInputs());
    const failingMatrix = buildServiceMatrix(matrixInputs({ security: { path: 's', data: { verdict: 'findings', exitCode: 1 } } }));
    const stages = resolveStages(STAGE_NAMES.map((_, n) => record(n)));
    expect(deriveExitCode(stages, matrix, [])).toBe(0);
    expect(deriveExitCode(stages, matrix, [{ item: 'x', reason: 'y', evidence: [] }])).toBe(2);
    expect(deriveExitCode(stages, failingMatrix, [{ item: 'x', reason: 'y', evidence: [] }])).toBe(1);
    expect(deriveExitCode([...stages, { result: 'fail' }], matrix, [])).toBe(1);
  });
});

describe('buildServiceMatrix', () => {
  it.each([
    ['a failed file', { contract: ['passed', 'failed'] }, 'fail', '1 of 1 contract files failed: test/contract/contract.test.ts'],
    ['only skipped tests', { contract: ['skipped', 'skipped'] }, 'unmet', 'every contract test skipped (2 tests in 1 files)'],
    ['passing tests', { contract: ['passed', 'skipped'] }, 'pass', '1 contract files, 1 of 2 tests passed'],
  ] as const)('reads the contract cell from vitest JSON with %s', (_, statuses, state, reason) => {
    const matrix = buildServiceMatrix(matrixInputs({ vitest: vitestSources((service) => vitestFor(service, statuses)) }));
    expect(row(matrix, 'people').contract).toEqual({ state, reason });
  });

  it('marks a category without suites unmet and an absent vitest result pending-run', () => {
    const vitest = vitestSources((service) => (service === 'finance' ? null : { testResults: [] }));
    const matrix = buildServiceMatrix(matrixInputs({ vitest }));
    expect(row(matrix, 'people').events).toEqual({ state: 'unmet', reason: 'no events suites' });
    expect(row(matrix, 'finance').security).toEqual({ state: 'pending-run', reason: 'vitest JSON vitest/finance.json absent' });
  });

  it('turns pending-run cells of a package whose npm test failed into fail, leaving other cells', () => {
    const vitest = vitestSources((service) => (service === 'finance' ? null : vitestFor(service)));
    const matrix = buildServiceMatrix(
      matrixInputs({ vitest, packages: [{ package: './services/finance/', exitCode: 3 }, { package: 'services/people', exitCode: 0 }] }),
    );
    expect(row(matrix, 'finance').contract).toEqual({
      state: 'fail',
      reason: 'services/finance npm test exited 3; vitest JSON vitest/finance.json absent',
    });
    expect(row(matrix, 'finance').parity.state).toBe('pass');
    expect(row(matrix, 'people').contract.state).toBe('pass');
  });

  it('applies fail > unmet > pending-run > pass when sources disagree', () => {
    const isolation: Source<NonNullable<MatrixInputs['isolation']['data']>> = {
      path: 'iso.json',
      data: {
        status: 'generated',
        services: [
          { service: 'identity', crossTenantReads: 1, crossTenantWrites: 0 },
          { service: 'people', crossTenantReads: 0, crossTenantWrites: 0, result: 'fail' },
        ],
      },
    };
    const vitest = vitestSources((service) => vitestFor(service, service === 'identity' ? { isolation: ['skipped'] } : {}));
    const matrix = buildServiceMatrix(matrixInputs({ isolation, vitest }));
    expect(row(matrix, 'identity').isolation).toEqual({
      state: 'fail',
      reason: 'iso.json: 1 cross-tenant reads, 0 cross-tenant writes, result unset',
    });
    expect(row(matrix, 'people').isolation.state).toBe('fail');
    expect(row(matrix, 'finance').isolation).toEqual({ state: 'pending-run', reason: 'no finance entry in iso.json' });
  });

  it('passes the isolation cell of every service for a clean report in the shape report.ts writes', () => {
    const matrix = buildServiceMatrix(matrixInputs({ isolation: isolationWith() }));
    for (const entry of matrix) expect(entry.isolation).toEqual(ISOLATION_PASS);
  });

  it.each<[string, Partial<ServiceIsolationRow>, Partial<WrittenIsolation>, string]>([
    ['pooled-connection reuse that sees rows', { pooledConnectionReuse: { rowsSeen: 2, writeBlocked: true } }, {}, 'pooledConnectionReuse.rowsSeen 2'],
    ['pooled-connection reuse that can write', { pooledConnectionReuse: { rowsSeen: 0, writeBlocked: false } }, {}, 'pooledConnectionReuse.writeBlocked false'],
    ['a schema without tenant tables', { rlsCatalog: { tables: 0, enabled: 0, forced: 0, usingAndWithCheck: 0 } }, {}, 'rlsCatalog.tables 0'],
    ['RLS not enabled on every tenant table', { rlsCatalog: { tables: 4, enabled: 3, forced: 4, usingAndWithCheck: 4 } }, {}, 'rlsCatalog.enabled 3 of 4 tables'],
    ['RLS not forced on every tenant table', { rlsCatalog: { tables: 4, enabled: 4, forced: 3, usingAndWithCheck: 4 } }, {}, 'rlsCatalog.forced 3 of 4 tables'],
    ['a tenant table without USING and WITH CHECK', { rlsCatalog: { tables: 4, enabled: 4, forced: 4, usingAndWithCheck: 2 } }, {}, 'rlsCatalog.usingAndWithCheck 2 of 4 tables'],
    ['a service role with rolbypassrls', {}, { roles: rolesWith({ rolbypassrls: ['identity_app'] }) }, 'role identity_app in roles.rolbypassrls'],
    ['a service role with rolsuper', {}, { roles: rolesWith({ rolsuper: ['identity_owner'] }) }, 'role identity_owner in roles.rolsuper'],
    [
      'a service role inside a privileged role through another',
      {},
      { roles: rolesWith({ membershipViolations: [{ member: 'identity_migrator', ancestor: 'cloudsqlsuperuser', via: ['identity_owner'] }] }) },
      'role identity_migrator in roles.membershipViolations (member of cloudsqlsuperuser via identity_owner)',
    ],
    [
      'a service role directly inside a privileged role',
      {},
      { roles: rolesWith({ membershipViolations: [{ member: 'identity_app', ancestor: 'postgres', via: [] }] }) },
      'role identity_app in roles.membershipViolations (member of postgres)',
    ],
    ['a consumer with cross-tenant effects', {}, { consumers: consumersWith({ crossTenantEffects: 1 }) }, `consumer ${IDENTITY_CONSUMER} crossTenantEffects 1`],
    ['a consumer that accepts tenantless events', {}, { consumers: consumersWith({ tenantlessRejected: false }) }, `consumer ${IDENTITY_CONSUMER} tenantlessRejected false`],
    ['a consumer that fans out beyond the registry', {}, { consumers: consumersWith({ fanoutRegistryOnly: false }) }, `consumer ${IDENTITY_CONSUMER} fanoutRegistryOnly false`],
  ])('fails the isolation cell for %s, naming the fact and leaving other services green', (_, identity, top, fact) => {
    const matrix = buildServiceMatrix(matrixInputs({ isolation: isolationWith(identity, top) }));
    expect(row(matrix, 'identity').isolation).toEqual({ state: 'fail', reason: `iso.json: ${fact}` });
    expect(row(matrix, 'people').isolation).toEqual(ISOLATION_PASS);
  });

  it('names every failing fact of a service in one fail reason', () => {
    const isolation = isolationWith(
      { crossTenantWrites: 2, rlsCatalog: { tables: 4, enabled: 4, forced: 3, usingAndWithCheck: 3 } },
      { roles: rolesWith({ rolbypassrls: ['identity_app'] }), consumers: consumersWith({ tenantlessRejected: false }) },
    );
    expect(row(buildServiceMatrix(matrixInputs({ isolation })), 'identity').isolation).toEqual({
      state: 'fail',
      reason:
        'iso.json: 0 cross-tenant reads, 2 cross-tenant writes, result unset; rlsCatalog.forced 3 of 4 tables; ' +
        'rlsCatalog.usingAndWithCheck 3 of 4 tables; role identity_app in roles.rolbypassrls; ' +
        `consumer ${IDENTITY_CONSUMER} tenantlessRejected false`,
    });
  });

  it('attributes roles by the row schema and consumers by their subscription prefix', () => {
    const isolation = isolationWith(
      {},
      {
        roles: rolesWith({ rolsuper: ['content_owner'], rolbypassrls: ['people_app'] }),
        consumers: consumersWith({ tenantlessRejected: false }, COMMUNICATIONS_CONSUMER),
      },
    );
    const matrix = buildServiceMatrix(matrixInputs({ isolation }));
    expect(row(matrix, 'strategies-content').isolation).toEqual({ state: 'fail', reason: 'iso.json: role content_owner in roles.rolsuper' });
    expect(row(matrix, 'people').isolation).toEqual({ state: 'fail', reason: 'iso.json: role people_app in roles.rolbypassrls' });
    expect(row(matrix, 'communications').isolation).toEqual({
      state: 'fail',
      reason: `iso.json: consumer ${COMMUNICATIONS_CONSUMER} tenantlessRejected false`,
    });
    expect(row(matrix, 'identity').isolation).toEqual(ISOLATION_PASS);
  });

  it('reads a row whose vitest results were not shown as pending-run unless a figure fails it', () => {
    const pending = buildServiceMatrix(matrixInputs({ isolation: isolationWith({ source: null }) }));
    expect(row(pending, 'identity').isolation).toEqual({
      state: 'pending-run',
      reason: 'iso.json: identity source null; no vitest results were shown',
    });
    const unblocked = isolationWith({ source: null, pooledConnectionReuse: { rowsSeen: 0, writeBlocked: false } });
    expect(row(buildServiceMatrix(matrixInputs({ isolation: unblocked })), 'identity').isolation).toEqual({
      state: 'fail',
      reason: 'iso.json: pooledConnectionReuse.writeBlocked false',
    });
  });

  it('parses the pending-run placeholder and never fails a figure that is still null', async () => {
    const committed: unknown = JSON.parse(await readFile(path.join(REPO_ROOT, 'opt2', 'reports', 'isolation.json'), 'utf8'));
    expect(isolationInputSchema.safeParse(committed).success).toBe(true);
    const placeholder = isolationInputSchema.parse({
      status: 'pending-run',
      services: TEN_SERVICES.map((service) => ({
        service,
        schema: service,
        crossTenantReads: null,
        crossTenantWrites: null,
        pooledConnectionReuse: { rowsSeen: null, writeBlocked: null },
        rlsCatalog: { tables: null, enabled: null, forced: null, usingAndWithCheck: null },
        source: `services/${service}/test/isolation/`,
      })),
      consumers: null,
      roles: { rolbypassrls: null, rolsuper: null, membershipViolations: null },
      result: 'pending-run',
    });
    const pending = buildServiceMatrix(matrixInputs({ isolation: { path: 'iso.json', data: placeholder } }));
    expect(row(pending, 'identity').isolation).toEqual({ state: 'pending-run', reason: 'iso.json is the pending-run placeholder' });
    const unmeasured = buildServiceMatrix(matrixInputs({ isolation: { path: 'iso.json', data: { ...placeholder, status: 'generated' } } }));
    for (const entry of unmeasured) expect(entry.isolation).toEqual(ISOLATION_PASS);
  });

  it.each<[string, ParityInput | null, string]>([
    ['absent', null, 'p.json absent'],
    ['the placeholder', { status: 'pending-run', scenarios: [], unmetWithheld: [] }, 'p.json is the pending-run placeholder'],
    ['without the service', { status: 'complete', scenarios: [], unmetWithheld: [] }, 'no parity scenarios for people in p.json'],
  ])('reads parity as pending-run when parity.json is %s', (_, data, reason) => {
    const matrix = buildServiceMatrix(matrixInputs({ parity: { path: 'p.json', data } }));
    expect(row(matrix, 'people').parity).toEqual({ state: 'pending-run', reason });
  });

  it('reads parity fail, skipped-for-fixtures unmet, and counted passes', () => {
    const parity: MatrixInputs['parity'] = {
      path: 'p.json',
      data: {
        status: 'complete',
        scenarios: [
          { id: 'GS-PE-01', service: 'people', result: 'fail' },
          { id: 'GS-PE-02', service: 'people', result: 'withheld' },
          { id: 'GS-FI-01', service: 'finance', result: FIXTURES_UNAVAILABLE },
          { id: 'GS-ID-01', service: 'identity', result: 'pass' },
          { id: 'GS-ID-02', service: 'identity', result: 'known-issue' },
          { id: 'GS-ID-03', service: 'identity', result: 'halted' },
        ],
        unmetWithheld: [],
      },
    };
    const matrix = buildServiceMatrix(matrixInputs({ parity }));
    expect(row(matrix, 'people').parity).toEqual({ state: 'fail', reason: 'parity failed: GS-PE-01' });
    expect(row(matrix, 'finance').parity).toEqual({ state: 'unmet', reason: `${FIXTURES_UNAVAILABLE}: GS-FI-01` });
    expect(row(matrix, 'identity').parity).toEqual({ state: 'pass', reason: '3 scenarios: 1 pass, 1 halted, 1 known-issue' });
  });

  it('fails the events cell only of services named by a failed events report', () => {
    const events: MatrixInputs['events'] = {
      path: 'e.json',
      data: { status: 'generated', result: 'fail', topics: [{ producer: 'people', consumers: ['timesheets'] }] },
    };
    const matrix = buildServiceMatrix(matrixInputs({ events }));
    expect(row(matrix, 'people').events.state).toBe('fail');
    expect(row(matrix, 'timesheets').events.state).toBe('fail');
    expect(row(matrix, 'finance').events).toEqual({ state: 'pass', reason: '1 events files, 1 of 1 tests passed; e.json result fail; finance produces and consumes no topic' });
    const unset = buildServiceMatrix(matrixInputs({ events: { path: 'e.json', data: { status: 'generated', topics: [] } } }));
    expect(row(unset, 'finance').events).toEqual({ state: 'pending-run', reason: 'e.json result unset' });
  });

  it.each([
    [{ verdict: 'findings', exitCode: 1 }, 'fail', 's.json verdict findings, exit code 1'],
    [{ verdict: 'error', exitCode: 2, error: 'gitleaks: tool missing' }, 'fail', 's.json verdict error, exit code 2: gitleaks: tool missing'],
    [{}, 'fail', 's.json verdict unset, exit code unset'],
    [null, 'pending-run', 's.json absent'],
  ] as const)('reads the security summary %j into every service', (data, state, reason) => {
    const matrix = buildServiceMatrix(matrixInputs({ security: { path: 's.json', data } }));
    for (const entry of matrix) expect(entry.security).toEqual({ state, reason });
  });

  it('lists pending-run cells as unmet items so a run never exits 0 with a cell not green', () => {
    const inputs = passingInputs();
    inputs.events = { path: 'opt2/reports/events.json', data: { status: 'pending-run', topics: [] } };
    const report = buildTestAllReport(inputs);
    expect(report.exitCode).toBe(2);
    expect(report.unmet).toHaveLength(TEN_SERVICES.length);
    expect(report.unmet[0]).toEqual({
      item: 'Done: ten services: identity events',
      reason: 'pending-run: opt2/reports/events.json is the pending-run placeholder',
      evidence: ['vitest/identity.json', 'opt2/reports/events.json'],
    });
  });
});

describe('helpers', () => {
  it.each([
    [null, '—'],
    [850, '850 ms'],
    [12_400, '12.4 s'],
    [185_000, '3 min 05 s'],
  ] as const)('formats %s ms as %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it.each([
    ['services/identity', 'services/identity'],
    ['./services/identity/', 'services/identity'],
    ['services\\identity', 'services/identity'],
  ])('normalises package %s', (dir, key) => {
    expect(packageKey(dir)).toBe(key);
  });

  it('names the same service role suffixes as the catalog checks', () => {
    expect(SERVICE_ROLE_SUFFIXES).toEqual(ROLE_SUFFIXES);
  });

  it('rejects a stage outside 0–9', () => {
    expect(() => stageRecordPath(LAST_STAGE + 1, { OPT2_STATE_DIR: os.tmpdir() })).toThrow(RangeError);
  });

  it('shows paths relative to the checkout or the state directory', () => {
    const env = { OPT2_STATE_DIR: path.join(os.tmpdir(), 'opt2-test-all-state') };
    expect(displayPath('relative/x', env)).toBe('relative/x');
    expect(displayPath(path.join(REPO_ROOT, 'opt2', 'reports', 'a.json'), env)).toBe('opt2/reports/a.json');
    expect(displayPath(path.join(env.OPT2_STATE_DIR, 'test-all', 'stage-1.json'), env)).toBe('${OPT2_STATE_DIR}/test-all/stage-1.json');
    expect(displayPath(path.join(os.tmpdir(), 'elsewhere.json'), env)).toBe(path.join(os.tmpdir(), 'elsewhere.json'));
  });

  it('renders the fixture sentence, escaped cells and the cloud-path statement', () => {
    const inputs = passingInputs();
    inputs.fixtures = { available: null, reason: 'fixtures.json missing' };
    inputs.records = inputs.records.map((entry, n) => (n === 2 ? record(2, 'pass', { evidence: ['a|b'] }) : entry));
    const lines = renderTestAllMarkdown(buildTestAllReport(inputs));
    expect(lines).toContain('Fixtures: unknown: fixtures.json missing (from `${OPT2_STATE_DIR}/fixtures.json`)');
    expect(lines.some((line) => line.startsWith('With fixtures unavailable, parity covers four of ten services'))).toBe(true);
    expect(lines).toContain(`| 2 | ${STAGE_NAMES[2]} | pass | 1.0 s | \`a\\|b\` |`);
    expect(lines.at(-1)).toBe(`${CLOUD_PATHS_UNTESTED_STATEMENT}.`);
    for (const pathName of CLOUD_PATHS_UNTESTED) expect(CLOUD_PATHS_UNTESTED_STATEMENT).toContain(pathName);
    const available = renderTestAllMarkdown(buildTestAllReport({ ...passingInputs(), fixtures: { available: true, reason: 'ok' } }));
    expect(available).toContain('Fixtures: available (ok) (from `${OPT2_STATE_DIR}/fixtures.json`)');
    expect(available).toContain('None.');
  });
});

describe('main', () => {
  let root: string;
  let env: Record<string, string>;
  const run = (argv: string[], clock?: () => Date) => main(argv, { env, ...(clock === undefined ? {} : { clock }) });

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'opt2-test-all-'));
    env = { OPT2_STATE_DIR: path.join(root, 'state'), OPT2_REPORTS_DIR: path.join(root, 'reports') };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const recordArgs = (stage: number, ...extra: string[]) => [
    'record',
    '--stage',
    String(stage),
    '--result',
    'pass',
    '--started-at',
    '2026-06-30T10:00:00Z',
    '--finished-at',
    '2026-06-30T10:00:01.500+00:00',
    ...extra,
  ];

  it('records a stage with stable JSON and state- or repository-relative evidence', async () => {
    const outcome = await run(
      recordArgs(
        3,
        '--exit-code',
        '0',
        '--evidence',
        path.join(env.OPT2_STATE_DIR ?? '', 'test-all', 'vitest', 'services-people.json'),
        '--evidence',
        'opt2/reports/parity.json',
        '--reason',
        'note',
        '--unmet',
        'item=reason=with equals',
        '--package',
        'services/people=4',
      ),
    );
    expect(outcome).toEqual({
      summary: { stage: 3, result: 'pass', durationMs: 1500, path: '${OPT2_STATE_DIR}/test-all/stage-3.json' },
    });
    const text = await readFile(stageRecordPath(3, env), 'utf8');
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      stage: 3,
      name: STAGE_NAMES[3],
      result: 'pass',
      startedAt: '2026-06-30T10:00:00Z',
      finishedAt: '2026-06-30T10:00:01.500+00:00',
      durationMs: 1500,
      exitCode: 0,
      evidence: ['${OPT2_STATE_DIR}/test-all/vitest/services-people.json', 'opt2/reports/parity.json'],
      reason: 'note',
      unmet: [{ item: 'item', reason: 'reason=with equals' }],
      packages: [{ package: 'services/people', exitCode: 4 }],
    });
  });

  it('removes the records of an earlier run when stage 0 is recorded', async () => {
    await run(recordArgs(5));
    expect(existsSync(stageRecordPath(5, env))).toBe(true);
    await run(recordArgs(0));
    expect(existsSync(stageRecordPath(5, env))).toBe(false);
    expect(existsSync(stageRecordPath(0, env))).toBe(true);
  });

  it.each([
    [['record', '--result', 'pass'], '--stage is required'],
    [recordArgs(1).filter((arg) => arg !== '--finished-at' && !arg.startsWith('2026-06-30T10:00:01')), '--finished-at is required'],
    [recordArgs(1).map((arg) => (arg === '1' ? 'one' : arg)), '--stage one: not a non-negative integer'],
    [recordArgs(1).map((arg) => (arg === 'pass' ? 'green' : arg)), 'result'],
    [recordArgs(1).map((arg) => (arg === '2026-06-30T10:00:00Z' ? '2026-06-30T11:00:00Z' : arg)), 'precedes --started-at'],
    [recordArgs(1, '--unmet', 'no-separator'), '--unmet no-separator: expected <name>=<value>'],
    [recordArgs(1, '--package', 'services/people='), 'expected <name>=<value>'],
    [recordArgs(LAST_STAGE + 1), 'stage'],
    [['record', '--bogus'], 'bogus'],
  ])('rejects record arguments %j', async (argv, message) => {
    await expect(run(argv)).rejects.toThrow(message);
  });

  it('assembles both report files and returns the report exit code only with --exit-code', async () => {
    const clock = () => new Date(AT);
    const outcome = await run(['assemble', '--exit-code'], clock);
    expect(outcome.code).toBe(1);
    expect(outcome.summary).toMatchObject({ exitCode: 1, result: 'fail', written: true, failingStages: [0] });
    const json = JSON.parse(await readFile(path.join(root, 'reports', 'test-all.json'), 'utf8')) as Record<string, unknown>;
    expect(json).toMatchObject({ sourceSha: SHA, generatedBy: GENERATED_BY, generatedAt: AT, status: 'generated', exitCode: 1 });
    expect(json.fixtures).toEqual({ available: null, reason: 'fixtures.json missing', source: '${OPT2_STATE_DIR}/fixtures.json' });
    const md = await readFile(path.join(root, 'reports', 'test-all.md'), 'utf8');
    expect(md.split('\n').slice(0, 2)).toEqual(['# Test-all report', `Source SHA: ${SHA}`]);

    const plain = await run([], clock);
    expect(plain.code).toBe(0);
  });

  it('writes nothing with --no-write and reads every stage input from the state and reports directories', async () => {
    const state = env.OPT2_STATE_DIR ?? '';
    for (let n = 0; n <= LAST_STAGE; n += 1) await run(recordArgs(n));
    await mkdir(path.join(state, 'security'), { recursive: true });
    await writeFile(path.join(state, 'security', 'summary.json'), JSON.stringify({ verdict: 'clean', exitCode: 0, extra: 1 }));
    await writeFile(path.join(state, 'fixtures.json'), JSON.stringify({ available: true, reason: null, checkedAt: AT }));
    const vitest = vitestResultPath('services/identity', env);
    await mkdir(path.dirname(vitest), { recursive: true });
    await writeFile(vitest, JSON.stringify(vitestFor('identity')));

    const inputs = await readTestAllInputs(env, AT);
    expect(inputs.records.every((entry) => entry?.result === 'pass')).toBe(true);
    expect(inputs.fixtures).toEqual({ available: true, reason: null });
    expect(inputs.security.data).toMatchObject({ verdict: 'clean', exitCode: 0 });
    expect(inputs.vitest.identity.path).toBe('${OPT2_STATE_DIR}/test-all/vitest/services-identity.json');
    expect(inputs.vitest.people.data).toBeNull();
    expect(inputs.parity).toEqual({ path: displayPath(path.join(root, 'reports', 'parity.json'), env), data: null });

    const outcome = await run(['--no-write']);
    expect(outcome).toMatchObject({ code: 0, summary: { written: false, failingStages: [] } });
    expect(existsSync(path.join(root, 'reports'))).toBe(false);
  });

  const writeFixtures = async (text: string) => {
    const state = env.OPT2_STATE_DIR ?? '';
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'fixtures.json'), text);
  };

  it.each<[string, string | null, { available: boolean | null; reason: string | null }]>([
    ['available', JSON.stringify({ available: true, reason: null, checkedAt: AT }), { available: true, reason: null }],
    [
      'unavailable',
      JSON.stringify({ available: false, reason: 'cfpm scheduler missing', checkedAt: AT }),
      { available: false, reason: 'cfpm scheduler missing' },
    ],
    ['missing', null, { available: null, reason: 'fixtures.json missing' }],
  ])('check accepts %s fixtures and creates the absent reports directory', async (_label, text, fixtures) => {
    if (text !== null) await writeFixtures(text);
    const reports = path.join(root, 'reports');
    expect(existsSync(reports)).toBe(false);
    expect(await run(['check'])).toEqual({ summary: { fixtures, reportsDir: displayPath(reports, env) } });
    expect(statSync(reports).isDirectory()).toBe(true);
  });

  it.each<[string, () => Promise<void>, string, string[]]>([
    ['malformed fixtures.json', () => writeFixtures('{bad'), 'GoldenConfigError', ['fixtures.json is not valid JSON']],
    [
      'schema-invalid fixtures.json',
      () => writeFixtures(JSON.stringify({ available: 'yes', reason: null })),
      'GoldenConfigError',
      ['fixtures.json: ', 'available', 'checkedAt'],
    ],
    [
      'a regular file as OPT2_REPORTS_DIR',
      () => writeFile(env.OPT2_REPORTS_DIR ?? '', ''),
      'Error',
      ['OPT2_REPORTS_DIR ', 'is not a writable directory', 'EEXIST'],
    ],
    [
      'OPT2_REPORTS_DIR beneath a regular file',
      async () => {
        await writeFile(env.OPT2_REPORTS_DIR ?? '', '');
        env.OPT2_REPORTS_DIR = path.join(env.OPT2_REPORTS_DIR ?? '', 'sub');
      },
      'Error',
      ['OPT2_REPORTS_DIR ', 'is not a writable directory', 'ENOTDIR'],
    ],
  ])('check exits 1 for %s, naming the input', async (_label, arrange, type, parts) => {
    await arrange();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const chunks: string[] = [];
    const code = await runCli((args) => main(args, { env }), {
      argv: ['check'],
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: () => undefined,
      command: 'test-all',
    });
    vi.restoreAllMocks();
    expect(code).toBe(1);
    const line = JSON.parse(chunks.join('')) as { ok: boolean; error: { type: string; message: string } };
    expect(line).toMatchObject({ ok: false, error: { type } });
    for (const part of parts) expect(line.error.message).toContain(part);
  });

  it('documents check in the help and rejects arguments to it', async () => {
    await expect(run(['check', '--help'])).rejects.toMatchObject({ name: 'HelpRequest', text: expect.stringContaining('test-all check') });
    await expect(run(['check', 'extra'])).rejects.toMatchObject({ name: 'UsageError', usage: 'test-all check' });
  });
});
