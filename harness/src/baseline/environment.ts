import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { UsageError, isMainModule, parseFlags, runCli, type CliOutcome } from '../lib/cli.js';
import { createHttpSession } from '../lib/http.js';
import { createReadOnlyMssql } from '../lib/mssql.js';
import { pristineDir, reportsDir, type EnvLike } from '../lib/paths.js';
import { createCatalogClient } from '../lib/pg.js';
import { stableStringify, writeMarkdown } from '../lib/report.js';
import { baselineStateDir, legacyOrigin, lowerKeysDeep } from './run.js';

/** Tool and runtime versions the plan pins, in the order the environment record lists them. */
export const PLANNED_PINS = {
  node: '22.23.4',
  npm: '11.21.0',
  terraform: '1.17.1',
  googleProvider: '8.9.0',
  otelcolContrib: 'v0.164.0',
  postgresql: '16',
  typescript: '5.9.3',
} as const;

/** Pins no probe of this command reads, with the file that pins each. */
export const UNPROBED_PINS = [
  { name: 'TypeScript', version: PLANNED_PINS.typescript, pinnedIn: '`harness/package.json`', why: 'installed by `npm ci` after `--phase local`' },
  { name: 'provider hashicorp/google', version: PLANNED_PINS.googleProvider, pinnedIn: '`infra/terraform/envs/plan/versions.tf`', why: 'selected by `terraform init`' },
] as const;

/** `--phase` value: `local` before any service runs, `services` once legacy and the target tooling are up. */
export type Phase = 'local' | 'services';

/** Outcome of one tool command; `error` is set only when the command did not run to an exit. */
export type CommandResult = { ok: boolean; code: number | null; stdout: string; stderr: string; error?: string };

/** Runs a tool without a shell; never rejects. */
export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>;

/** One recorded row of a probe table. */
export type ProbeRow = {
  id: string;
  label: string;
  source: string;
  planned: string;
  recorded: string | null;
  status: 'ok' | 'mismatch' | 'unavailable';
  detail: string | null;
};

/** Rows one phase recorded, with the time it ran. */
export type PhaseBlock = { recordedAt: string; probes: ProbeRow[] };

/** Start-up guard inputs: Masa writes `tclustercommands` rows only while broadcasting is on and other peers exist. */
export type ClusterSettings = {
  broadcastClusterCommands: boolean | null;
  broadcastCachePurges: boolean | null;
  broadcastAppreloads: boolean | null;
  /** Peers other than the running instance. */
  peerCount: number | null;
  tclustercommandsCount: number | null;
  broadcastingOff: boolean;
  noPeers: boolean;
  clusterSafe: boolean;
};

/** Scheduled-task capture `up.sh` takes before the first OPT-2 start of ColdFusion. */
export type NativeTaskCapture = {
  status: 'captured' | 'absent' | 'unreadable';
  originalPing: boolean | null;
  siteMonitorTask: string | null;
  detail: string | null;
};

/** Settings recorded by `--phase services`; `up.sh` reads `timeZone`, `ping` and `mysqlFallback`. */
export type EnvironmentSettings = {
  timeZone: string | null;
  utcTotalOffset: number | null;
  processTz: string | null;
  timeZoneMatchesProcess: boolean;
  ping: boolean | null;
  siteMonitorTaskRegistered: boolean | null;
  nativeTasks: NativeTaskCapture;
  cluster: ClusterSettings;
  dbtype: string;
  mysqlFallback: boolean;
  deviation: boolean;
  deviationReason: string | null;
  edition: string | null;
  expiration: string | null;
  defaultHashAlgorithm: string | null;
};

/** Merged state of both phases, kept in `<state>/baseline/environment.json`. */
export type EnvironmentRecord = {
  local: PhaseBlock | null;
  services: PhaseBlock | null;
  settings: EnvironmentSettings | null;
};

/** What `probeLocal` returns; `failed` names the asserted probes that did not match their pin. */
export type LocalResult = { local: PhaseBlock; failed: string[] };

/** What `probeServices` returns; `failed` names the required probes that could not be read. */
export type ServicesResult = { services: PhaseBlock; settings: EnvironmentSettings; failed: string[] };

/** Section lines kept verbatim from an existing report, by section. */
export type PreservedSections = Partial<Record<'local' | 'services' | 'settings', readonly string[]>>;

/** Injectable process boundary; every field defaults to the real one. */
export type EnvironmentDeps = {
  env?: EnvLike;
  runCommand?: CommandRunner;
  fetch?: typeof fetch;
  mssqlFactory?: typeof createReadOnlyMssql;
  pgFactory?: typeof createCatalogClient;
  now?: () => Date;
};

/** Fields of the summary line `runCli` prints. */
export type EnvironmentSummary = {
  phase: Phase;
  status: 'pending-run' | 'partial' | 'recorded' | 'deviation';
  deviations: string[];
  failed: string[];
  mysqlFallback: boolean | null;
  clusterSafe: boolean | null;
  ping: boolean | null;
  timeZone: string | null;
};

/** Longest wait for one tool probe; `box` starts a JVM. */
export const PROBE_TIMEOUT_MS = 120_000;

/** `execFile` runner with stdin closed and a {@link PROBE_TIMEOUT_MS} deadline. */
export const defaultCommandRunner: CommandRunner = (cmd, args) =>
  new Promise((resolve) => {
    const done = (error: string | undefined, code: number | null, stdout = '', stderr = ''): void =>
      resolve({ ok: error === undefined && code === 0, code, stdout, stderr, ...(error === undefined ? {} : { error }) });
    try {
      const child = execFile(
        cmd,
        args,
        { encoding: 'utf8', shell: false, timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => {
          if (err === null) done(undefined, 0, stdout, stderr);
          else if (err.code === 'ENOENT') done('not found', null, stdout, stderr);
          else if (typeof err.code === 'number') done(undefined, err.code, stdout, stderr);
          // A string code (EACCES, output over maxBuffer) is not the deadline, which leaves code unset.
          else if (typeof err.code !== 'string' && err.killed === true) done(`timed out after ${PROBE_TIMEOUT_MS} ms`, null, stdout, stderr);
          else done(err.message, null, stdout, stderr);
        },
      );
      child.stdin?.end();
    } catch (err) {
      done((err as Error).message, null);
    }
  });

/** One local tool probe: the command, its report cells, and how its output is read and judged. */
export type LocalProbe = {
  id: string;
  label: string;
  /** Probe cell of the report. */
  probe: string;
  /** Pinned / expected cell of the report. */
  planned: string;
  command: string;
  args: readonly string[];
  /** Version text from the tool's output, or undefined when the output is not recognised. */
  parse(stdout: string, stderr: string): string | undefined;
  /** Whether the recorded version satisfies the pin; absent when nothing is pinned. */
  matches?(recorded: string): boolean;
  /** Extra note on a recorded version, such as a cross-check. */
  note?(recorded: string): string | undefined;
};

/** ColdFusion's JVM, `jvm.javaHome` in `harness/repro/server.json.template`. */
const COLDFUSION_JAVA = '/usr/lib/jvm/java-17-openjdk-amd64/bin/java';
const COLDFUSION_JAVA_MAJOR = '17';

function lines(text: string): string[] {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function withoutV(version: string): string {
  return version.replace(/^v/i, '');
}

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function javaMajor(line: string): string | undefined {
  return /version\s+"(?:1\.)?(\d+)/i.exec(line)?.[1];
}

/** First stderr line of `java -version`, skipping a leading `Picked up JAVA_TOOL_OPTIONS` notice. */
function javaVersionLine(stderr: string): string | undefined {
  const output = lines(stderr);
  return output.find((line) => /\bversion\b/i.test(line)) ?? output[0];
}

function firstVersion(text: string): string | undefined {
  return /(\d+(?:\.\d+)+)/.exec(text)?.[1];
}

/** Local tool probes, in report order. */
export const LOCAL_PROBES: readonly LocalProbe[] = [
  {
    id: 'node',
    label: 'Node.js',
    probe: '`node -v`',
    planned: PLANNED_PINS.node,
    command: 'node',
    args: ['-v'],
    parse: (stdout) => lines(stdout)[0],
    matches: (recorded) => withoutV(recorded) === PLANNED_PINS.node && withoutV(process.version) === PLANNED_PINS.node,
    note: (recorded) => (process.version === recorded ? undefined : `this process runs ${process.version}`),
  },
  {
    id: 'npm',
    label: 'npm',
    probe: '`npm -v`',
    planned: PLANNED_PINS.npm,
    command: 'npm',
    args: ['-v'],
    parse: (stdout) => lines(stdout)[0],
    matches: (recorded) => recorded === PLANNED_PINS.npm,
  },
  {
    id: 'terraform',
    label: 'Terraform',
    probe: '`terraform version`',
    planned: `${PLANNED_PINS.terraform} (provider hashicorp/google ${PLANNED_PINS.googleProvider})`,
    command: 'terraform',
    args: ['version', '-json'],
    parse: (stdout) => {
      const version = jsonObject(stdout)?.terraform_version;
      return typeof version === 'string' ? version : undefined;
    },
    matches: (recorded) => withoutV(recorded) === PLANNED_PINS.terraform,
  },
  {
    id: 'otelcol-contrib',
    label: 'OpenTelemetry Collector',
    probe: '`otelcol-contrib --version`',
    planned: PLANNED_PINS.otelcolContrib,
    command: 'otelcol-contrib',
    args: ['--version'],
    parse: (stdout, stderr) => /version\s+(v?\d+(?:\.\d+)+\S*)/i.exec(`${stdout}\n${stderr}`)?.[1],
    matches: (recorded) => withoutV(recorded) === withoutV(PLANNED_PINS.otelcolContrib),
  },
  {
    id: 'gcloud',
    label: 'Google Cloud CLI (Pub/Sub emulator)',
    probe: '`gcloud version`',
    planned: '—',
    command: 'gcloud',
    args: ['version', '--format=json'],
    parse: (stdout) => {
      const versions = jsonObject(stdout);
      const sdk = versions?.['Google Cloud SDK'];
      if (typeof sdk !== 'string') return undefined;
      const emulator = versions?.['pubsub-emulator'];
      return `Google Cloud SDK ${sdk}; pubsub-emulator ${typeof emulator === 'string' ? emulator : 'not installed'}`;
    },
  },
  {
    id: 'box',
    label: 'CommandBox',
    probe: '`box version`',
    planned: '—',
    command: 'box',
    args: ['version'],
    parse: (stdout, stderr) => lines(`${stdout}\n${stderr}`).find((line) => /\d+\.\d+\.\d+/.test(line)),
  },
  {
    id: 'java',
    label: 'Java (default CLI JVM)',
    probe: '`java -version`',
    planned: '—',
    command: 'java',
    args: ['-version'],
    parse: (_stdout, stderr) => javaVersionLine(stderr),
  },
  {
    id: 'java-coldfusion',
    label: 'Java (ColdFusion JVM)',
    probe: `\`${COLDFUSION_JAVA} -version\` (\`jvm.javaHome\` in \`harness/repro/server.json.template\`)`,
    planned: COLDFUSION_JAVA_MAJOR,
    command: COLDFUSION_JAVA,
    args: ['-version'],
    parse: (_stdout, stderr) => javaVersionLine(stderr),
    matches: (recorded) => javaMajor(recorded) === COLDFUSION_JAVA_MAJOR,
  },
  {
    id: 'sqlcmd',
    label: 'sqlcmd',
    probe: '`sqlcmd -?` version line',
    planned: '—',
    command: 'sqlcmd',
    args: ['-?'],
    parse: (stdout, stderr) => {
      const output = lines(`${stdout}\n${stderr}`);
      return output.find((line) => /version/i.test(line)) ?? output[0];
    },
  },
  {
    id: 'psql',
    label: 'PostgreSQL client',
    probe: '`psql --version`',
    planned: `${PLANNED_PINS.postgresql}.x`,
    command: 'psql',
    args: ['--version'],
    parse: (stdout) => firstVersion(lines(stdout)[0] ?? ''),
    matches: (recorded) => recorded.split('.')[0] === PLANNED_PINS.postgresql,
  },
];

/** Probes whose pin `--phase local` asserts. */
const ASSERTED_LOCAL = new Set(['node', 'npm']);

function clock(deps: EnvironmentDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

function envValue(env: EnvLike, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** Contents of `file`, or null when it does not exist. */
async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

/** The row `probe` records for `result`. */
function localRow(probe: LocalProbe, result: CommandResult): ProbeRow {
  const base = { id: probe.id, label: probe.label, source: probe.probe, planned: probe.planned };
  if (result.error !== undefined) return { ...base, recorded: null, status: 'unavailable', detail: result.error };
  const recorded = probe.parse(result.stdout, result.stderr);
  if (recorded === undefined) {
    return { ...base, recorded: null, status: 'unavailable', detail: `unrecognised output (exit ${String(result.code)})` };
  }
  const notes = [result.ok ? undefined : `exit ${String(result.code)}`, probe.note?.(recorded)].filter(
    (note): note is string => note !== undefined,
  );
  const status = probe.matches === undefined || probe.matches(recorded) ? 'ok' : 'mismatch';
  return { ...base, recorded, status, detail: notes.length > 0 ? notes.join('; ') : null };
}

/** Runs every {@link LOCAL_PROBES} command once, in order. */
export async function probeLocal(deps: EnvironmentDeps = {}): Promise<LocalResult> {
  const run = deps.runCommand ?? defaultCommandRunner;
  const recordedAt = clock(deps).toISOString();
  const probes: ProbeRow[] = [];
  for (const probe of LOCAL_PROBES) probes.push(localRow(probe, await run(probe.command, [...probe.args])));
  const failed = probes.filter((row) => ASSERTED_LOCAL.has(row.id) && row.status !== 'ok').map((row) => row.id);
  return { local: { recordedAt, probes }, failed };
}

/** Report cells of one services-phase row. */
type RowSpec = { id: string; label: string; source: string; planned: string };

const INFO_PATH = '/harness/legacy-baseline/cfml/run.cfm?info=1';
const INFO_SOURCE = '`harness/legacy-baseline/cfml/run.cfm?info=1`';
const DEFAULT_MAILPIT_API = 'http://127.0.0.1:8025';
/** `cfpm` packages the fixtures need: `cfspreadsheet`, `cfdocument`, `cfmail` and `cfschedule`. */
const REQUIRED_CFPM = ['spreadsheet', 'document', 'mail', 'scheduler'] as const;

/** Services-phase rows, in report order; `testbox` and `java` follow the committed report's own rows, which stay unchanged. */
const SERVICE_ROWS = {
  coldfusion: {
    id: 'coldfusion',
    label: 'ColdFusion product version and level',
    source: `${INFO_SOURCE} (\`server.coldfusion.productversion\`, \`productlevel\`)`,
    planned: 'Adobe ColdFusion 2023',
  },
  edition: {
    id: 'coldfusion-edition',
    label: 'ColdFusion edition',
    source: INFO_SOURCE,
    planned: 'Trial reverts to developer edition after 30 days',
  },
  cfpm: {
    id: 'cfpm',
    label: '`cfpm` packages',
    source: `${INFO_SOURCE} package list`,
    planned:
      'Includes `spreadsheet` (`cfspreadsheet`) and `document` (`cfdocument`), plus `mail` and `scheduler`, which `legacy-fixtures/load-fixtures.sh` also checks',
  },
  sqlserver: { id: 'sqlserver', label: 'SQL Server', source: '`SELECT @@VERSION`', planned: 'SQL Server 2022' },
  postgresql: {
    id: 'postgresql',
    label: 'PostgreSQL server',
    source: '`SELECT version()`',
    planned: `${PLANNED_PINS.postgresql}.x (CI image \`postgres:16.15\`)`,
  },
  mailpit: { id: 'mailpit', label: 'Mailpit', source: '`GET /api/v1/info` on 127.0.0.1:8025', planned: 'SMTP 127.0.0.1:1025' },
  testbox: {
    id: 'testbox',
    label: 'TestBox',
    source: `${INFO_SOURCE} (\`testbox\` setting, \`/testbox\` mapping)`,
    planned: 'enabled and installed (`MURA_TESTBOX=true`)',
  },
  java: {
    id: 'coldfusion-java',
    label: 'Java (ColdFusion runtime)',
    source: `${INFO_SOURCE} (\`java.version\`)`,
    planned: COLDFUSION_JAVA_MAJOR,
  },
} as const satisfies Record<string, RowSpec>;

function text(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && /^(true|yes)$/i.test(value)) return true;
  if (typeof value === 'string' && /^(false|no)$/i.test(value)) return false;
  return null;
}

function count(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

function row(spec: RowSpec, recorded: string, ok: boolean, detail: string | null = null): ProbeRow {
  return { ...spec, recorded, status: ok ? 'ok' : 'mismatch', detail };
}

function unavailable(spec: RowSpec, detail: string): ProbeRow {
  return { ...spec, recorded: null, status: 'unavailable', detail };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
}

/** JSON body of a 200 answer to `GET <baseUrl><pathAndQuery>`. */
async function getJson(baseUrl: string, pathAndQuery: string, fetchImpl: EnvironmentDeps['fetch']): Promise<unknown> {
  const session = createHttpSession({ baseUrl, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  const res = await session.get(pathAndQuery);
  if (res.status !== 200) throw new Error(`GET ${new URL(baseUrl).origin}${pathAndQuery} answered HTTP ${res.status}`);
  return res.json();
}

/** Check one `run.cfm?info=1` value must pass; `parent` is the object that holds it. */
type FieldCheck = (value: unknown, parent: Record<string, unknown>) => boolean;

const hasText = (value: unknown): boolean => (text(value) ?? '').trim() !== '';
const isFlag = (value: unknown): boolean => flag(value) !== null;
const isCount = (value: unknown): boolean => count(value) !== null;

/** Required top-level fields of the `run.cfm?info=1` answer, by producer name. */
const INFO_FIELDS: Readonly<Record<string, FieldCheck>> = {
  productVersion: hasText,
  productLevel: hasText,
  edition: hasText,
  javaVersion: hasText,
  testboxEnabled: isFlag,
  testboxInstalled: isFlag,
  ping: isFlag,
  siteMonitorTaskRegistered: isFlag,
  timeZone: (value) => typeof value === 'string' && hasText(value),
  utcTotalOffset: isCount,
  cfpmPackages: (value, parent) =>
    Array.isArray(value) ? value.every((line) => text(line) !== null) : value === null && hasText(parent.cfpmerror),
  cluster: isRecord,
};

/** Required fields of the answer's `cluster` object, by producer name. */
const CLUSTER_FIELDS: Readonly<Record<string, FieldCheck>> = {
  broadcastClusterCommands: isFlag,
  broadcastCachePurges: isFlag,
  broadcastAppreloads: isFlag,
  peerCount: isCount,
};

/** Producer names of the required fields the lower-cased `info` answer lacks or mistypes. */
function malformedInfo(info: Record<string, unknown>): string[] {
  const bad = (fields: Readonly<Record<string, FieldCheck>>, parent: Record<string, unknown>, prefix: string): string[] =>
    Object.entries(fields)
      .filter(([name, valid]) => !valid(parent[name.toLowerCase()], parent))
      .map(([name]) => `${prefix}${name}`);
  return [...bad(INFO_FIELDS, info, ''), ...(isRecord(info.cluster) ? bad(CLUSTER_FIELDS, info.cluster, 'cluster.') : [])];
}

/** `harness/legacy-baseline/cfml/run.cfm?info=1`, read direct from legacy, with lower-cased keys. */
async function legacyInfo(env: EnvLike, fetchImpl: EnvironmentDeps['fetch']): Promise<Record<string, unknown>> {
  const info = lowerKeysDeep(await getJson(legacyOrigin(env), INFO_PATH, fetchImpl));
  if (!isRecord(info)) throw new Error(`${INFO_PATH} did not answer a JSON object`);
  return info;
}

/** `${OPT2_PRISTINE_DIR}/native-tasks.json`, the scheduled-task capture `up.sh` takes on its first run. */
async function nativeTaskCapture(env: EnvLike): Promise<NativeTaskCapture> {
  const none = { originalPing: null, siteMonitorTask: null };
  let file: string;
  let raw: string | null;
  try {
    file = path.join(pristineDir(env), 'native-tasks.json');
    raw = await readOptional(file);
  } catch (err) {
    return { status: 'unreadable', ...none, detail: errorText(err) };
  }
  if (raw === null) return { status: 'absent', ...none, detail: 'native-tasks.json absent' };
  const capture = jsonObject(raw);
  const originalPing = flag(capture?.originalPing);
  if (capture === undefined || originalPing === null) {
    return { status: 'unreadable', ...none, detail: `${file} holds no boolean originalPing` };
  }
  return { status: 'captured', originalPing, siteMonitorTask: text(capture.siteMonitorTask), detail: null };
}

/** `@@VERSION` and the `tclustercommands` row count, over one read-only connection that is always closed. */
async function sqlServerFacts(
  env: EnvLike,
  factory: typeof createReadOnlyMssql,
): Promise<{ version: string; clusterCommands: number }> {
  const client = await factory(env);
  try {
    const [versionRow] = await client.readOnlyQuery<{ version: unknown }>('SELECT @@VERSION AS version');
    const [countRow] = await client.readOnlyQuery<{ n: unknown }>('SELECT COUNT(*) AS n FROM tclustercommands');
    const version = text(versionRow?.version);
    const clusterCommands = count(countRow?.n);
    if (version === null) throw new Error('SELECT @@VERSION returned no version');
    if (clusterCommands === null) throw new Error('SELECT COUNT(*) FROM tclustercommands returned no count');
    return { version: version.replace(/\s+/g, ' ').trim(), clusterCommands };
  } finally {
    await client.close();
  }
}

/** PostgreSQL `version()`, over one read-only catalog connection that is always closed. */
async function postgresVersion(env: EnvLike, factory: typeof createCatalogClient): Promise<string> {
  const client = await factory(env);
  try {
    const [versionRow] = await client.query<{ version: unknown }>('SELECT version() AS version');
    const version = text(versionRow?.version);
    if (version === null) throw new Error('SELECT version() returned no version');
    return version;
  } finally {
    await client.close();
  }
}

/** Mailpit `Version` from `/api/v1/info`. */
async function mailpitVersion(api: string, fetchImpl: EnvironmentDeps['fetch']): Promise<string> {
  const info = await getJson(api, '/api/v1/info', fetchImpl);
  const version = isRecord(info) ? text(info.Version) : null;
  if (version === null) throw new Error('GET /api/v1/info answered no Version');
  return version;
}

/** Rows read from the legacy info probe; every row is unavailable when the probe failed. */
function infoRows(info: Attempt<Record<string, unknown>>): Record<'coldfusion' | 'edition' | 'cfpm' | 'testbox' | 'java', ProbeRow> {
  if (!info.ok) {
    return {
      coldfusion: unavailable(SERVICE_ROWS.coldfusion, info.error),
      edition: unavailable(SERVICE_ROWS.edition, info.error),
      cfpm: unavailable(SERVICE_ROWS.cfpm, info.error),
      testbox: unavailable(SERVICE_ROWS.testbox, info.error),
      java: unavailable(SERVICE_ROWS.java, info.error),
    };
  }
  const v = info.value;
  const productVersion = text(v.productversion);
  const edition = text(v.edition);
  const enabled = flag(v.testboxenabled);
  const installed = flag(v.testboxinstalled);
  const javaVersion = text(v.javaversion);
  const packages = Array.isArray(v.cfpmpackages) ? v.cfpmpackages.map(text).filter((p): p is string => p !== null) : null;
  const missing = REQUIRED_CFPM.filter((name) => !packages?.some((line) => new RegExp(`^${name}\\b`, 'i').test(line)));
  return {
    coldfusion:
      productVersion === null
        ? unavailable(SERVICE_ROWS.coldfusion, 'no productVersion in the answer')
        : row(
            SERVICE_ROWS.coldfusion,
            `${text(v.productname) ?? 'ColdFusion'} ${productVersion} (${text(v.productlevel) ?? 'level unknown'})`,
            /^2023\b/.test(productVersion),
          ),
    edition:
      edition === null
        ? unavailable(SERVICE_ROWS.edition, 'no edition in the answer')
        : row(SERVICE_ROWS.edition, `${edition}; expiration ${text(v.expiration) ?? 'none'}`, true),
    cfpm:
      packages === null
        ? unavailable(SERVICE_ROWS.cfpm, text(v.cfpmerror) ?? 'no package list in the answer')
        : row(
            SERVICE_ROWS.cfpm,
            packages.length > 0 ? packages.join('; ') : 'none',
            missing.length === 0,
            missing.length === 0 ? null : `missing: ${missing.join(', ')}`,
          ),
    testbox:
      enabled === null && installed === null
        ? unavailable(SERVICE_ROWS.testbox, 'no testbox flags in the answer')
        : row(SERVICE_ROWS.testbox, `enabled ${String(enabled)}; installed ${String(installed)}`, enabled === true && installed === true),
    java:
      javaVersion === null
        ? unavailable(SERVICE_ROWS.java, 'no javaVersion in the answer')
        : row(SERVICE_ROWS.java, javaVersion, /^(?:1\.)?(\d+)/.exec(javaVersion)?.[1] === COLDFUSION_JAVA_MAJOR),
  };
}

function dbtypeDeviation(dbtype: string): string {
  const which = dbtype === 'mysql' ? 'the MySQL fallback is in use' : dbtype === 'unset' ? 'MURA_DBTYPE is unset' : `MURA_DBTYPE is ${dbtype}`;
  return `${which}: a baseline deviation, and the migration stages stop, because SQL Server (mssql) is the only supported source`;
}

/** Reads legacy, SQL Server, PostgreSQL and Mailpit versions, and the settings `up.sh` and the start-up guard use. */
export async function probeServices(deps: EnvironmentDeps = {}): Promise<ServicesResult> {
  const env = deps.env ?? process.env;
  const recordedAt = clock(deps).toISOString();
  const dbtype = (envValue(env, 'MURA_DBTYPE') ?? 'unset').toLowerCase();
  const onMssql = dbtype === 'mssql';
  const mailpitApi = envValue(env, 'MAILPIT_API_URL') ?? DEFAULT_MAILPIT_API;

  const info = await attempt(() => legacyInfo(env, deps.fetch));
  const malformed = info.ok ? malformedInfo(info.value) : [];
  const sql = onMssql ? await attempt(() => sqlServerFacts(env, deps.mssqlFactory ?? createReadOnlyMssql)) : null;
  const pg = await attempt(() => postgresVersion(env, deps.pgFactory ?? createCatalogClient));
  const mailpit = await attempt(() => mailpitVersion(mailpitApi, deps.fetch));
  const nativeTasks = await nativeTaskCapture(env);

  const fromInfo = infoRows(info);
  const coldfusion =
    malformed.length === 0
      ? fromInfo.coldfusion
      : { ...fromInfo.coldfusion, detail: why([fromInfo.coldfusion.detail, `run.cfm?info=1 lacks or mistypes: ${malformed.join(', ')}`]) };
  const probes: ProbeRow[] = [
    coldfusion,
    fromInfo.edition,
    fromInfo.cfpm,
    sql === null
      ? unavailable(SERVICE_ROWS.sqlserver, `dbtype ${dbtype}`)
      : sql.ok
        ? row(SERVICE_ROWS.sqlserver, sql.value.version, /SQL Server 2022\b/.test(sql.value.version))
        : unavailable(SERVICE_ROWS.sqlserver, sql.error),
    pg.ok
      ? row(SERVICE_ROWS.postgresql, pg.value, new RegExp(`^PostgreSQL ${PLANNED_PINS.postgresql}\\b`).test(pg.value))
      : unavailable(SERVICE_ROWS.postgresql, pg.error),
    mailpit.ok
      ? row(SERVICE_ROWS.mailpit, mailpit.value, true, mailpitApi === DEFAULT_MAILPIT_API ? null : `at ${new URL(mailpitApi).origin}`)
      : unavailable(SERVICE_ROWS.mailpit, mailpit.error),
    fromInfo.testbox,
    fromInfo.java,
  ];
  const failed: string[] = [
    info.ok && malformed.length === 0 ? null : SERVICE_ROWS.coldfusion.id,
    sql === null || sql.ok ? null : SERVICE_ROWS.sqlserver.id,
    pg.ok ? null : SERVICE_ROWS.postgresql.id,
    mailpit.ok ? null : SERVICE_ROWS.mailpit.id,
  ].filter((id) => id !== null);

  const v = info.ok ? info.value : {};
  const cluster = isRecord(v.cluster) ? v.cluster : {};
  const broadcastClusterCommands = flag(cluster.broadcastclustercommands);
  const peerCount = count(cluster.peercount);
  const tclustercommandsCount = sql?.ok === true ? sql.value.clusterCommands : null;
  const broadcastingOff = broadcastClusterCommands === false;
  const noPeers = peerCount === 0;
  const timeZone = text(v.timezone);
  const processTz = envValue(env, 'TZ') ?? null;
  const settings: EnvironmentSettings = {
    timeZone,
    utcTotalOffset: count(v.utctotaloffset),
    processTz,
    timeZoneMatchesProcess: timeZone !== null && processTz === timeZone,
    ping: flag(v.ping),
    siteMonitorTaskRegistered: flag(v.sitemonitortaskregistered),
    nativeTasks,
    cluster: {
      broadcastClusterCommands,
      broadcastCachePurges: flag(cluster.broadcastcachepurges),
      broadcastAppreloads: flag(cluster.broadcastappreloads),
      peerCount,
      tclustercommandsCount,
      broadcastingOff,
      noPeers,
      clusterSafe: (broadcastingOff || noPeers) && tclustercommandsCount === 0,
    },
    dbtype,
    mysqlFallback: dbtype === 'mysql',
    deviation: !onMssql,
    deviationReason: onMssql ? null : dbtypeDeviation(dbtype),
    edition: text(v.edition),
    expiration: text(v.expiration),
    defaultHashAlgorithm: envValue(env, 'MURA_DEFAULTHASHALGORITHM') ?? null,
  };
  return { services: { recordedAt, probes }, settings, failed };
}

/** `existing` with the blocks `phase` owns replaced from `result`; `settings` belongs to `services`. */
export function mergeRecord(existing: EnvironmentRecord, phase: Phase, result: Partial<EnvironmentRecord>): EnvironmentRecord {
  return phase === 'local'
    ? { ...existing, local: result.local ?? null }
    : { ...existing, services: result.services ?? null, settings: result.settings ?? null };
}

const REPORT_TITLE = 'Environment record';
const PENDING = 'pending-run';
const GENERATED_BY = 'harness/src/baseline/environment.ts (--phase local, then --phase services)';
const ORACLE_NOTE =
  'The tech spec\'s "Runtime" lists only Lucee 5 and ACF 2016 sandboxes; this run\'s legacy oracle is the existing Masa 7.6.1 install on Adobe ColdFusion 2023 with SQL Server 2022, reused and never reinstalled. A MySQL fallback, if used, is a baseline deviation and stops the migration stages, because SQL Server is the only supported source.';
const HEADINGS = {
  local: '## Local phase (`--phase local`)',
  services: '## Services phase (`--phase services`)',
  settings: '## Settings',
} as const;
const PROBE_HEADER = ['| Component | Probe | Pinned / expected | Recorded |', '|---|---|---|---|'];
const SETTINGS_HEADER = ['| Setting | Source | Expected | Recorded |', '|---|---|---|---|'];

type SettingRow = { label: string; source: string; expected: string; recorded(s: EnvironmentSettings): string };

function why(reasons: (string | null)[]): string {
  return reasons.filter((reason): reason is string => reason !== null).join('; ');
}

/** Settings rows, in report order; the `clusterSafe` verdict follows the committed report's own rows, which stay unchanged. */
const SETTING_ROWS: readonly SettingRow[] = [
  {
    label: 'Server time zone',
    source: 'Legacy server; exported as `TZ` to every process by `up.sh`',
    expected: '— (target timestamps are stored in this zone)',
    recorded: (s) =>
      s.timeZone === null
        ? 'unavailable'
        : `${s.timeZone} (utcTotalOffset ${String(s.utcTotalOffset)}); process TZ ${s.processTz ?? 'unset'}${s.timeZoneMatchesProcess ? '' : ', which differs'}`,
  },
  {
    label: '`ping` (original)',
    source: '`${OPT2_PRISTINE_DIR}/native-tasks.json`',
    expected: 'Masa default `false` [core/templates/settings.template.cfm:91]',
    recorded: (s) =>
      s.nativeTasks.status === 'captured'
        ? String(s.nativeTasks.originalPing)
        : `${s.nativeTasks.status === 'absent' ? 'not captured' : 'unreadable'}: ${s.nativeTasks.detail ?? ''}`,
  },
  {
    label: '`ping` (running)',
    source: '`gateway/legacy-bridge/cfml/session.cfm?op=describe`, `gateway/legacy-bridge/cfml/scheduler.cfm?op=describe`',
    expected: '`false` (`MURA_PING=false` on the start command)',
    recorded: (s) =>
      s.ping === null ? 'unavailable' : `${String(s.ping)}, read from \`run.cfm?info=1\`${s.ping ? ' (expected false)' : ''}`,
  },
  {
    label: 'Native `siteMonitor` task present',
    source: '`box cfconfig export`',
    expected: 'Registered only when `ping` is true [core/appcfc/onApplicationStart_include.cfm:549-579]',
    recorded: (s) => {
      const captured = s.nativeTasks.status === 'captured' ? (s.nativeTasks.siteMonitorTask ?? 'none') : 'not captured';
      const running = s.siteMonitorTaskRegistered === null ? 'unavailable' : s.siteMonitorTaskRegistered ? 'registered' : 'none';
      return `captured: ${captured}; running (\`cfschedule\` list): ${running}`;
    },
  },
  {
    label: 'Cluster broadcasting',
    source: 'Start-up guard [core/mura/cluster/clusterManager.cfc:203-211]',
    expected: 'off',
    recorded: ({ cluster: c }) =>
      c.broadcastClusterCommands === null
        ? 'unavailable'
        : `${c.broadcastClusterCommands ? 'on' : 'off'} (broadcastCachePurges ${String(c.broadcastCachePurges)}, broadcastAppreloads ${String(c.broadcastAppreloads)})`,
  },
  {
    label: 'Cluster peers',
    source: 'Start-up guard [core/mura/cluster/clusterManager.cfc:203-211]',
    expected: 'none',
    recorded: ({ cluster: c }) =>
      c.peerCount === null
        ? 'unavailable'
        : c.peerCount === 0
          ? 'none (0 other instances)'
          : `${c.peerCount} other instance${c.peerCount === 1 ? '' : 's'}`,
  },
  {
    label: '`tclustercommands` row count',
    source: 'Start-up guard',
    expected: '0',
    recorded: (s) =>
      s.cluster.tclustercommandsCount !== null
        ? String(s.cluster.tclustercommandsCount)
        : s.dbtype === 'mssql'
          ? 'unavailable'
          : `unavailable: dbtype ${s.dbtype}`,
  },
  {
    label: 'MySQL fallback used',
    source: '`MURA_DBTYPE`',
    expected: 'no (`mssql`)',
    recorded: (s) =>
      s.dbtype === 'mssql' ? 'no (`mssql`)' : `${s.mysqlFallback ? 'yes' : 'no'} (\`${s.dbtype}\`): ${s.deviationReason ?? ''}`,
  },
  {
    label: 'Default hash algorithm',
    source: '`MURA_DEFAULTHASHALGORITHM`',
    expected: '`CFMX_COMPAT`',
    recorded: (s) => (s.defaultHashAlgorithm === null ? 'unset' : `\`${s.defaultHashAlgorithm}\``),
  },
  {
    label: 'Start-up guard verdict (`clusterSafe`)',
    source:
      'Broadcasting off or no peers [core/mura/cluster/clusterManager.cfc:203-211, 273-277], and no `tclustercommands` rows',
    expected: '`true`',
    recorded: ({ cluster: c }) =>
      c.clusterSafe
        ? 'true: the content units may become `target`-authoritative'
        : `false (${why([
            c.broadcastingOff || c.noPeers ? null : 'broadcasting not off and peers not ruled out',
            c.tclustercommandsCount === 0
              ? null
              : c.tclustercommandsCount === null
                ? 'tclustercommands not counted'
                : `${c.tclustercommandsCount} tclustercommands rows`,
          ])}): the content units stay \`legacy\``,
  },
];

function cell(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map(cell).join(' | ')} |`;
}

function recordedCell(r: ProbeRow): string {
  if (r.status === 'unavailable') return `unavailable: ${r.detail ?? 'no detail'}`;
  const value = r.status === 'mismatch' ? `${r.recorded ?? ''} (mismatch: expected ${r.planned})` : (r.recorded ?? '');
  return r.detail === null ? value : `${value}; ${r.detail}`;
}

function probeRows(rows: readonly ProbeRow[] | undefined, pending: readonly RowSpec[]): string[] {
  return rows === undefined
    ? pending.map((spec) => tableRow([spec.label, spec.source, spec.planned, PENDING]))
    : rows.map((r) => tableRow([r.label, r.source, r.planned, recordedCell(r)]));
}

function unprobedNote(): string {
  const pins = UNPROBED_PINS.map((pin) => `${pin.name} ${pin.version} (pinned in ${pin.pinnedIn}; ${pin.why})`);
  return `Not probed by \`--phase local\`: ${pins.join('; ')}.`;
}

function lastCell(line: string): string {
  const cells = line.split(/(?<!\\)\|/);
  return (cells[cells.length - 2] ?? '').trim();
}

/** Sections of an existing report whose tables hold recorded (non-`pending-run`) values, each kept verbatim. */
export function recordedSections(markdown: string): PreservedSections {
  const all = markdown.split(/\r?\n/);
  const found: PreservedSections = {};
  for (const key of ['local', 'services', 'settings'] as const) {
    const start = all.indexOf(HEADINGS[key]);
    if (start < 0) continue;
    const next = all.findIndex((line, i) => i > start && line.startsWith('## '));
    const section = all.slice(start, next < 0 ? all.length : next);
    while (section.length > 0 && (section[section.length - 1] ?? '').trim() === '') section.pop();
    const dataRows = section.filter((line) => line.startsWith('|')).slice(2);
    if (dataRows.some((line) => lastCell(line) !== PENDING)) found[key] = section;
  }
  return found;
}

/** Deviations the record and preserved sections show: a Node or npm pin mismatch, or a dbtype other than `mssql`. */
function deviationsOf(record: EnvironmentRecord, preserved: PreservedSections): string[] {
  const found: string[] = [];
  for (const r of record.local?.probes ?? []) {
    if (ASSERTED_LOCAL.has(r.id) && r.status === 'mismatch') {
      found.push(`${r.label} ${r.recorded ?? ''} differs from the pinned ${r.planned}`);
    }
  }
  if (record.settings?.deviationReason) found.push(record.settings.deviationReason);
  for (const line of preserved.local ?? []) {
    const label = /^\| (Node\.js|npm) \|.*\(mismatch:/.exec(line)?.[1];
    if (label !== undefined) found.push(`${label} pin mismatch in the preserved local record`);
  }
  if ((preserved.settings ?? []).some((line) => line.startsWith('| MySQL fallback used |') && /deviation/.test(lastCell(line)))) {
    found.push('MURA_DBTYPE deviation in the preserved settings record');
  }
  return found;
}

function reportStatus(record: EnvironmentRecord, preserved: PreservedSections): EnvironmentSummary['status'] {
  if (deviationsOf(record, preserved).length > 0) return 'deviation';
  const phases = [record.local !== null || preserved.local !== undefined, record.services !== null || preserved.services !== undefined];
  const recorded = phases.filter(Boolean).length;
  return recorded === 0 ? PENDING : recorded === 1 ? 'partial' : 'recorded';
}

/** Report lines after the title and `Source SHA:` line, in the layout of the committed `opt2/reports/environment.md`. */
export function renderEnvironmentMarkdown(record: EnvironmentRecord, preserved: PreservedSections = {}): string[] {
  const times = [record.local?.recordedAt, record.services?.recordedAt].filter((t): t is string => t !== undefined).sort();
  const local =
    record.local === null && preserved.local !== undefined
      ? [...preserved.local]
      : [HEADINGS.local, '', ...PROBE_HEADER, ...probeRows(record.local?.probes, LOCAL_PROBES.map((p) => ({ ...p, source: p.probe }))), '', unprobedNote()];
  const services =
    record.services === null && preserved.services !== undefined
      ? [...preserved.services]
      : [HEADINGS.services, '', ...PROBE_HEADER, ...probeRows(record.services?.probes, Object.values(SERVICE_ROWS))];
  const settings =
    record.settings === null && preserved.settings !== undefined
      ? [...preserved.settings]
      : [
          HEADINGS.settings,
          '',
          ...SETTINGS_HEADER,
          ...SETTING_ROWS.map((s) => {
            const recorded = record.settings === null ? PENDING : s.recorded(record.settings);
            return tableRow([s.label, s.source, s.expected, recorded]);
          }),
        ];
  return [
    `Status: ${reportStatus(record, preserved)}`,
    `Generated by: ${GENERATED_BY}`,
    `Generated at: ${times[times.length - 1] ?? PENDING}`,
    '',
    '## Oracle',
    '',
    ORACLE_NOTE,
    '',
    ...local,
    '',
    ...services,
    '',
    ...settings,
  ];
}

/** The record in `file`, or an empty one when it does not exist yet. */
async function readRecord(file: string): Promise<EnvironmentRecord> {
  const raw = await readOptional(file);
  if (raw === null) return { local: null, services: null, settings: null };
  const parsed = jsonObject(raw);
  if (parsed === undefined) throw new Error(`${file} does not hold a JSON object; remove it to record both phases afresh`);
  return {
    local: (parsed.local ?? null) as PhaseBlock | null,
    services: (parsed.services ?? null) as PhaseBlock | null,
    settings: (parsed.settings ?? null) as EnvironmentSettings | null,
  };
}

/**
 * Probes one phase, merges it into `<state>/baseline/environment.json` and `<reports>/environment.md`, and writes both.
 * Exit code: 4 when `MURA_DBTYPE` is not `mssql`; 1 on a Node or npm pin mismatch or a failed services probe; else 0.
 */
export async function runEnvironment(
  phase: Phase,
  deps: EnvironmentDeps = {},
): Promise<{ code: number; summary: EnvironmentSummary }> {
  const env = deps.env ?? process.env;
  const statePath = path.join(baselineStateDir(env), 'environment.json');
  const reportPath = path.join(reportsDir(env), 'environment.md');
  const existing = await readRecord(statePath);
  const result = phase === 'local' ? await probeLocal(deps) : await probeServices(deps);
  const record = mergeRecord(existing, phase, result);

  const missing = (['local', 'services', 'settings'] as const).filter((key) => record[key] === null);
  const report = missing.length === 0 ? null : await readOptional(reportPath);
  const found = report === null ? {} : recordedSections(report);
  const preserved: PreservedSections = Object.fromEntries(
    missing.flatMap((key) => (found[key] === undefined ? [] : [[key, found[key]]])),
  );

  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, stableStringify(record), 'utf8');
  await writeMarkdown(reportPath, REPORT_TITLE, renderEnvironmentMarkdown(record, preserved));

  const code = phase === 'services' && record.settings?.deviation === true ? 4 : result.failed.length > 0 ? 1 : 0;
  return {
    code,
    summary: {
      phase,
      status: reportStatus(record, preserved),
      deviations: deviationsOf(record, preserved),
      failed: result.failed,
      mysqlFallback: record.settings?.mysqlFallback ?? null,
      clusterSafe: record.settings?.cluster.clusterSafe ?? null,
      ping: record.settings?.ping ?? null,
      timeZone: record.settings?.timeZone ?? null,
    },
  };
}

const USAGE = 'usage: tsx src/baseline/environment.ts --phase local|services';
const HELP = `${USAGE}

Records tool, runtime and legacy settings into opt2/reports/environment.md (OPT2_REPORTS_DIR) and
<OPT2_STATE_DIR>/baseline/environment.json, merging with the phase recorded earlier.
  --phase local     tool versions, before any service runs; Node and npm pins are asserted (exit 1)
  --phase services  ColdFusion, SQL Server, PostgreSQL and Mailpit; MURA_DBTYPE other than mssql exits 4`;

/** CLI entry; `deps` replaces the process boundary in tests. */
export const main = async (argv: string[], deps: EnvironmentDeps = {}): Promise<CliOutcome> => {
  const { values } = parseFlags(argv, { options: { phase: { type: 'string' } }, usage: USAGE, help: HELP });
  const phase = values.phase;
  if (phase !== 'local' && phase !== 'services') {
    throw new UsageError(
      phase === undefined ? '--phase is required' : `--phase must be local or services, got ${JSON.stringify(phase)}`,
      USAGE,
    );
  }
  return runEnvironment(phase, deps);
};

if (isMainModule(import.meta.url)) void runCli(main);
