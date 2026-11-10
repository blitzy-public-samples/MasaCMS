// Dependency (osv-scanner) and secret (gitleaks) scans of the OPT-2 packages, summarised for test-all.
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from '@opt2/platform/service-kit';

import { isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { REPO_ROOT, stateDir, type EnvLike } from '../lib/paths.js';
import { writeJsonReport } from '../lib/report.js';

/** osv-scanner release the scan requires. */
export const OSV_SCANNER_VERSION = '2.7.0';

/** gitleaks release the scan requires. */
export const GITLEAKS_VERSION = '8.30.1';

/** gitleaks configuration, repository-relative. */
export const GITLEAKS_CONFIG = 'harness/security/gitleaks.toml';

/** gitleaks baseline of pre-existing findings, repository-relative. */
export const GITLEAKS_BASELINE = 'harness/security/gitleaks-baseline.json';

/** Lowest CVSS score that fails a production advisory. */
export const FAILING_CVSS = 7.0;

/**
 * Advisory-database severities that fail a production advisory whatever its CVSS score, as the CI osv filter
 * also fails them; this catches HIGH/CRITICAL advisories published without a CVSS vector.
 */
export const FAILING_DATABASE_SEVERITIES: readonly string[] = ['HIGH', 'CRITICAL'];

/** Every OPT-2 lockfile, repository-relative; the legacy root and CTA manifests are never scanned. */
export const OPT2_LOCKFILES: readonly string[] = [
  'platform/package-lock.json',
  'gateway/package-lock.json',
  'web/package-lock.json',
  'migration/package-lock.json',
  'harness/package-lock.json',
  'legacy-fixtures/seed/package-lock.json',
  'services/identity/package-lock.json',
  'services/people/package-lock.json',
  'services/programs-sites/package-lock.json',
  'services/strategies-content/package-lock.json',
  'services/communications/package-lock.json',
  'services/reporting/package-lock.json',
  'services/surveys/package-lock.json',
  'services/timesheets/package-lock.json',
  'services/finance/package-lock.json',
  'services/e-signature/package-lock.json',
  'services/stub/package-lock.json',
];

/** Severity bucket of an advisory. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

/** Exit status and decoded output of one tool run. */
export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `command` without a shell; resolves on any exit status, rejects only when it cannot run (`ENOENT`: not installed). */
export type ToolRunner = (command: string, args: readonly string[], opts: { cwd: string }) => Promise<ToolResult>;

// osv-scanner JSON for every OPT-2 lockfile runs to several MiB once advisories accumulate.
const MAX_BUFFER = 256 * 1024 * 1024;

/** `execFile` runner with UTF-8 output and a 256 MiB output limit. */
export const defaultToolRunner: ToolRunner = (command, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { cwd: opts.cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, shell: false },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
        } else {
          // A string code (ENOENT, EACCES, output over the limit) or a signal means the tool did not run to an exit.
          reject(error);
        }
      },
    );
  });

/** osv-scanner arguments: JSON report on stdout for each lockfile. */
export function osvArgs(lockfiles: readonly string[] = OPT2_LOCKFILES): string[] {
  return ['scan', 'source', '--format', 'json', ...lockfiles.flatMap((lockfile) => ['--lockfile', lockfile])];
}

/** gitleaks arguments for a directory scan of the working directory, writing its JSON report to `reportPath`. */
export function gitleaksArgs(reportPath: string): string[] {
  return [
    'dir',
    '.',
    '--config',
    GITLEAKS_CONFIG,
    '--baseline-path',
    GITLEAKS_BASELINE,
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--redact',
    '--exit-code',
    '1',
    '--no-banner',
  ];
}

/** Version from `osv-scanner --version` output, or undefined when absent. */
export function parseOsvVersion(stdout: string): string | undefined {
  return /osv-scanner version:\s*v?(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
}

/** Version from `gitleaks version` output, or undefined when it is not a bare version. */
export function parseGitleaksVersion(stdout: string): string | undefined {
  const version = stdout.trim().replace(/^v/, '');
  return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
}

/** CVSS score and bucket of an osv `max_severity` string; empty or unparseable is UNKNOWN with a null score. */
export function severityOf(maxSeverity: string | undefined): { score: number | null; severity: Severity } {
  const text = (maxSeverity ?? '').trim();
  const score = text === '' ? Number.NaN : Number(text);
  if (!Number.isFinite(score)) return { score: null, severity: 'UNKNOWN' };
  if (score >= 9.0) return { score, severity: 'CRITICAL' };
  if (score >= FAILING_CVSS) return { score, severity: 'HIGH' };
  if (score >= 4.0) return { score, severity: 'MEDIUM' };
  return { score, severity: 'LOW' };
}

/** Whether osv marks the package as a development dependency only (`dependency_groups` is exactly `dev` entries). */
export function isDevOnly(pkg: { dependency_groups?: readonly string[] | null }): boolean {
  // osv reports npm `devOptional` entries, which a production install may include, as ['dev', 'optional'].
  const groups = pkg.dependency_groups ?? [];
  return groups.length > 0 && groups.every((group) => group === 'dev');
}

/** One osv advisory group of one package in one lockfile. */
export interface Advisory {
  lockfile: string;
  package: string;
  version: string;
  ecosystem: string;
  ids: string[];
  aliases: string[];
  maxSeverity: string;
  score: number | null;
  severity: Severity;
  /** Highest upper-cased `database_specific.severity` among the group's vulnerabilities, or null. */
  databaseSeverity: string | null;
  production: boolean;
}

/** Whether a production `advisory` reaches `FAILING_CVSS` or a failing database severity. */
export function isFailing(advisory: Advisory): boolean {
  if (!advisory.production) return false;
  if (advisory.score !== null && advisory.score >= FAILING_CVSS) return true;
  return advisory.databaseSeverity !== null && FAILING_DATABASE_SEVERITIES.includes(advisory.databaseSeverity);
}

// Unknown keys are accepted and dropped: only the fields read below are required.
const osvVulnerabilitySchema = z.object({ id: z.string(), database_specific: z.unknown().optional() });

const osvGroupSchema = z.object({
  ids: z.array(z.string()),
  aliases: z.array(z.string()).nullish(),
  max_severity: z.string().nullish(),
});

const osvPackageSchema = z.object({
  package: z.object({ name: z.string(), version: z.string().optional(), ecosystem: z.string().optional() }),
  dependency_groups: z.array(z.string()).nullish(),
  groups: z.array(osvGroupSchema).nullish(),
  vulnerabilities: z.array(osvVulnerabilitySchema).nullish(),
});

const osvReportSchema = z.object({
  results: z
    .array(z.object({ source: z.object({ path: z.string() }), packages: z.array(osvPackageSchema).nullish() }))
    .nullish(),
});

const gitleaksReportSchema = z
  .array(z.object({ RuleID: z.string(), File: z.string(), StartLine: z.number() }))
  .nullable();

const DATABASE_SEVERITY_RANK: Record<string, number> = { LOW: 1, MODERATE: 2, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

const DATABASE_SEVERITY_BUCKET: Record<string, Severity> = {
  LOW: 'LOW',
  MODERATE: 'MEDIUM',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
};

function databaseSeverityOf(vulnerability: z.infer<typeof osvVulnerabilitySchema>): string | null {
  const specific = vulnerability.database_specific;
  if (specific === null || typeof specific !== 'object') return null;
  const severity = (specific as { severity?: unknown }).severity;
  return typeof severity === 'string' && severity.trim() !== '' ? severity.trim().toUpperCase() : null;
}

function highestDatabaseSeverity(
  vulnerabilities: readonly z.infer<typeof osvVulnerabilitySchema>[],
  ids: readonly string[],
): string | null {
  let highest: string | null = null;
  for (const vulnerability of vulnerabilities) {
    if (!ids.includes(vulnerability.id)) continue;
    const severity = databaseSeverityOf(vulnerability);
    if (severity === null) continue;
    if (highest === null || (DATABASE_SEVERITY_RANK[severity] ?? 0) > (DATABASE_SEVERITY_RANK[highest] ?? 0)) {
      highest = severity;
    }
  }
  return highest;
}

function toRepoRelative(sourcePath: string, repoRoot: string): string {
  const relative = path.isAbsolute(sourcePath) ? path.relative(repoRoot, sourcePath) : path.normalize(sourcePath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return sourcePath;
  return relative.split(path.sep).join('/');
}

/** Advisories of an osv-scanner JSON report, one per package advisory group; throws on a malformed report. */
export function parseOsvReport(json: unknown, repoRoot: string = REPO_ROOT): Advisory[] {
  const parsed = osvReportSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`osv-scanner report does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  const advisories: Advisory[] = [];
  for (const result of parsed.data.results ?? []) {
    const lockfile = toRepoRelative(result.source.path, repoRoot);
    for (const pkg of result.packages ?? []) {
      const production = !isDevOnly(pkg);
      for (const group of pkg.groups ?? []) {
        const maxSeverity = group.max_severity ?? '';
        const { score, severity } = severityOf(maxSeverity);
        const databaseSeverity = highestDatabaseSeverity(pkg.vulnerabilities ?? [], group.ids);
        advisories.push({
          lockfile,
          package: pkg.package.name,
          version: pkg.package.version ?? '',
          ecosystem: pkg.package.ecosystem ?? '',
          ids: [...group.ids],
          aliases: [...(group.aliases ?? [])],
          maxSeverity,
          score,
          severity:
            severity === 'UNKNOWN' && databaseSeverity !== null
              ? (DATABASE_SEVERITY_BUCKET[databaseSeverity] ?? 'UNKNOWN')
              : severity,
          databaseSeverity,
          production,
        });
      }
    }
  }
  return advisories;
}

/** Location of one gitleaks finding; its secret and match text are never kept. */
export interface SecretFinding {
  ruleId: string;
  file: string;
  line: number;
}

/** Findings of a gitleaks JSON report (`null` or `[]` is none); throws when the report has the wrong shape. */
export function parseGitleaksReport(json: unknown): { count: number; items: SecretFinding[] } {
  const parsed = gitleaksReportSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`gitleaks report does not match its schema:\n${z.prettifyError(parsed.error)}`);
  }
  const items = (parsed.data ?? []).map((finding) => ({
    ruleId: finding.RuleID,
    file: finding.File,
    line: finding.StartLine,
  }));
  return { count: items.length, items };
}

/** Injectable tool runner, environment (for `OPT2_STATE_DIR`) and repository root of {@link runSecurityScan}. */
export interface ScanDeps {
  run?: ToolRunner;
  env?: EnvLike;
  repoRoot?: string;
}

/** Content of `<state>/security/summary.json`, read by `reporting/test-all.ts`. */
export interface SecuritySummary {
  /** Detected versions; null when a tool is missing or its version cannot be read. */
  tools: { osvScanner: string | null; gitleaks: string | null };
  dependencies: {
    lockfiles: string[];
    advisories: Record<Severity, number>;
    production: Record<Severity, number>;
    failing: Advisory[];
    report: string;
  };
  secrets: { findings: number; items: SecretFinding[]; baseline: string; report: string };
  verdict: 'clean' | 'findings' | 'error';
  exitCode: 0 | 1 | 2;
  error?: string;
}

/** Outcome of {@link runSecurityScan}. */
export interface ScanResult {
  code: 0 | 1 | 2;
  summary: SecuritySummary;
  summaryPath: string;
}

const STDERR_TAIL_LINES = 20;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lastLines(text: string): string {
  // gitleaks colours its log lines.
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  return plain.split('\n').slice(-STDERR_TAIL_LINES).join('\n');
}

type Attempt = { result: ToolResult } | { error: string };

async function attempt(run: ToolRunner, command: string, args: readonly string[], cwd: string): Promise<Attempt> {
  try {
    return { result: await run(command, args, { cwd }) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { error: code === 'ENOENT' ? `${command}: tool missing` : `${command}: cannot run: ${messageOf(err)}` };
  }
}

async function checkVersion(
  run: ToolRunner,
  command: string,
  args: readonly string[],
  parse: (stdout: string) => string | undefined,
  expected: string,
  cwd: string,
): Promise<{ version: string | null; error?: string }> {
  const outcome = await attempt(run, command, args, cwd);
  if ('error' in outcome) return { version: null, error: outcome.error };
  const { code, stdout, stderr } = outcome.result;
  if (code !== 0) {
    return { version: null, error: `${command} ${args.join(' ')} exited ${code}: ${lastLines(stderr)}` };
  }
  const version = parse(stdout) ?? null;
  if (version !== expected) {
    return { version, error: `${command}: wrong version ${version ?? 'unparseable'}, expected ${expected}` };
  }
  return { version };
}

async function missingLockfiles(repoRoot: string): Promise<string[]> {
  const missing: string[] = [];
  for (const lockfile of OPT2_LOCKFILES) {
    try {
      await access(path.join(repoRoot, lockfile));
    } catch {
      missing.push(lockfile);
    }
  }
  return missing;
}

// osv-scanner exits 0 with no advisories and 1 with some; every other status is a tool error.
async function scanDependencies(
  run: ToolRunner,
  repoRoot: string,
  reportPath: string,
): Promise<{ advisories: Advisory[] } | { error: string }> {
  const outcome = await attempt(run, 'osv-scanner', osvArgs(), repoRoot);
  if ('error' in outcome) return outcome;
  const { code, stdout, stderr } = outcome.result;
  if (code !== 0 && code !== 1) return { error: `osv-scanner exited ${code}: ${lastLines(stderr)}` };
  await writeFile(reportPath, stdout, 'utf8');
  try {
    return { advisories: parseOsvReport(JSON.parse(stdout), repoRoot) };
  } catch (err) {
    return { error: `osv-scanner report ${reportPath}: ${messageOf(err)}` };
  }
}

// gitleaks exits 1 on new findings and on a fatal error alike, so the report file decides between them.
async function scanSecrets(
  run: ToolRunner,
  repoRoot: string,
  reportPath: string,
): Promise<{ count: number; items: SecretFinding[] } | { error: string }> {
  const outcome = await attempt(run, 'gitleaks', gitleaksArgs(reportPath), repoRoot);
  if ('error' in outcome) return outcome;
  const { code, stderr } = outcome.result;
  if (code !== 0 && code !== 1) return { error: `gitleaks exited ${code}: ${lastLines(stderr)}` };
  try {
    return parseGitleaksReport(JSON.parse(await readFile(reportPath, 'utf8')));
  } catch (err) {
    return { error: `gitleaks report ${reportPath}: ${messageOf(err)}; gitleaks exited ${code}: ${lastLines(stderr)}` };
  }
}

function countBySeverity(advisories: readonly Advisory[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
  for (const advisory of advisories) counts[advisory.severity] += 1;
  return counts;
}

/**
 * Checks the lockfiles and tool versions, runs osv-scanner and gitleaks from the repository root, and writes
 * `osv.json`, `gitleaks.json` and `summary.json` under `<state>/security/`. Code 0 clean, 1 findings, 2 error.
 */
export async function runSecurityScan(deps: ScanDeps = {}): Promise<ScanResult> {
  const run = deps.run ?? defaultToolRunner;
  const root = deps.repoRoot ?? REPO_ROOT;
  const outDir = path.join(stateDir(deps.env), 'security');
  const osvReport = path.join(outDir, 'osv.json');
  const gitleaksReport = path.join(outDir, 'gitleaks.json');
  const summaryPath = path.join(outDir, 'summary.json');
  // A report left by an earlier run must never be read or cited as this run's.
  await Promise.all([rm(osvReport, { force: true }), rm(gitleaksReport, { force: true })]);

  const errors: string[] = [];
  const missing = await missingLockfiles(root);
  if (missing.length > 0) errors.push(`missing lockfiles: ${missing.join(', ')}`);
  const osvVersion = await checkVersion(run, 'osv-scanner', ['--version'], parseOsvVersion, OSV_SCANNER_VERSION, root);
  const gitleaksVersion = await checkVersion(run, 'gitleaks', ['version'], parseGitleaksVersion, GITLEAKS_VERSION, root);
  for (const check of [osvVersion, gitleaksVersion]) {
    if (check.error !== undefined) errors.push(check.error);
  }

  let advisories: Advisory[] = [];
  let secrets: { count: number; items: SecretFinding[] } = { count: 0, items: [] };
  if (errors.length === 0) {
    await mkdir(outDir, { recursive: true });
    const dependencyScan = await scanDependencies(run, root, osvReport);
    if ('error' in dependencyScan) errors.push(dependencyScan.error);
    else advisories = dependencyScan.advisories;
    const secretScan = await scanSecrets(run, root, gitleaksReport);
    if ('error' in secretScan) errors.push(secretScan.error);
    else secrets = secretScan;
  }

  const failing = advisories.filter(isFailing);
  const code: 0 | 1 | 2 = errors.length > 0 ? 2 : failing.length > 0 || secrets.count > 0 ? 1 : 0;
  const summary: SecuritySummary = {
    tools: { osvScanner: osvVersion.version, gitleaks: gitleaksVersion.version },
    dependencies: {
      lockfiles: [...OPT2_LOCKFILES],
      advisories: countBySeverity(advisories),
      production: countBySeverity(advisories.filter((advisory) => advisory.production)),
      failing,
      report: osvReport,
    },
    secrets: { findings: secrets.count, items: secrets.items, baseline: GITLEAKS_BASELINE, report: gitleaksReport },
    verdict: code === 2 ? 'error' : code === 1 ? 'findings' : 'clean',
    exitCode: code,
    ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
  };
  await writeJsonReport(summaryPath, { ...summary });
  return { code, summary, summaryPath };
}

const USAGE = 'security:scan (takes no arguments)';

/** CLI entry: runs both scans and returns their exit code with the summary line fields. */
export async function main(argv: string[], deps: ScanDeps = {}): Promise<CliOutcome> {
  parseFlags(argv, { options: {}, usage: USAGE });
  const { code, summary, summaryPath } = await runSecurityScan(deps);
  return {
    code,
    summary: {
      verdict: summary.verdict,
      exitCode: summary.exitCode,
      productionHighCritical: summary.dependencies.failing.length,
      secretFindings: summary.secrets.findings,
      summaryPath,
      ...(summary.error !== undefined ? { reason: summary.error } : {}),
    },
  };
}

if (isMainModule(import.meta.url)) void runCli(main);

