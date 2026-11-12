import { mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EnvValidationError,
  baseEnvSchema,
  envModeIssues,
  envPort,
  envUrl,
  loadEnv,
  optionalEnvString,
  publisherEmulatorHost,
  requiredEnvString,
} from '../../src/service-kit/env.js';

const PG_SECRET = 'pg-s3cr3t-do-not-echo';
const REPO_ROOT = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
const SCRATCH = path.join(tmpdir(), `opt2-service-kit-env-${process.pid}`);
const LINK_TO_CHECKOUT = path.join(SCRATCH, 'checkout-link');
const LINK_OUTSIDE = path.join(SCRATCH, 'outside-link');

const localEnv: Record<string, string> = {
  PORT: '8112',
  OPT2_SERVICE_NAME: 'people',
  OPT2_ENV: 'local',
  OPT2_DB_AUTH: 'password',
  PG_HOST: '127.0.0.1',
  PG_PORT: '5432',
  PG_DATABASE: 'masa_services',
  PG_USER: 'people_app',
  PG_PASSWORD: PG_SECRET,
  PUBSUB_EMULATOR_HOST: 'localhost:8085',
  OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks/',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  OPT2_SERVICE_URLS: '{"identity":"http://127.0.0.1:8111"}',
  TZ: 'America/New_York',
};

const cloudEnv: Record<string, string> = {
  PORT: '8080',
  OPT2_SERVICE_NAME: 'programs-sites',
  OPT2_ENV: 'cloud',
  OPT2_DB_AUTH: 'iam',
  CLOUD_SQL_INSTANCE: 'p:r:i',
  PG_DATABASE: 'opt2',
  PG_USER: 'programs-sites@p.iam',
  GOOGLE_CLOUD_PROJECT: 'p',
  OPT2_TOKEN_ISSUER: 'https://securetoken.google.com/p',
  OPT2_TOKEN_AUDIENCE: 'p',
  OPT2_GATEWAY_URL: 'https://gateway-abc.a.run.app/',
  OPT2_MIGRATION_URL: 'https://migration-abc.a.run.app',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  OPT2_STATE_DIR: '/var/opt2/state',
  TZ: 'UTC',
};

function rejectionOf(source: Record<string, string | undefined>): EnvValidationError {
  try {
    loadEnv(baseEnvSchema, source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return error as EnvValidationError;
  }
  throw new Error('expected loadEnv to reject the environment');
}

const issuesOf = (source: Record<string, string | undefined>): string[] => rejectionOf(source).issues;

describe('loadEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a complete local environment and defaults adapters and the state directory', () => {
    const env = loadEnv(baseEnvSchema, localEnv);

    expect(env).toMatchObject({
      PORT: 8112,
      PG_PORT: 5432,
      OPT2_ENV: 'local',
      OPT2_DB_AUTH: 'password',
      PUBSUB_EMULATOR_HOST: 'localhost:8085',
      OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
      OPT2_SERVICE_URLS: { identity: 'http://127.0.0.1:8111' },
      OPT2_TASKS_ADAPTER: 'local',
      OPT2_STORAGE_ADAPTER: 'local',
      OPT2_STATE_DIR: path.join(homedir(), '.opt2', 'state'),
    });
    expect(Object.isFrozen(env)).toBe(true);
  });

  it('accepts a complete cloud environment without a database password', () => {
    const env = loadEnv(baseEnvSchema, cloudEnv);

    expect(env).toMatchObject({
      OPT2_ENV: 'cloud',
      OPT2_DB_AUTH: 'iam',
      CLOUD_SQL_INSTANCE: 'p:r:i',
      OPT2_GATEWAY_URL: 'https://gateway-abc.a.run.app',
      OPT2_SERVICE_URLS: {},
      OPT2_STATE_DIR: '/var/opt2/state',
      OPT2_TASKS_ADAPTER: 'cloud',
      OPT2_STORAGE_ADAPTER: 'cloud',
    });
    expect(env.PG_PASSWORD).toBeUndefined();
  });

  it.each([
    ['local without PG_PASSWORD', { ...localEnv, PG_PASSWORD: undefined }, 'PG_PASSWORD: is required when OPT2_DB_AUTH=password'],
    ['password auth in the cloud', { ...cloudEnv, OPT2_DB_AUTH: 'password', PG_HOST: 'h', PG_PORT: '5432', PG_PASSWORD: 'x' }, 'OPT2_ENV: must be local when OPT2_DB_AUTH=password'],
    ['iam with PG_PASSWORD', { ...cloudEnv, PG_PASSWORD: PG_SECRET }, 'PG_PASSWORD: must be unset when OPT2_DB_AUTH=iam'],
    ['iam without CLOUD_SQL_INSTANCE', { ...cloudEnv, CLOUD_SQL_INSTANCE: undefined }, 'CLOUD_SQL_INSTANCE: is required when OPT2_DB_AUTH=iam'],
    ['iam locally', { ...localEnv, OPT2_DB_AUTH: 'iam', PG_PASSWORD: undefined, CLOUD_SQL_INSTANCE: 'p:r:i' }, 'OPT2_ENV: must be cloud when OPT2_DB_AUTH=iam'],
    ['cloud with PUBSUB_EMULATOR_HOST', { ...cloudEnv, PUBSUB_EMULATOR_HOST: 'localhost:8085' }, 'PUBSUB_EMULATOR_HOST: must be unset when OPT2_ENV=cloud'],
    ['cloud without GOOGLE_CLOUD_PROJECT', { ...cloudEnv, GOOGLE_CLOUD_PROJECT: undefined }, 'GOOGLE_CLOUD_PROJECT: is required when OPT2_ENV=cloud'],
    ['local without OPT2_JWKS_URL', { ...localEnv, OPT2_JWKS_URL: undefined }, 'OPT2_JWKS_URL: is required when OPT2_ENV=local'],
    ['local with OPT2_TASKS_ADAPTER=cloud', { ...localEnv, OPT2_TASKS_ADAPTER: 'cloud' }, 'OPT2_TASKS_ADAPTER: must equal OPT2_ENV'],
    ['cloud with OPT2_STORAGE_ADAPTER=local', { ...cloudEnv, OPT2_STORAGE_ADAPTER: 'local' }, 'OPT2_STORAGE_ADAPTER: must equal OPT2_ENV'],
    ['malformed OPT2_SERVICE_URLS JSON', { ...localEnv, OPT2_SERVICE_URLS: '{identity:' }, 'OPT2_SERVICE_URLS: OPT2_SERVICE_URLS must be a JSON object'],
    ['a non-object OPT2_SERVICE_URLS', { ...localEnv, OPT2_SERVICE_URLS: '["http://x"]' }, 'OPT2_SERVICE_URLS: Invalid input: expected record, received array'],
    ['a non-URL OPT2_SERVICE_URLS value', { ...localEnv, OPT2_SERVICE_URLS: '{"identity":"127.0.0.1:8111"}' }, 'OPT2_SERVICE_URLS.identity: Invalid URL'],
    ['an invalid OPT2_SERVICE_URLS key', { ...localEnv, OPT2_SERVICE_URLS: '{"Identity":"http://x"}' }, 'OPT2_SERVICE_URLS.Identity: Invalid key in record'],
    ['a missing TZ', { ...localEnv, TZ: undefined }, 'TZ: is required'],
    ['a non-numeric PORT', { ...localEnv, PORT: 'eighty' }, 'PORT: Invalid input: expected number, received NaN'],
    ['an out-of-range PG_PORT', { ...localEnv, PG_PORT: '70000' }, 'PG_PORT: Too big: expected number to be <=65535'],
    ['an unknown OPT2_ENV', { ...localEnv, OPT2_ENV: 'staging' }, 'OPT2_ENV: Invalid option: expected one of "local"|"cloud"'],
    ['a non-http URL', { ...localEnv, OPT2_JWKS_URL: 'file:///etc/jwks.json' }, 'OPT2_JWKS_URL: Invalid URL'],
    ['an invalid service name', { ...localEnv, OPT2_SERVICE_NAME: 'People' }, 'OPT2_SERVICE_NAME: Invalid string: must match pattern /^[a-z][a-z0-9-]*$/'],
    ['a malformed CLOUD_SQL_INSTANCE', { ...cloudEnv, CLOUD_SQL_INSTANCE: 'p:i' }, 'CLOUD_SQL_INSTANCE: Invalid string: must match pattern /^[^:]+:[^:]+:[^:]+$/'],
    ['a PUBSUB_EMULATOR_HOST without a port', { ...localEnv, PUBSUB_EMULATOR_HOST: 'localhost' }, 'PUBSUB_EMULATOR_HOST: Invalid string'],
  ])('rejects %s', (_case, source, expected) => {
    expect(issuesOf(source).some((issue) => issue.startsWith(expected))).toBe(true);
  });

  it.each([
    ['PUBSUB_EMULATOR_HOST', 'localhost', 'PUBSUB_EMULATOR_HOST: Invalid string'],
    ['PUBSUB_EMULATOR_HOST', 'localhost:0', 'PUBSUB_EMULATOR_HOST: port must be from 1 to 65535'],
    ['PUBSUB_EMULATOR_HOST', 'localhost:99999', 'PUBSUB_EMULATOR_HOST: port must be from 1 to 65535'],
    ['PUBSUB_EMULATOR_HOST', '[::1]:65536', 'PUBSUB_EMULATOR_HOST: port must be from 1 to 65535'],
    ['TZ', 'America/New_Yrok', 'TZ: must be an IANA time zone name that this process applies, such as UTC or America/New_York'],
    ['TZ', '+05:00', 'TZ: must be an IANA time zone name that this process applies, such as UTC or America/New_York'],
    ['TZ', 'america/new_york', 'TZ: must be an IANA time zone name that this process applies, such as UTC or America/New_York'],
    ['TZ', 'EST+5', 'TZ: must be an IANA time zone name that this process applies, such as UTC or America/New_York'],
  ])('reports an invalid %s %s as one issue that never echoes the value', (key, value, expected) => {
    const error = rejectionOf({ ...localEnv, [key]: value });

    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]?.startsWith(expected)).toBe(true);
    expect(error.message).not.toContain(value);
  });

  it.each([
    ['PUBSUB_EMULATOR_HOST', '[::1]:8085'],
    ['PUBSUB_EMULATOR_HOST', 'localhost:65535'],
    ['TZ', 'UTC'],
    ['TZ', 'Etc/UTC'],
    ['TZ', 'America/New_York'],
    ['TZ', 'US/Eastern'],
  ])('accepts %s %s and returns it unchanged', (key, value) => {
    expect(loadEnv(baseEnvSchema, { ...localEnv, [key]: value })).toMatchObject({ [key]: value });
  });

  describe('OPT2_STATE_DIR', () => {
    beforeAll(() => {
      mkdirSync(path.join(SCRATCH, 'outside'), { recursive: true });
      symlinkSync(REPO_ROOT, LINK_TO_CHECKOUT);
      symlinkSync(path.join(SCRATCH, 'outside'), LINK_OUTSIDE);
    });

    afterAll(() => {
      rmSync(SCRATCH, { recursive: true, force: true });
    });

    it.each([
      ['a relative "."', '.', 'must be an absolute path'],
      ['a relative "state"', 'state', 'must be an absolute path'],
      ['the checkout root', `${REPO_ROOT}/`, 'must be outside the repository checkout'],
      ['a path inside the checkout', path.join(REPO_ROOT, 'opt2-state'), 'must be outside the repository checkout'],
      ['a ".." path that resolves into the checkout', `${REPO_ROOT}/platform/../state`, 'must be outside the repository checkout'],
      ['a path through a symlink into the checkout', path.join(LINK_TO_CHECKOUT, 'state'), 'must be outside the repository checkout'],
    ])('rejects %s', (_case, value, message) => {
      expect(issuesOf({ ...localEnv, OPT2_STATE_DIR: value })).toEqual([`OPT2_STATE_DIR: ${message}`]);
    });

    it.each([
      ['a trailing "/" and ".." segment', `${SCRATCH}/x/../state/`, path.join(SCRATCH, 'state')],
      ['a symlink to a directory outside the checkout', `${LINK_OUTSIDE}/state`, path.join(LINK_OUTSIDE, 'state')],
    ])('accepts a path outside the checkout with %s, normalised', (_case, value, expected) => {
      expect(loadEnv(baseEnvSchema, { ...localEnv, OPT2_STATE_DIR: value }).OPT2_STATE_DIR).toBe(expected);
    });

    it('checks the home-directory default as well', () => {
      vi.stubEnv('HOME', REPO_ROOT);

      expect(issuesOf(localEnv)).toEqual(['OPT2_STATE_DIR: must be outside the repository checkout']);
    });
  });

  it('lists every issue under the service name and never echoes the database password', () => {
    const source = { ...cloudEnv, PG_PASSWORD: PG_SECRET, PUBSUB_EMULATOR_HOST: 'localhost:8085' };

    expect(() => loadEnv(baseEnvSchema, source)).toThrow(
      'programs-sites: invalid environment\n' +
        '  PG_PASSWORD: must be unset when OPT2_DB_AUTH=iam\n' +
        '  PUBSUB_EMULATOR_HOST: must be unset when OPT2_ENV=cloud',
    );
    for (const failing of [source, { ...localEnv, PORT: 'x', OPT2_ENV: 'nope' }]) {
      const error = rejectionOf(failing);
      expect(error.name).toBe('EnvValidationError');
      expect(error.message).not.toContain(PG_SECRET);
      expect(error.issues.join('\n')).not.toContain(PG_SECRET);
    }
  });

  it('omits the service prefix when the service name itself is invalid', () => {
    expect(() => loadEnv(baseEnvSchema, { ...localEnv, OPT2_SERVICE_NAME: 'Bad Name' })).toThrow(/^invalid environment\n/);
  });

  it('treats empty and whitespace-only values as absent', () => {
    const env = loadEnv(baseEnvSchema, {
      ...localEnv,
      OPT2_DB_AUTH: '',
      PG_HOST: '',
      PG_PORT: '  ',
      PG_PASSWORD: '',
      OPT2_GATEWAY_URL: ' ',
      OPT2_SERVICE_URLS: '',
      OPT2_STATE_DIR: '   ',
      OPT2_TASKS_ADAPTER: '',
    });

    expect(env.OPT2_DB_AUTH).toBeUndefined();
    expect(env.PG_HOST).toBeUndefined();
    expect(env.PG_PORT).toBeUndefined();
    expect(env.PG_PASSWORD).toBeUndefined();
    expect(env.OPT2_GATEWAY_URL).toBeUndefined();
    expect(env.OPT2_SERVICE_URLS).toEqual({});
    expect(env.OPT2_STATE_DIR).toBe(path.join(homedir(), '.opt2', 'state'));
    expect(env.OPT2_TASKS_ADAPTER).toBe('local');
    expect(issuesOf({ ...localEnv, TZ: '', OPT2_TOKEN_ISSUER: ' ' })).toEqual([
      'OPT2_TOKEN_ISSUER: is required',
      'TZ: is required',
    ]);
  });

  it('strips variables the schema does not declare', () => {
    const env = loadEnv(baseEnvSchema, { ...localEnv, HOME: '/root', PATH: '/usr/bin', MURA_DBPASSWORD: 'x' });

    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('PATH');
    expect(env).not.toHaveProperty('MURA_DBPASSWORD');
  });

  it('parses consumer extensions built from the exported builders', () => {
    const schema = baseEnvSchema.extend({
      LEGACY_ORIGIN: envUrl(),
      OPT2_BRIDGE_HMAC_KEY: requiredEnvString(),
      SMTP_PORT: optionalEnvString(envPort()),
      OPT2_CUTOVER_DIR: optionalEnvString(),
    });

    const env = loadEnv(schema, { ...localEnv, LEGACY_ORIGIN: 'http://127.0.0.1:8080/', OPT2_BRIDGE_HMAC_KEY: 'k', SMTP_PORT: '1025' });
    expect(env).toMatchObject({ LEGACY_ORIGIN: 'http://127.0.0.1:8080', SMTP_PORT: 1025, PORT: 8112 });
    expect(env.OPT2_CUTOVER_DIR).toBeUndefined();

    expect(() => loadEnv(schema, { ...localEnv, OPT2_BRIDGE_HMAC_KEY: '' })).toThrow(
      /LEGACY_ORIGIN: is required\n {2}OPT2_BRIDGE_HMAC_KEY: is required/,
    );
  });

  it('reads process.env by default and keeps the wall clock of its TZ', () => {
    for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, localEnv[key]);

    expect(loadEnv()).toMatchObject({ OPT2_SERVICE_NAME: 'people', PORT: 8112, OPT2_TASKS_ADAPTER: 'local', TZ: 'America/New_York' });
    expect(new Date(Date.UTC(2026, 6, 1, 16)).getHours()).toBe(12);
  });

  it.each(['us/eastern', 'EST'])('rejects the process TZ %s, which Date does not apply', (tz) => {
    for (const key of Object.keys(baseEnvSchema.shape)) vi.stubEnv(key, key === 'TZ' ? tz : localEnv[key]);

    expect(() => loadEnv()).toThrow(/\n {2}TZ: must be an IANA time zone name/);
  });
});

describe('publisherEmulatorHost', () => {
  it.each([
    ['the local emulator host', localEnv, 'localhost:8085'],
    ['no host in the cloud', cloudEnv, undefined],
  ])('returns %s', (_case, source, expected) => {
    expect(publisherEmulatorHost(loadEnv(baseEnvSchema, source))).toBe(expected);
  });

  it.each([
    ['missing', undefined, 'local', 'is required when OPT2_ENV=local'],
    ['blank', '  ', 'local', 'is required when OPT2_ENV=local'],
    ['without a port', 'pubsub-emulator-host', 'local', 'Invalid string: must match pattern'],
    ['out of port range', 'pubsub-emulator-host:65536', 'local', 'port must be from 1 to 65535'],
    ['set in the cloud', 'pubsub-emulator-host:8085', 'cloud', 'must be unset when OPT2_ENV=cloud'],
  ] as const)('rejects a host that is %s, naming the variable but not its value', (_case, host, mode, issue) => {
    const env = { ...loadEnv(baseEnvSchema, mode === 'local' ? localEnv : cloudEnv), PUBSUB_EMULATOR_HOST: host };
    let error: unknown;
    try {
      publisherEmulatorHost(env);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(EnvValidationError);
    const { message, issues } = error as EnvValidationError;
    expect(issues).toEqual([expect.stringContaining(`PUBSUB_EMULATOR_HOST: ${issue}`)]);
    expect(message.startsWith(`${env.OPT2_SERVICE_NAME}: invalid environment\n  PUBSUB_EMULATOR_HOST: ${issue}`)).toBe(true);
    if (host?.trim()) expect(message).not.toContain(host);
  });
});

describe('envModeIssues', () => {
  it('reports nothing for a consistent environment', () => {
    expect(envModeIssues(loadEnv(baseEnvSchema, localEnv))).toEqual([]);
    expect(envModeIssues(loadEnv(baseEnvSchema, cloudEnv))).toEqual([]);
  });

  it('reports every missing password-auth variable without values', () => {
    const env = { ...loadEnv(baseEnvSchema, localEnv), PG_HOST: undefined, PG_PORT: undefined, PG_DATABASE: undefined, PG_USER: undefined };

    expect(envModeIssues(env)).toEqual([
      'PG_HOST: is required when OPT2_DB_AUTH=password',
      'PG_PORT: is required when OPT2_DB_AUTH=password',
      'PG_DATABASE: is required when OPT2_DB_AUTH=password',
      'PG_USER: is required when OPT2_DB_AUTH=password',
    ]);
  });
});
