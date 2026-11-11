import { existsSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { UsageError } from '../../src/lib/cli.js';
import { REPO_ROOT } from '../../src/lib/paths.js';
import { readPin } from '../../src/lib/pin.js';
import {
  FAILING_CVSS,
  FAILING_DATABASE_SEVERITIES,
  GITLEAKS_BASELINE,
  GITLEAKS_CONFIG,
  GITLEAKS_VERSION,
  OPT2_LOCKFILES,
  OSV_SCANNER_VERSION,
  SCAN_TIMEOUT_MS,
  VERSION_PROBE_TIMEOUT_MS,
  defaultToolRunner,
  gitleaksArgs,
  isDevOnly,
  isFailing,
  main,
  osvArgs,
  parseGitleaksReport,
  parseGitleaksVersion,
  parseOsvReport,
  parseOsvVersion,
  runSecurityScan,
  severityOf,
  type Advisory,
  type ScanResult,
  type SecretFinding,
  type Severity,
  type ToolResult,
  type ToolRunner,
} from '../../src/security/scan.js';

const PIN = readPin();
const OSV_VERSION_OUTPUT = 'osv-scanner version: 2.7.0\nosv-scalibr version: 0.5.3\ncommit: n/a\nbuilt at: n/a\n';
const NO_COUNTS: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };

// osv-scanner package entries: production HIGH, dev-only CRITICAL, and devOptional MODERATE without a CVSS score.
const PACKAGE_0001 = {
  package: { name: 'fixture-prod-high', version: '1.2.3', ecosystem: 'npm' },
  vulnerabilities: [{ id: 'OSV-FIXTURE-0001', summary: 'fixture', database_specific: { severity: 'HIGH' } }],
  groups: [{ ids: ['OSV-FIXTURE-0001'], aliases: ['OSV-FIXTURE-0001', 'CVE-FIXTURE-0001'], max_severity: '7.5' }],
};

const PACKAGE_0002 = {
  package: { name: 'fixture-dev-critical', version: '4.5.6', ecosystem: 'npm' },
  dependency_groups: ['dev'],
  vulnerabilities: [{ id: 'OSV-FIXTURE-0002', database_specific: { severity: 'CRITICAL' } }],
  groups: [{ ids: ['OSV-FIXTURE-0002'], aliases: ['CVE-FIXTURE-0002'], max_severity: '9.8' }],
};

const PACKAGE_0003 = {
  package: { name: 'fixture-optional-moderate', version: '7.8.9', ecosystem: 'npm' },
  dependency_groups: ['dev', 'optional'],
  vulnerabilities: [{ id: 'OSV-FIXTURE-0003', database_specific: { severity: 'MODERATE' } }],
  groups: [{ ids: ['OSV-FIXTURE-0003'], aliases: [], max_severity: '' }],
};

/** osv-scanner report of the three fixture advisories; the first source path is absolute, the second relative. */
function osvSample(repoRoot: string) {
  return {
    results: [
      { source: { path: path.join(repoRoot, 'platform/package-lock.json'), type: 'lockfile' }, packages: [PACKAGE_0001] },
      { source: { path: 'services/people/package-lock.json', type: 'lockfile' }, packages: [PACKAGE_0002, PACKAGE_0003] },
    ],
    experimental_config: { licenses: { summary: false, allowlist: [] } },
  };
}

const ADVISORY_0001: Advisory = {
  lockfile: 'platform/package-lock.json',
  package: 'fixture-prod-high',
  version: '1.2.3',
  ecosystem: 'npm',
  ids: ['OSV-FIXTURE-0001'],
  aliases: ['OSV-FIXTURE-0001', 'CVE-FIXTURE-0001'],
  maxSeverity: '7.5',
  score: 7.5,
  severity: 'HIGH',
  databaseSeverity: 'HIGH',
  production: true,
};

const ADVISORY_0002: Advisory = {
  lockfile: 'services/people/package-lock.json',
  package: 'fixture-dev-critical',
  version: '4.5.6',
  ecosystem: 'npm',
  ids: ['OSV-FIXTURE-0002'],
  aliases: ['CVE-FIXTURE-0002'],
  maxSeverity: '9.8',
  score: 9.8,
  severity: 'CRITICAL',
  databaseSeverity: 'CRITICAL',
  production: false,
};

const ADVISORY_0003: Advisory = {
  lockfile: 'services/people/package-lock.json',
  package: 'fixture-optional-moderate',
  version: '7.8.9',
  ecosystem: 'npm',
  ids: ['OSV-FIXTURE-0003'],
  aliases: [],
  maxSeverity: '',
  score: null,
  severity: 'MEDIUM',
  databaseSeverity: 'MODERATE',
  production: true,
};

// Copied from harness/security/gitleaks-baseline.json, secret and match redacted.
const BASELINE_FINDING = {
  RuleID: 'gcp-api-key',
  Description:
    'Uncovered a GCP API key, which could lead to unauthorized access to Google Cloud services and data breaches.',
  StartLine: 40,
  EndLine: 40,
  StartColumn: 48,
  EndColumn: 87,
  Match: 'REDACTED',
  Secret: 'REDACTED',
  File: 'core/vendor/ckeditor/plugins/leaflet/Installation-Guide.txt',
  SymlinkFile: '',
  Commit: '',
  Entropy: 4.5606675,
  Author: '',
  Email: '',
  Date: '',
  Message: '',
  Tags: [],
  Fingerprint: 'core/vendor/ckeditor/plugins/leaflet/Installation-Guide.txt:gcp-api-key:40',
};

const NEW_FINDING = {
  ...BASELINE_FINDING,
  RuleID: 'generic-api-key',
  Description: 'Detected a Generic API Key, potentially exposing access to various services and sensitive operations.',
  StartLine: 12,
  EndLine: 12,
  StartColumn: 3,
  EndColumn: 30,
  File: 'services/people/src/config.ts',
  Entropy: 3.75,
  Fingerprint: 'services/people/src/config.ts:generic-api-key:12',
};

const GITLEAKS_SAMPLE = [BASELINE_FINDING, NEW_FINDING];

const SAMPLE_ITEMS: SecretFinding[] = [
  { ruleId: 'gcp-api-key', file: 'core/vendor/ckeditor/plugins/leaflet/Installation-Guide.txt', line: 40 },
  { ruleId: 'generic-api-key', file: 'services/people/src/config.ts', line: 12 },
];

/** Scripted answer of one tool call: an exit, a rejection, or a function of the call's arguments. */
type Step = ToolResult | { reject: unknown } | ((args: readonly string[]) => Promise<ToolResult>);

interface Script {
  osvVersion?: Step;
  gitleaksVersion?: Step;
  osvScan?: Step;
  gitleaksScan?: Step;
}

function exited(code: number, stdout = '', stderr = ''): ToolResult {
  return { code, stdout, stderr };
}

function errno(code: string, command: string): Error {
  return Object.assign(new Error(`spawn ${command} ${code}`), { code });
}

/** Rejection of a runner whose tool outlived its budget. */
function timedOut(command: string): Error {
  return Object.assign(new Error(`${command} timed out after 1 ms`), { code: 'ETIMEDOUT' });
}

function osvPrints(report: unknown, code: number): Step {
  return exited(code, JSON.stringify(report));
}

function reportPathOf(args: readonly string[]): string {
  const value = args[args.indexOf('--report-path') + 1];
  if (!args.includes('--report-path') || value === undefined) throw new Error(`no --report-path in ${args.join(' ')}`);
  return value;
}

/** gitleaks scan that writes `findings` as its JSON report and exits `code`. */
function gitleaksWrites(findings: unknown, code: number): Step {
  return async (args) => {
    await writeFile(reportPathOf(args), JSON.stringify(findings), 'utf8');
    return exited(code);
  };
}

const CLEAN_SCRIPT: Required<Script> = {
  osvVersion: exited(0, OSV_VERSION_OUTPUT),
  gitleaksVersion: exited(0, `${GITLEAKS_VERSION}\n`),
  osvScan: osvPrints({ results: [] }, 0),
  gitleaksScan: gitleaksWrites([], 0),
};

/** Fake runner answering the two version checks and the two scans from `script`, defaulting to a clean run. */
function scriptedRunner(script: Script = {}) {
  const steps = { ...CLEAN_SCRIPT, ...script };
  return vi.fn<ToolRunner>(async (command, args) => {
    let step: Step;
    if (command === 'osv-scanner') step = args[0] === '--version' ? steps.osvVersion : steps.osvScan;
    else if (command === 'gitleaks') step = args[0] === 'version' ? steps.gitleaksVersion : steps.gitleaksScan;
    else throw new Error(`unexpected command ${command}`);
    if (typeof step === 'function') return step(args);
    if ('reject' in step) throw step.reject;
    return step;
  });
}

let root: string;
let repo: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'opt2-security-scan-'));
  repo = path.join(root, 'repo');
  for (const lockfile of OPT2_LOCKFILES) {
    await mkdir(path.dirname(path.join(repo, lockfile)), { recursive: true });
    await writeFile(path.join(repo, lockfile), '{}\n', 'utf8');
  }
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

interface ScanRun {
  result: ScanResult;
  run: ReturnType<typeof scriptedRunner>;
  osvReport: string;
  gitleaksReport: string;
}

/** Runs the scan with a fake runner against a fresh state directory (or `state`) and the fixture repository. */
async function scan(script: Script = {}, opts: { repoRoot?: string; state?: string } = {}): Promise<ScanRun> {
  const state = opts.state ?? (await mkdtemp(path.join(root, 'state-')));
  const run = scriptedRunner(script);
  const result = await runSecurityScan({ run, env: { OPT2_STATE_DIR: state }, repoRoot: opts.repoRoot ?? repo });
  const out = path.join(state, 'security');
  return { result, run, osvReport: path.join(out, 'osv.json'), gitleaksReport: path.join(out, 'gitleaks.json') };
}

/** summary.json as written, split into the summary body and its report stamp. */
async function writtenSummary(result: ScanResult) {
  const { sourceSha, generatedBy, generatedAt, ...body } = JSON.parse(await readFile(result.summaryPath, 'utf8'));
  return { body, sourceSha, generatedBy, generatedAt };
}

function jsonParseMessage(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error(`${text} is valid JSON`);
}

describe('pinned tools and scanned files', () => {
  it('requires osv-scanner 2.7.0 and gitleaks 8.30.1 and fails production advisories from CVSS 7.0', () => {
    expect(OSV_SCANNER_VERSION).toBe('2.7.0');
    expect(GITLEAKS_VERSION).toBe('8.30.1');
    expect(FAILING_CVSS).toBe(7.0);
    expect(FAILING_DATABASE_SEVERITIES).toEqual(['HIGH', 'CRITICAL']);
  });

  it('names a gitleaks configuration and baseline that exist in the checkout', () => {
    expect(existsSync(path.join(REPO_ROOT, GITLEAKS_CONFIG))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, GITLEAKS_BASELINE))).toBe(true);
  });

  it('lists 17 distinct OPT-2 lockfiles that exist, never the legacy root or CTA lockfile', () => {
    expect(OPT2_LOCKFILES).toHaveLength(17);
    expect(new Set(OPT2_LOCKFILES).size).toBe(OPT2_LOCKFILES.length);
    for (const lockfile of OPT2_LOCKFILES) expect(existsSync(path.join(REPO_ROOT, lockfile)), lockfile).toBe(true);
    expect(OPT2_LOCKFILES).not.toContain('package-lock.json');
    expect(OPT2_LOCKFILES).not.toContain('core/modules/v1/cta/package-lock.json');
  });

  it('lists the lockfile of every services/* package', async () => {
    const entries = await readdir(path.join(REPO_ROOT, 'services'), { withFileTypes: true });
    const services = entries
      .filter((entry) => entry.isDirectory() && existsSync(path.join(REPO_ROOT, 'services', entry.name, 'package.json')))
      .map((entry) => `services/${entry.name}/package-lock.json`);
    expect(services.length).toBeGreaterThan(0);
    for (const lockfile of services) expect(OPT2_LOCKFILES).toContain(lockfile);
  });
});

describe('tool arguments', () => {
  it('scans every OPT-2 lockfile as JSON by default', () => {
    expect(osvArgs()).toEqual([
      'scan',
      'source',
      '--format',
      'json',
      ...OPT2_LOCKFILES.flatMap((lockfile) => ['--lockfile', lockfile]),
    ]);
  });

  it.each([
    [[], ['scan', 'source', '--format', 'json']],
    [['a/package-lock.json'], ['scan', 'source', '--format', 'json', '--lockfile', 'a/package-lock.json']],
  ])('builds osv-scanner arguments for %j', (lockfiles, expected) => {
    expect(osvArgs(lockfiles)).toEqual(expected);
  });

  it('scans the working directory with the configuration, baseline, redaction and exit code 1', () => {
    expect(gitleaksArgs('/state/security/gitleaks.json')).toEqual([
      'dir',
      '.',
      '--config',
      'harness/security/gitleaks.toml',
      '--baseline-path',
      'harness/security/gitleaks-baseline.json',
      '--report-format',
      'json',
      '--report-path',
      '/state/security/gitleaks.json',
      '--redact',
      '--exit-code',
      '1',
      '--no-banner',
    ]);
  });
});

describe('version parsing', () => {
  it.each([
    [OSV_VERSION_OUTPUT, '2.7.0'],
    ['osv-scanner version: v2.7.0\n', '2.7.0'],
    ['osv-scalibr version: 0.5.3\n', undefined],
    ['', undefined],
  ])('reads osv-scanner %j as %s', (stdout, expected) => {
    expect(parseOsvVersion(stdout)).toBe(expected);
  });

  it.each([
    ['8.30.1\n', '8.30.1'],
    ['v8.30.1', '8.30.1'],
    ['  8.30.1  ', '8.30.1'],
    ['dev', undefined],
    ['gitleaks version 8.30.1', undefined],
    ['8.30', undefined],
  ])('reads gitleaks %j as %s', (stdout, expected) => {
    expect(parseGitleaksVersion(stdout)).toBe(expected);
  });
});

describe('severityOf', () => {
  it.each<[string | undefined, number | null, Severity]>([
    [undefined, null, 'UNKNOWN'],
    ['', null, 'UNKNOWN'],
    ['   ', null, 'UNKNOWN'],
    ['CVSS:3.1/AV:N/AC:L', null, 'UNKNOWN'],
    ['Infinity', null, 'UNKNOWN'],
    ['10', 10, 'CRITICAL'],
    ['9.0', 9, 'CRITICAL'],
    ['8.9', 8.9, 'HIGH'],
    ['7.0', 7, 'HIGH'],
    [' 7.5 ', 7.5, 'HIGH'],
    ['6.9', 6.9, 'MEDIUM'],
    ['4.0', 4, 'MEDIUM'],
    ['3.9', 3.9, 'LOW'],
    ['0', 0, 'LOW'],
  ])('buckets %j as score %s, %s', (maxSeverity, score, severity) => {
    expect(severityOf(maxSeverity)).toEqual({ score, severity });
  });
});

describe('isDevOnly', () => {
  it.each<[readonly string[] | null | undefined, boolean]>([
    [undefined, false],
    [null, false],
    [[], false],
    [['dev'], true],
    [['dev', 'dev'], true],
    [['dev', 'optional'], false],
    [['optional'], false],
  ])('dependency_groups %j is dev-only: %s', (groups, expected) => {
    expect(isDevOnly(groups === undefined ? {} : { dependency_groups: groups })).toBe(expected);
  });
});

describe('isFailing', () => {
  it.each<[string, Partial<Advisory>, boolean]>([
    ['a dev-only CRITICAL advisory', { production: false, score: 9.8, databaseSeverity: 'CRITICAL' }, false],
    ['a production advisory at CVSS 7.0', { score: 7.0 }, true],
    ['a production advisory at CVSS 6.9', { score: 6.9 }, false],
    ['a production HIGH advisory without a score', { score: null, databaseSeverity: 'HIGH' }, true],
    ['a production CRITICAL advisory without a score', { score: null, databaseSeverity: 'CRITICAL' }, true],
    ['a production MODERATE advisory without a score', { score: null, databaseSeverity: 'MODERATE' }, false],
    ['a production advisory scored 5.0 with database severity HIGH', { score: 5.0, databaseSeverity: 'HIGH' }, true],
    ['a production advisory with neither score nor database severity', { score: null }, false],
  ])('%s fails: %s', (_label, overrides, expected) => {
    const base: Advisory = { ...ADVISORY_0003, production: true, score: null, databaseSeverity: null };
    expect(isFailing({ ...base, ...overrides })).toBe(expected);
  });
});

describe('parseOsvReport', () => {
  const ROOT = '/srv/checkout';

  it('reads one advisory per package group with its lockfile, severity and production flag', () => {
    expect(parseOsvReport(osvSample(ROOT), ROOT)).toEqual([ADVISORY_0001, ADVISORY_0002, ADVISORY_0003]);
  });

  it('resolves absolute source paths against the repository root by default', () => {
    const report = { results: [{ source: { path: path.join(REPO_ROOT, 'harness/package-lock.json') }, packages: [PACKAGE_0001] }] };
    expect(parseOsvReport(report).map((advisory) => advisory.lockfile)).toEqual(['harness/package-lock.json']);
  });

  it.each([
    ['/srv/checkout/services/people/package-lock.json', 'services/people/package-lock.json'],
    ['./services/people/../people/package-lock.json', 'services/people/package-lock.json'],
    ['/srv/elsewhere/package-lock.json', '/srv/elsewhere/package-lock.json'],
    ['../outside/package-lock.json', '../outside/package-lock.json'],
    ['/srv', '/srv'],
  ])('reports source %s as lockfile %s', (sourcePath, lockfile) => {
    const report = { results: [{ source: { path: sourcePath }, packages: [PACKAGE_0001] }] };
    expect(parseOsvReport(report, ROOT).map((advisory) => advisory.lockfile)).toEqual([lockfile]);
  });

  it.each<[string, unknown]>([
    ['no results key', {}],
    ['null results', { results: null }],
    ['a result without packages', { results: [{ source: { path: 'a/package-lock.json' } }] }],
    ['a result with null packages', { results: [{ source: { path: 'a/package-lock.json' }, packages: null }] }],
    ['a package without groups', { results: [{ source: { path: 'a/package-lock.json' }, packages: [{ package: { name: 'p' } }] }] }],
  ])('returns no advisories for %s', (_label, report) => {
    expect(parseOsvReport(report, ROOT)).toEqual([]);
  });

  it('defaults absent version, ecosystem, aliases and severity, treating missing groups as production', () => {
    const report = {
      results: [
        {
          source: { path: 'a/package-lock.json' },
          packages: [{ package: { name: 'bare' }, groups: [{ ids: ['OSV-FIXTURE-0001'], aliases: null, max_severity: null }] }],
        },
      ],
    };
    expect(parseOsvReport(report, ROOT)).toEqual([
      {
        lockfile: 'a/package-lock.json',
        package: 'bare',
        version: '',
        ecosystem: '',
        ids: ['OSV-FIXTURE-0001'],
        aliases: [],
        maxSeverity: '',
        score: null,
        severity: 'UNKNOWN',
        databaseSeverity: null,
        production: true,
      },
    ]);
  });

  it.each<[string, string, unknown[] | undefined, string | null, Severity]>([
    ['no vulnerabilities', '', undefined, null, 'UNKNOWN'],
    ['a non-object database_specific', '', [{ id: 'A', database_specific: 'HIGH' }], null, 'UNKNOWN'],
    ['a null database_specific', '', [{ id: 'A', database_specific: null }], null, 'UNKNOWN'],
    ['database_specific without severity', '', [{ id: 'A', database_specific: {} }], null, 'UNKNOWN'],
    ['a blank severity', '', [{ id: 'A', database_specific: { severity: '  ' } }], null, 'UNKNOWN'],
    ['a numeric severity', '', [{ id: 'A', database_specific: { severity: 7 } }], null, 'UNKNOWN'],
    ['a vulnerability outside the group', '', [{ id: 'C', database_specific: { severity: 'CRITICAL' } }], null, 'UNKNOWN'],
    [
      'a higher later severity',
      '',
      [
        { id: 'A', database_specific: { severity: 'low' } },
        { id: 'B', database_specific: { severity: ' high ' } },
      ],
      'HIGH',
      'HIGH',
    ],
    [
      'a lower later severity',
      '',
      [
        { id: 'A', database_specific: { severity: 'CRITICAL' } },
        { id: 'B', database_specific: { severity: 'MODERATE' } },
      ],
      'CRITICAL',
      'CRITICAL',
    ],
    [
      'an unranked severity before a ranked one',
      '',
      [
        { id: 'A', database_specific: { severity: 'IMPORTANT' } },
        { id: 'B', database_specific: { severity: 'LOW' } },
      ],
      'LOW',
      'LOW',
    ],
    [
      'an unranked severity after a ranked one',
      '',
      [
        { id: 'A', database_specific: { severity: 'LOW' } },
        { id: 'B', database_specific: { severity: 'IMPORTANT' } },
      ],
      'LOW',
      'LOW',
    ],
    ['only an unranked severity', '', [{ id: 'A', database_specific: { severity: 'IMPORTANT' } }], 'IMPORTANT', 'UNKNOWN'],
    ['MEDIUM', '', [{ id: 'B', database_specific: { severity: 'medium' } }], 'MEDIUM', 'MEDIUM'],
    ['a CVSS score beside a database severity', '5.0', [{ id: 'A', database_specific: { severity: 'CRITICAL' } }], 'CRITICAL', 'MEDIUM'],
  ])('with %s takes database severity %s and bucket %s', (_label, maxSeverity, vulnerabilities, databaseSeverity, severity) => {
    const report = {
      results: [
        {
          source: { path: 'a/package-lock.json' },
          packages: [
            {
              package: { name: 'p', version: '1.0.0', ecosystem: 'npm' },
              ...(vulnerabilities === undefined ? {} : { vulnerabilities }),
              groups: [{ ids: ['A', 'B'], max_severity: maxSeverity }],
            },
          ],
        },
      ],
    };
    const [advisory] = parseOsvReport(report, ROOT);
    expect(advisory).toMatchObject({ databaseSeverity, severity });
  });

  it.each<[string, unknown]>([
    ['a string', 'osv'],
    ['an array', []],
    ['a source without a path', { results: [{ source: {} }] }],
    ['a package without a name', { results: [{ source: { path: 'p' }, packages: [{ package: {} }] }] }],
    ['group ids that are not a list', { results: [{ source: { path: 'p' }, packages: [{ package: { name: 'p' }, groups: [{ ids: 'A' }] }] }] }],
  ])('throws on %s', (_label, report) => {
    expect(() => parseOsvReport(report, ROOT)).toThrowError(/^osv-scanner report does not match its schema:\n/);
  });
});

describe('parseGitleaksReport', () => {
  it('keeps each finding as rule, file and line only, never its secret or match', () => {
    const parsed = parseGitleaksReport(GITLEAKS_SAMPLE);
    expect(parsed).toEqual({ count: 2, items: SAMPLE_ITEMS });
    expect(JSON.stringify(parsed)).not.toContain('REDACTED');
  });

  it('copies its baseline finding from the committed gitleaks baseline', async () => {
    const baseline: { Fingerprint: string }[] = JSON.parse(await readFile(path.join(REPO_ROOT, GITLEAKS_BASELINE), 'utf8'));
    const entry = baseline.find((finding) => finding.Fingerprint === BASELINE_FINDING.Fingerprint);
    expect(entry).toMatchObject({
      RuleID: BASELINE_FINDING.RuleID,
      File: BASELINE_FINDING.File,
      StartLine: BASELINE_FINDING.StartLine,
      EndLine: BASELINE_FINDING.EndLine,
      Secret: 'REDACTED',
    });
  });

  it.each([[null], [[]]])('reads %j as no findings', (report) => {
    expect(parseGitleaksReport(report)).toEqual({ count: 0, items: [] });
  });

  it.each<[string, unknown]>([
    ['an object', { findings: [] }],
    ['a string', 'gitleaks'],
    ['a finding without StartLine', [{ RuleID: 'r', File: 'f' }]],
    ['a string StartLine', [{ RuleID: 'r', File: 'f', StartLine: '1' }]],
  ])('throws on %s', (_label, report) => {
    expect(() => parseGitleaksReport(report)).toThrowError(/^gitleaks report does not match its schema:\n/);
  });
});

describe('runSecurityScan', () => {
  it('checks both versions, then scans from the repository root and writes a clean summary', async () => {
    const { result, run, osvReport, gitleaksReport } = await scan();
    expect(run.mock.calls).toEqual([
      ['osv-scanner', ['--version'], { cwd: repo, timeoutMs: VERSION_PROBE_TIMEOUT_MS }],
      ['gitleaks', ['version'], { cwd: repo, timeoutMs: VERSION_PROBE_TIMEOUT_MS }],
      ['osv-scanner', osvArgs(), { cwd: repo, timeoutMs: SCAN_TIMEOUT_MS }],
      ['gitleaks', gitleaksArgs(gitleaksReport), { cwd: repo, timeoutMs: SCAN_TIMEOUT_MS }],
    ]);
    expect(result.code).toBe(0);
    expect(result.summary).toEqual({
      tools: { osvScanner: '2.7.0', gitleaks: '8.30.1' },
      dependencies: {
        lockfiles: [...OPT2_LOCKFILES],
        advisories: NO_COUNTS,
        production: NO_COUNTS,
        failing: [],
        report: osvReport,
      },
      secrets: { findings: 0, items: [], baseline: GITLEAKS_BASELINE, report: gitleaksReport },
      verdict: 'clean',
      exitCode: 0,
    });
    expect(result.summaryPath).toBe(path.join(path.dirname(osvReport), 'summary.json'));
    expect(await readFile(osvReport, 'utf8')).toBe(JSON.stringify({ results: [] }));
    const written = await writtenSummary(result);
    expect(written.body).toEqual(result.summary);
    expect(written.sourceSha).toBe(PIN.sha);
    expect(Number.isNaN(Date.parse(written.generatedAt))).toBe(false);
  });

  it('counts every advisory, fails only production HIGH/CRITICAL ones and reports each secret finding', async () => {
    const { result, osvReport, gitleaksReport } = await scan({
      osvScan: osvPrints(osvSample(repo), 1),
      gitleaksScan: gitleaksWrites(GITLEAKS_SAMPLE, 1),
    });
    expect(result.code).toBe(1);
    expect(result.summary).toEqual({
      tools: { osvScanner: '2.7.0', gitleaks: '8.30.1' },
      dependencies: {
        lockfiles: [...OPT2_LOCKFILES],
        advisories: { ...NO_COUNTS, CRITICAL: 1, HIGH: 1, MEDIUM: 1 },
        production: { ...NO_COUNTS, HIGH: 1, MEDIUM: 1 },
        failing: [ADVISORY_0001],
        report: osvReport,
      },
      secrets: { findings: 2, items: SAMPLE_ITEMS, baseline: GITLEAKS_BASELINE, report: gitleaksReport },
      verdict: 'findings',
      exitCode: 1,
    });
    expect((await writtenSummary(result)).body).toEqual(result.summary);
    expect(await readFile(result.summaryPath, 'utf8')).not.toContain('REDACTED');
  });

  const devOnly = () => ({ results: [{ source: { path: 'services/people/package-lock.json' }, packages: [PACKAGE_0002] }] });
  const unscoredHigh = (repoRoot: string) => ({
    results: [
      {
        source: { path: path.join(repoRoot, 'gateway/package-lock.json') },
        packages: [
          {
            package: { name: 'fixture-unscored', version: '0.1.0', ecosystem: 'npm' },
            vulnerabilities: [{ id: 'OSV-FIXTURE-0001', database_specific: { severity: 'HIGH' } }],
            groups: [{ ids: ['OSV-FIXTURE-0001'], max_severity: '' }],
          },
        ],
      },
    ],
  });

  it.each<[string, (root: string) => unknown, unknown, 0 | 1, 'clean' | 'findings', string[], number]>([
    ['no advisories and a null gitleaks report', () => ({ results: [] }), null, 0, 'clean', [], 0],
    ['a dev-only CRITICAL advisory only', devOnly, [], 0, 'clean', [], 0],
    ['a production HIGH advisory published without CVSS', unscoredHigh, [], 1, 'findings', ['OSV-FIXTURE-0001'], 0],
    ['secret findings only', () => ({ results: [] }), GITLEAKS_SAMPLE, 1, 'findings', [], 2],
  ])('with %s exits %s (%s)', async (_label, osvReport, gitleaksReport, code, verdict, failingIds, secretCount) => {
    const { result } = await scan({
      osvScan: osvPrints(osvReport(repo), code),
      gitleaksScan: gitleaksWrites(gitleaksReport, code),
    });
    expect(result.code).toBe(code);
    expect(result.summary.verdict).toBe(verdict);
    expect(result.summary.exitCode).toBe(code);
    expect(result.summary.dependencies.failing.flatMap((advisory) => advisory.ids)).toEqual(failingIds);
    expect(result.summary.secrets.findings).toBe(secretCount);
    expect(result.summary.error).toBeUndefined();
  });

  it.each<[string, Script, string, { osvScanner: string | null; gitleaks: string | null }]>([
    ['osv-scanner is not installed', { osvVersion: { reject: errno('ENOENT', 'osv-scanner') } }, 'osv-scanner: tool missing', { osvScanner: null, gitleaks: '8.30.1' }],
    ['gitleaks cannot be executed', { gitleaksVersion: { reject: errno('EACCES', 'gitleaks') } }, 'gitleaks: cannot run: spawn gitleaks EACCES', { osvScanner: '2.7.0', gitleaks: null }],
    ['the runner rejects with a non-Error', { osvVersion: { reject: 'terminated' } }, 'osv-scanner: cannot run: terminated', { osvScanner: null, gitleaks: '8.30.1' }],
    [
      'osv-scanner --version fails',
      { osvVersion: exited(2, '', '\u001b[31mERROR\u001b[0m unknown flag\n') },
      'osv-scanner --version exited 2: ERROR unknown flag',
      { osvScanner: null, gitleaks: '8.30.1' },
    ],
    [
      'osv-scanner is another release',
      { osvVersion: exited(0, 'osv-scanner version: 2.6.1\n') },
      'osv-scanner: wrong version 2.6.1, expected 2.7.0',
      { osvScanner: '2.6.1', gitleaks: '8.30.1' },
    ],
    [
      'gitleaks prints no version',
      { gitleaksVersion: exited(0, 'dev\n') },
      'gitleaks: wrong version unparseable, expected 8.30.1',
      { osvScanner: '2.7.0', gitleaks: null },
    ],
    [
      'neither tool is installed',
      { osvVersion: { reject: errno('ENOENT', 'osv-scanner') }, gitleaksVersion: { reject: errno('ENOENT', 'gitleaks') } },
      'osv-scanner: tool missing; gitleaks: tool missing',
      { osvScanner: null, gitleaks: null },
    ],
  ])('stops before scanning when %s', async (_label, script, error, tools) => {
    const { result, run, osvReport, gitleaksReport } = await scan(script);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(2);
    expect(result.summary).toMatchObject({ tools, verdict: 'error', exitCode: 2, error });
    expect(result.summary.dependencies.failing).toEqual([]);
    expect(result.summary.secrets.findings).toBe(0);
    expect(existsSync(osvReport)).toBe(false);
    expect(existsSync(gitleaksReport)).toBe(false);
    expect((await writtenSummary(result)).body).toEqual(result.summary);
  });

  it('keeps only the last 20 stderr lines, without colour codes, in a tool error', async () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
    const stderr = `${lines.map((line) => `\u001b[1;33m${line}\u001b[0m`).join('\n')}\n\n`;
    const { result } = await scan({ osvVersion: exited(1, '', stderr) });
    expect(result.summary.error).toBe(`osv-scanner --version exited 1: ${lines.slice(5).join('\n')}`);
  });

  it('names each missing lockfile and runs no scan', async () => {
    const partial = path.join(root, 'partial');
    const absent = ['web/package-lock.json', 'services/stub/package-lock.json'];
    for (const lockfile of OPT2_LOCKFILES.filter((file) => !absent.includes(file))) {
      await mkdir(path.dirname(path.join(partial, lockfile)), { recursive: true });
      await writeFile(path.join(partial, lockfile), '{}\n', 'utf8');
    }
    const { result, run } = await scan({ gitleaksVersion: { reject: errno('ENOENT', 'gitleaks') } }, { repoRoot: partial });
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.code).toBe(2);
    expect(result.summary.error).toBe(`missing lockfiles: ${absent.join(', ')}; gitleaks: tool missing`);
  });

  it.each<[string, Script, (osv: string, gitleaks: string) => string, 'exact' | 'prefix', string[], number]>([
    [
      'osv-scanner exits 127',
      { osvScan: exited(127, '', 'fatal: bad lockfile\n'), gitleaksScan: gitleaksWrites(GITLEAKS_SAMPLE, 1) },
      () => 'osv-scanner exited 127: fatal: bad lockfile',
      'exact',
      [],
      2,
    ],
    [
      'osv-scanner prints no JSON',
      { osvScan: exited(1, 'not json'), gitleaksScan: gitleaksWrites(GITLEAKS_SAMPLE, 1) },
      (osv) => `osv-scanner report ${osv}: ${jsonParseMessage('not json')}`,
      'exact',
      [],
      2,
    ],
    [
      'the osv-scanner report is off-schema',
      { osvScan: osvPrints({ results: [{ source: {} }] }, 0) },
      (osv) => `osv-scanner report ${osv}: osv-scanner report does not match its schema:\n`,
      'prefix',
      [],
      0,
    ],
    [
      'osv-scanner disappears after its version check',
      { osvScan: { reject: errno('ENOENT', 'osv-scanner') }, gitleaksScan: gitleaksWrites(GITLEAKS_SAMPLE, 1) },
      () => 'osv-scanner: tool missing',
      'exact',
      [],
      2,
    ],
    [
      'gitleaks exits 2',
      {
        osvScan: async () => exited(1, JSON.stringify(osvSample(repo))),
        gitleaksScan: exited(2, '', '\u001b[90m10:00AM\u001b[0m \u001b[31mFTL\u001b[0m bad config\n'),
      },
      () => 'gitleaks exited 2: 10:00AM FTL bad config',
      'exact',
      ['OSV-FIXTURE-0001'],
      0,
    ],
    [
      'gitleaks exits 1 without writing a report',
      { gitleaksScan: exited(1, '', 'FTL fatal\n') },
      (_osv, gitleaks) => `gitleaks report ${gitleaks}: ENOENT: no such file or directory, open '${gitleaks}'; gitleaks exited 1: FTL fatal`,
      'exact',
      [],
      0,
    ],
    [
      'the gitleaks report is off-schema',
      { gitleaksScan: gitleaksWrites({ findings: [] }, 0) },
      (_osv, gitleaks) => `gitleaks report ${gitleaks}: gitleaks report does not match its schema:\n`,
      'prefix',
      [],
      0,
    ],
    [
      'gitleaks cannot be executed for the scan',
      { gitleaksScan: { reject: errno('EACCES', 'gitleaks') } },
      () => 'gitleaks: cannot run: spawn gitleaks EACCES',
      'exact',
      [],
      0,
    ],
    [
      'both scans exit with tool errors',
      { osvScan: exited(3, '', 'osv down\n'), gitleaksScan: exited(126, '', 'gitleaks down\n') },
      () => 'osv-scanner exited 3: osv down; gitleaks exited 126: gitleaks down',
      'exact',
      [],
      0,
    ],
  ])('reports an error when %s, keeping the other scan', async (_label, script, expected, match, failingIds, secretCount) => {
    const { result, osvReport, gitleaksReport } = await scan(script);
    const error = expected(osvReport, gitleaksReport);
    expect(result.code).toBe(2);
    expect(result.summary.verdict).toBe('error');
    if (match === 'exact') expect(result.summary.error).toBe(error);
    else expect(result.summary.error?.startsWith(error), result.summary.error).toBe(true);
    expect(result.summary.dependencies.failing.flatMap((advisory) => advisory.ids)).toEqual(failingIds);
    expect(result.summary.secrets.findings).toBe(secretCount);
  });

  it('keeps the raw osv-scanner output as its report even when it is not JSON', async () => {
    const { osvReport } = await scan({ osvScan: exited(1, 'not json') });
    expect(await readFile(osvReport, 'utf8')).toBe('not json');
  });

  it('deletes the reports of an earlier run before checking anything', async () => {
    const state = await mkdtemp(path.join(root, 'state-'));
    const out = path.join(state, 'security');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, 'osv.json'), JSON.stringify(osvSample(repo)), 'utf8');
    await writeFile(path.join(out, 'gitleaks.json'), JSON.stringify(GITLEAKS_SAMPLE), 'utf8');
    const { result, osvReport, gitleaksReport } = await scan({ osvVersion: { reject: errno('ENOENT', 'osv-scanner') } }, { state });
    expect(result.code).toBe(2);
    expect(existsSync(osvReport)).toBe(false);
    expect(existsSync(gitleaksReport)).toBe(false);
  });

  it('never reads an earlier gitleaks report when gitleaks exits 1 without writing one', async () => {
    const state = await mkdtemp(path.join(root, 'state-'));
    await mkdir(path.join(state, 'security'), { recursive: true });
    await writeFile(path.join(state, 'security', 'gitleaks.json'), JSON.stringify(GITLEAKS_SAMPLE), 'utf8');
    const { result } = await scan({ gitleaksScan: exited(1) }, { state });
    expect(result.code).toBe(2);
    expect(result.summary.secrets.findings).toBe(0);
    expect(result.summary.error).toMatch(/^gitleaks report .*: ENOENT/);
  });

  it('reads OPT2_STATE_DIR from process.env and scans the checkout when no environment or root is given', async () => {
    const state = await mkdtemp(path.join(root, 'state-'));
    vi.stubEnv('OPT2_STATE_DIR', state);
    const run = scriptedRunner();
    const result = await runSecurityScan({ run });
    expect(result.code).toBe(0);
    expect(result.summaryPath).toBe(path.join(state, 'security', 'summary.json'));
    expect(run.mock.calls.map((call) => call[2])).toEqual([
      { cwd: REPO_ROOT, timeoutMs: VERSION_PROBE_TIMEOUT_MS },
      { cwd: REPO_ROOT, timeoutMs: VERSION_PROBE_TIMEOUT_MS },
      { cwd: REPO_ROOT, timeoutMs: SCAN_TIMEOUT_MS },
      { cwd: REPO_ROOT, timeoutMs: SCAN_TIMEOUT_MS },
    ]);
  });

  it.each<[keyof Script, string, number]>([
    ['osvVersion', 'osv-scanner: timed out after 60000 ms', 2],
    ['gitleaksVersion', 'gitleaks: timed out after 60000 ms', 2],
    ['osvScan', 'osv-scanner: timed out after 900000 ms', 4],
    ['gitleaksScan', 'gitleaks: timed out after 900000 ms', 4],
  ])('writes an error summary naming the budget when the %s step times out', async (step, error, calls) => {
    const { result, run } = await scan({ [step]: { reject: timedOut(step.startsWith('osv') ? 'osv-scanner' : 'gitleaks') } });
    expect(run).toHaveBeenCalledTimes(calls);
    expect(result.code).toBe(2);
    expect(result.summary).toMatchObject({ verdict: 'error', exitCode: 2, error });
    expect((await writtenSummary(result)).body).toEqual(result.summary);
  });

  it('settles with an error summary when a real tool stalls past its budget', async () => {
    const bin = await mkdtemp(path.join(root, 'bin-'));
    await writeFile(
      path.join(bin, 'osv-scanner'),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo 'osv-scanner version: ${OSV_SCANNER_VERSION}'; else echo '{"results":[]}'; fi\n`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, 'gitleaks'),
      `#!/bin/sh\nif [ "$1" = version ]; then echo '${GITLEAKS_VERSION}'; else exec sleep 600; fi\n`,
      { mode: 0o755 },
    );
    const state = await mkdtemp(path.join(root, 'state-'));
    const run: ToolRunner = (command, args, opts) => defaultToolRunner(path.join(bin, command), args, { ...opts, timeoutMs: 2_000 });
    const started = Date.now();
    const result = await runSecurityScan({ run, env: { OPT2_STATE_DIR: state }, repoRoot: repo });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(result.code).toBe(2);
    expect(result.summary).toMatchObject({
      tools: { osvScanner: OSV_SCANNER_VERSION, gitleaks: GITLEAKS_VERSION },
      verdict: 'error',
      exitCode: 2,
      error: `gitleaks: timed out after ${SCAN_TIMEOUT_MS} ms`,
    });
    expect(await readFile(path.join(state, 'security', 'osv.json'), 'utf8')).toBe('{"results":[]}\n');
    expect((await writtenSummary(result)).body).toEqual(result.summary);
  });
});

describe('main', () => {
  it('returns the scan code and the summary line fields', async () => {
    const state = await mkdtemp(path.join(root, 'state-'));
    const run = scriptedRunner({ osvScan: osvPrints(osvSample(repo), 1), gitleaksScan: gitleaksWrites(GITLEAKS_SAMPLE, 1) });
    const outcome = await main([], { run, env: { OPT2_STATE_DIR: state }, repoRoot: repo });
    expect(outcome).toEqual({
      code: 1,
      summary: {
        verdict: 'findings',
        exitCode: 1,
        productionHighCritical: 1,
        secretFindings: 2,
        summaryPath: path.join(state, 'security', 'summary.json'),
      },
    });
  });

  it('adds the error as the reason when the scan cannot complete', async () => {
    const state = await mkdtemp(path.join(root, 'state-'));
    const run = scriptedRunner({ gitleaksVersion: { reject: errno('ENOENT', 'gitleaks') } });
    const outcome = await main([], { run, env: { OPT2_STATE_DIR: state }, repoRoot: repo });
    expect(outcome).toMatchObject({ code: 2, summary: { verdict: 'error', exitCode: 2, reason: 'gitleaks: tool missing' } });
  });

  it.each([[['--json']], [['extra']]])('rejects arguments %j with its usage before running any tool', async (argv) => {
    const run = scriptedRunner();
    await expect(main(argv, { run, env: { OPT2_STATE_DIR: root }, repoRoot: repo })).rejects.toThrowError(UsageError);
    await expect(main(argv)).rejects.toMatchObject({ usage: 'security:scan (takes no arguments)' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('defaultToolRunner', () => {
  const node = process.execPath;

  it('resolves exit 0 with UTF-8 stdout and stderr, run in the given directory', async () => {
    const script = "process.stdout.write(process.cwd()); process.stderr.write('\\u00e9')";
    expect(await defaultToolRunner(node, ['-e', script], { cwd: root })).toEqual({
      code: 0,
      stdout: realpathSync(root),
      stderr: '\u00e9',
    });
  });

  it('resolves a non-zero exit with its output', async () => {
    const script = "process.stdout.write('partial'); process.stderr.write('failed'); process.exit(3)";
    expect(await defaultToolRunner(node, ['-e', script], { cwd: root })).toEqual({ code: 3, stdout: 'partial', stderr: 'failed' });
  });

  it('rejects with ENOENT when the tool is not installed', async () => {
    await expect(defaultToolRunner('opt2-security-scan-no-such-tool', ['version'], { cwd: root })).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects when the tool is killed by a signal', async () => {
    await expect(
      defaultToolRunner(node, ['-e', "process.kill(process.pid, 'SIGKILL')"], { cwd: root }),
    ).rejects.toMatchObject({ signal: 'SIGKILL' });
  });

  it('kills a tool that outlives timeoutMs and rejects with ETIMEDOUT', async () => {
    const started = Date.now();
    await expect(
      defaultToolRunner(node, ['-e', 'setInterval(() => {}, 1000)'], { cwd: root, timeoutMs: 200 }),
    ).rejects.toMatchObject({
      code: 'ETIMEDOUT',
      message: `${node} timed out after 200 ms`,
      cause: { killed: true, signal: 'SIGKILL' },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
