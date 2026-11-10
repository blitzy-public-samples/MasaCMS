import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError, runCli } from '../../src/lib/cli.js';
import { repoPath, type EnvLike } from '../../src/lib/paths.js';
import {
  PACKAGE_NAMES,
  PORTS_ENV_PATH,
  PortsError,
  assertNoLegacyCollision,
  loadPorts,
  localUrl,
  main,
  parsePortsEnv,
  portFor,
  portVariable,
  serviceUrls,
  type PackageName,
} from '../../src/repro/ports.js';

const COMMAND = 'harness/src/repro/ports.ts';
const USAGE = 'usage: tsx src/repro/ports.ts (--service-urls | --check) [--legacy-port <n>]';

/** The fixed local port of every target package. */
const EXPECTED: Record<PackageName, number> = {
  gateway: 8100,
  web: 8101,
  migration: 8102,
  identity: 8111,
  people: 8112,
  'programs-sites': 8113,
  'strategies-content': 8114,
  communications: 8115,
  reporting: 8116,
  surveys: 8117,
  timesheets: 8118,
  finance: 8119,
  'e-signature': 8120,
  stub: 8199,
};

const VARIABLES: Record<PackageName, string> = {
  gateway: 'OPT2_PORT_GATEWAY',
  web: 'OPT2_PORT_WEB',
  migration: 'OPT2_PORT_MIGRATION',
  identity: 'OPT2_PORT_IDENTITY',
  people: 'OPT2_PORT_PEOPLE',
  'programs-sites': 'OPT2_PORT_PROGRAMS_SITES',
  'strategies-content': 'OPT2_PORT_STRATEGIES_CONTENT',
  communications: 'OPT2_PORT_COMMUNICATIONS',
  reporting: 'OPT2_PORT_REPORTING',
  surveys: 'OPT2_PORT_SURVEYS',
  timesheets: 'OPT2_PORT_TIMESHEETS',
  finance: 'OPT2_PORT_FINANCE',
  'e-signature': 'OPT2_PORT_E_SIGNATURE',
  stub: 'OPT2_PORT_STUB',
};

/** Shared tooling ports the shell scripts read from the same file; `parsePortsEnv` ignores them. */
const TOOL_PORTS: Record<string, number> = {
  OPT2_TOOL_PORT_PUBSUB_EMULATOR: 8085,
  OPT2_TOOL_PORT_OTLP_HTTP: 4318,
  OPT2_TOOL_PORT_MAILPIT_SMTP: 1025,
  OPT2_TOOL_PORT_MAILPIT_HTTP: 8025,
};

const URLS = Object.fromEntries(PACKAGE_NAMES.map((name) => [name, `http://127.0.0.1:${EXPECTED[name]}`]));
const KNOWN_VARIABLES = PACKAGE_NAMES.map((name) => VARIABLES[name]).join(', ');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A fresh temporary directory, removed after the test. */
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opt2-ports-test-'));
  tempDirs.push(dir);
  return dir;
}

/** `text` written to `ports.env` in a fresh temporary directory, so `loadPorts` has never cached its path. */
function tempPortsFile(text: string): string {
  const file = path.join(tempDir(), 'ports.env');
  writeFileSync(file, text);
  return file;
}

/** Valid text for EXPECTED; a `replace` entry swaps a variable's value, or drops its line when undefined. */
function portsText(replace: Record<string, string | undefined> = {}, extra: string[] = []): string {
  const lines = PACKAGE_NAMES.flatMap((name) => {
    const value = VARIABLES[name] in replace ? replace[VARIABLES[name]] : String(EXPECTED[name]);
    return value === undefined ? [] : [`${VARIABLES[name]}=${value}`];
  });
  return `${[...lines, ...extra].join('\n')}\n`;
}

/** The error `run` throws; fails the test when it returns. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return expect.fail('expected the call to throw');
}

describe('committed harness/repro/ports.env', () => {
  it('is LF text: one comment header, then the package ports and the tooling ports, unquoted, in order', () => {
    expect(PORTS_ENV_PATH).toBe(repoPath('harness', 'repro', 'ports.env'));
    const text = readFileSync(PORTS_ENV_PATH, 'utf8');
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    const [header, ...assignments] = text.slice(0, -1).split('\n');
    expect(header).toMatch(/^# \S/);
    expect(assignments).toEqual([
      ...PACKAGE_NAMES.map((name) => `${VARIABLES[name]}=${EXPECTED[name]}`),
      ...Object.entries(TOOL_PORTS).map(([variable, port]) => `${variable}=${port}`),
    ]);
  });

  it('parses into the fixed package ports, frozen and cached', () => {
    const ports = loadPorts();
    expect(ports).toEqual(EXPECTED);
    expect(Object.isFrozen(ports)).toBe(true);
    expect(loadPorts(PORTS_ENV_PATH)).toBe(ports);
  });

  it('gives bash the same values when sourced, and never sets PORT', () => {
    const names = [...PACKAGE_NAMES.map((name) => VARIABLES[name]), ...Object.keys(TOOL_PORTS), 'PORT'];
    const script = 'set -a; . "$0"; set +a; for v in "$@"; do printf "%s=%s\\n" "$v" "${!v-<unset>}"; done';
    const out = execFileSync('bash', ['-c', script, PORTS_ENV_PATH, ...names], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(out).toBe(
      [
        ...PACKAGE_NAMES.map((name) => `${VARIABLES[name]}=${EXPECTED[name]}`),
        ...Object.entries(TOOL_PORTS).map(([variable, port]) => `${variable}=${port}`),
        'PORT=<unset>',
        '',
      ].join('\n'),
    );
  });
});

describe('portVariable', () => {
  it.each<[PackageName, string]>(PACKAGE_NAMES.map((name) => [name, VARIABLES[name]]))('maps %s to %s', (name, variable) => {
    expect(portVariable(name)).toBe(variable);
  });
});

describe('portFor, localUrl and serviceUrls', () => {
  it.each(PACKAGE_NAMES)('resolve %s from the committed file', (name) => {
    expect(portFor(name)).toBe(EXPECTED[name]);
    expect(localUrl(name)).toBe(`http://127.0.0.1:${EXPECTED[name]}`);
  });

  it('serviceUrls maps every package, in PACKAGE_NAMES order, to its loopback URL', () => {
    const urls = serviceUrls();
    expect(Object.keys(urls)).toEqual([...PACKAGE_NAMES]);
    expect(urls).toEqual(URLS);
  });
});

describe('parsePortsEnv', () => {
  it.each<[string, string, Record<PackageName, number>]>([
    ['plain assignments', portsText(), EXPECTED],
    ['CRLF line endings', portsText().replaceAll('\n', '\r\n'), EXPECTED],
    [
      'comments, blank lines and surrounding whitespace',
      `# header\n\n   \n${portsText().replaceAll('\n', '  \n  ')}# trailer\n`,
      EXPECTED,
    ],
    ['double- and single-quoted values', portsText({ OPT2_PORT_GATEWAY: '"8100"', OPT2_PORT_WEB: "'8101'" }), EXPECTED],
    ['an export prefix', portsText({ OPT2_PORT_STUB: undefined }, ['export   OPT2_PORT_STUB=8199']), EXPECTED],
    ['keys outside OPT2_PORT_*, PORT included', portsText({}, ['OPT2_TOOL_PORT_OTLP_HTTP=4318', 'PORT=8100', 'OTHER="x y"']), EXPECTED],
    ['a later assignment overriding an earlier one', portsText({ OPT2_PORT_PEOPLE: '9999' }, ['OPT2_PORT_PEOPLE=8112']), EXPECTED],
    [
      'the range bounds 1 and 65535',
      portsText({ OPT2_PORT_GATEWAY: '1', OPT2_PORT_STUB: '65535' }),
      { ...EXPECTED, gateway: 1, stub: 65535 },
    ],
  ])('accepts %s', (_label, text, expected) => {
    expect(parsePortsEnv(text)).toEqual(expected);
  });

  it.each<[string, string, string]>([
    ['empty text', '', 'OPT2_PORT_GATEWAY is missing'],
    [
      'a line without =',
      portsText({}, ['OPT2_PORT_GATEWAY']),
      'line 15 is not a KEY=value assignment with an [A-Z0-9_] key: OPT2_PORT_GATEWAY',
    ],
    [
      'a lowercase key',
      portsText({}, ['opt2_port_gateway=8100']),
      'line 15 is not a KEY=value assignment with an [A-Z0-9_] key: opt2_port_gateway=8100',
    ],
    [
      'spaces around =',
      portsText({}, ['OPT2_PORT_GATEWAY = 8100']),
      'line 15 is not a KEY=value assignment with an [A-Z0-9_] key: OPT2_PORT_GATEWAY = 8100',
    ],
    [
      'an unknown OPT2_PORT_ variable',
      portsText({}, ['OPT2_PORT_LEGACY=8080']),
      `OPT2_PORT_LEGACY names no known package; expected one of ${KNOWN_VARIABLES}`,
    ],
    ['a missing variable', portsText({ OPT2_PORT_FINANCE: undefined }), 'OPT2_PORT_FINANCE is missing'],
    ...['0', '65536', '', 'abc', '-1', '8101.5', '0x1f95', '"8101\''].map(
      (value): [string, string, string] => [
        `the out-of-range or non-integer value '${value}'`,
        portsText({ OPT2_PORT_WEB: value }),
        `OPT2_PORT_WEB must be an integer from 1 to 65535, got '${value}'`,
      ],
    ),
    [
      'a port shared by two packages',
      portsText({ OPT2_PORT_STUB: '8100' }),
      'OPT2_PORT_STUB and OPT2_PORT_GATEWAY share port 8100',
    ],
  ])('rejects %s, and loadPorts wraps the error with the file path', (_label, text, message) => {
    const err = thrown(() => parsePortsEnv(text));
    expect(err).toBeInstanceOf(PortsError);
    expect(err).toMatchObject({ name: 'PortsError', message });

    const file = tempPortsFile(text);
    const wrapped = thrown(() => loadPorts(file));
    expect(wrapped).toBeInstanceOf(PortsError);
    expect(wrapped).toMatchObject({ message: `${file}: ${message}` });
    expect((wrapped as Error).cause).toBeInstanceOf(PortsError);
    expect((wrapped as Error).cause).toMatchObject({ message });
  });
});

describe('loadPorts', () => {
  it('reads a file once per resolved path, and each path separately', () => {
    const file = tempPortsFile(portsText());
    const first = loadPorts(file);
    expect(first).toEqual(EXPECTED);
    expect(Object.isFrozen(first)).toBe(true);

    writeFileSync(file, portsText({ OPT2_PORT_GATEWAY: '9100' }));
    expect(loadPorts(file)).toBe(first);
    expect(loadPorts(path.relative(process.cwd(), file))).toBe(first);

    const other = tempPortsFile(portsText({ OPT2_PORT_GATEWAY: '9100' }));
    expect(loadPorts(other)).toEqual({ ...EXPECTED, gateway: 9100 });
  });

  it('wraps a read failure in a PortsError naming the file, with the cause', () => {
    const missing = path.join(tempDir(), 'absent.env');
    const err = thrown(() => loadPorts(missing));
    expect(err).toBeInstanceOf(PortsError);
    expect((err as Error).message.startsWith(`${missing}: ENOENT: no such file or directory`)).toBe(true);
    expect((err as Error).cause).toMatchObject({ code: 'ENOENT', path: missing });
  });
});

describe('assertNoLegacyCollision', () => {
  it.each(PACKAGE_NAMES)('rejects a legacy port equal to the %s port', (name) => {
    const err = thrown(() => assertNoLegacyCollision(EXPECTED[name]));
    expect(err).toBeInstanceOf(PortsError);
    expect(err).toMatchObject({
      message: `legacy PORT ${EXPECTED[name]} collides with ${VARIABLES[name]} in ${PORTS_ENV_PATH}`,
    });
  });

  it.each([8080, 8099, 8103, 8121, 26480])('accepts the free legacy port %i', (port) => {
    expect(() => assertNoLegacyCollision(port)).not.toThrow();
  });
});

describe('main', () => {
  it.each<[string, string[], EnvLike, Record<string, unknown>]>([
    ['--check without a legacy port', ['--check'], {}, { ports: EXPECTED, legacyPort: null }],
    ['--check with --legacy-port', ['--check', '--legacy-port', '26480'], {}, { ports: EXPECTED, legacyPort: 26480 }],
    ['--check with PORT from the environment', ['--check'], { PORT: '8500' }, { ports: EXPECTED, legacyPort: 8500 }],
    [
      '--check with --legacy-port taking precedence over PORT',
      ['--check', '--legacy-port=26480'],
      { PORT: '8100' },
      { ports: EXPECTED, legacyPort: 26480 },
    ],
    ['--check with an empty PORT treated as unset', ['--check'], { PORT: '' }, { ports: EXPECTED, legacyPort: null }],
    ['--service-urls', ['--service-urls'], {}, { serviceUrls: URLS }],
    ['--service-urls with a free PORT', ['--service-urls'], { PORT: '8500' }, { serviceUrls: URLS }],
    [
      'both modes',
      ['--service-urls', '--check', '--legacy-port', '8080'],
      {},
      { ports: EXPECTED, legacyPort: 8080, serviceUrls: URLS },
    ],
  ])('returns the summary for %s', (_label, argv, env, summary) => {
    expect(main(argv, env)).toEqual({ summary });
  });

  it('reads PORT from process.env when no environment is passed', () => {
    vi.stubEnv('PORT', '8500');
    expect(main(['--check'])).toEqual({ summary: { ports: EXPECTED, legacyPort: 8500 } });
  });

  it.each<[string, string[], EnvLike, string]>([
    ['no mode flag', [], {}, 'one of --service-urls or --check is required'],
    ['--legacy-port without a mode', ['--legacy-port', '26480'], {}, 'one of --service-urls or --check is required'],
    ['an unknown flag', ['--check', '--bogus'], {}, "Unknown option '--bogus'"],
    ['--legacy-port without a value', ['--check', '--legacy-port'], {}, "Option '--legacy-port <value>' argument missing"],
    [
      'a positional argument',
      ['--check', 'extra'],
      {},
      "Unexpected argument 'extra'. This command does not take positional arguments",
    ],
    ...['', 'abc', '0', '65536', '8100.5'].map((value): [string, string[], EnvLike, string] => [
      `--legacy-port '${value}'`,
      ['--check', `--legacy-port=${value}`],
      { PORT: '8500' },
      `--legacy-port must be an integer from 1 to 65535, got '${value}'`,
    ]),
    ...['abc', '0', '70000', ' 8500'].map((value): [string, string[], EnvLike, string] => [
      `PORT '${value}'`,
      ['--service-urls'],
      { PORT: value },
      `PORT must be an integer from 1 to 65535, got '${value}'`,
    ]),
  ])('raises a UsageError carrying the usage text for %s', (_label, argv, env, message) => {
    const err = thrown(() => main(argv, env));
    expect(err).toBeInstanceOf(UsageError);
    expect(err).toMatchObject({ name: 'UsageError', message, usage: USAGE });
  });

  it.each<[string[], EnvLike, string, number]>([
    [['--check', '--legacy-port', '8112'], {}, 'OPT2_PORT_PEOPLE', 8112],
    [['--service-urls'], { PORT: '8100' }, 'OPT2_PORT_GATEWAY', 8100],
  ])('raises a PortsError for %j with env %j colliding with %s', (argv, env, variable, port) => {
    const err = thrown(() => main(argv, env));
    expect(err).toBeInstanceOf(PortsError);
    expect(err).toMatchObject({ message: `legacy PORT ${port} collides with ${variable} in ${PORTS_ENV_PATH}` });
  });
});

describe('ports CLI through runCli', () => {
  it.each<[string, string[], EnvLike, number, Record<string, unknown>]>([
    [
      '--check',
      ['--check', '--legacy-port', '26480'],
      { PORT: '8100' },
      0,
      { command: COMMAND, ok: true, code: 0, ports: EXPECTED, legacyPort: 26480 },
    ],
    ['--service-urls', ['--service-urls'], {}, 0, { command: COMMAND, ok: true, code: 0, serviceUrls: URLS }],
    [
      'a usage error',
      ['--check', '--legacy-port', 'abc'],
      {},
      2,
      {
        command: COMMAND,
        ok: false,
        code: 2,
        error: { type: 'UsageError', message: "--legacy-port must be an integer from 1 to 65535, got 'abc'" },
        usage: USAGE,
      },
    ],
    [
      'a legacy port collision',
      ['--check'],
      { PORT: '8199' },
      1,
      {
        command: COMMAND,
        ok: false,
        code: 1,
        error: { type: 'PortsError', message: `legacy PORT 8199 collides with OPT2_PORT_STUB in ${PORTS_ENV_PATH}` },
      },
    ],
  ])('writes one summary line and exits with its code for %s', async (_label, argv, env, code, line) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const chunks: string[] = [];
    const exits: number[] = [];

    const result = await runCli((args) => main(args, env), {
      argv,
      stdout: { write: (chunk: string) => chunks.push(chunk) },
      exit: (status) => exits.push(status),
      command: COMMAND,
    });

    expect(result).toBe(code);
    expect(exits).toEqual([code]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.endsWith('\n')).toBe(true);
    expect(JSON.parse(chunks[0] ?? '')).toEqual(line);
    const errorOutput = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    if (code === 1) expect(errorOutput).toContain('PortsError: legacy PORT 8199 collides with OPT2_PORT_STUB');
    else expect(errorOutput).not.toContain('Error');
  });
});
