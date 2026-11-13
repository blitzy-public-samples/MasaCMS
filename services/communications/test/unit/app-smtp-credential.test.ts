// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** SMTP_CREDENTIAL: required in the cloud, optional locally, and handed by buildApp to the SMTP transport before createService. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnvValidationError, createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { createCapturingPublisher, testVerifier } from '@opt2/platform/testing';
import { buildApp, communicationsEnvSchema } from '../../src/app.js';
import { SMTP_TIMEOUT_MS } from '../../src/domain/mail-transport.js';
import {
  TEST_CLOCK,
  createFakeDeliveryStatus,
  createFakeSenderAddress,
  createFakeTaskPort,
  createRecordingDb,
  removeTestStateDir,
  testEnv,
} from '../helpers/app.js';

const mailer = vi.hoisted(() => {
  const close = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail: vi.fn(), close }));
  return { close, createTransport };
});

vi.mock('nodemailer', () => ({ default: { createTransport: mailer.createTransport } }));

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

type Overrides = Readonly<Record<string, string | undefined>>;

const CLOUD_REQUIRED = 'SMTP_CREDENTIAL: is required when OPT2_ENV=cloud';
const AUTH = { user: 'comms-user', pass: 'comms-pass' };
const CREDENTIAL = JSON.stringify(AUTH);
const CREDENTIAL_FORMAT_ERROR =
  'communications-smtp secret must be JSON {"user":"<non-empty string>","pass":"<non-empty string>"}';
const TIMEOUTS = { connectionTimeout: SMTP_TIMEOUT_MS, greetingTimeout: SMTP_TIMEOUT_MS, socketTimeout: SMTP_TIMEOUT_MS };

/** A cloud-mode communications environment meeting every cross-variable rule; an override wins, `undefined` removes. */
function cloudSource(overrides: Overrides = {}): NodeJS.ProcessEnv {
  return {
    PORT: '8080',
    OPT2_SERVICE_NAME: 'communications',
    OPT2_ENV: 'cloud',
    OPT2_DB_AUTH: 'iam',
    CLOUD_SQL_INSTANCE: 'opt2-test:us-central1:opt2-services',
    PG_DATABASE: 'masa_services',
    PG_USER: 'communications@opt2-test.iam',
    GOOGLE_CLOUD_PROJECT: 'opt2-test',
    OPT2_TOKEN_ISSUER: 'https://securetoken.google.com/opt2-test',
    OPT2_TOKEN_AUDIENCE: 'opt2-test',
    OPT2_STATE_DIR: '/srv/opt2/state',
    OPT2_TASKS_ADAPTER: 'cloud',
    OPT2_STORAGE_ADAPTER: 'cloud',
    SMTP_HOST: 'smtp-relay.example.com',
    SMTP_PORT: '587',
    MAILPIT_API_URL: 'http://127.0.0.1:8025',
    TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...overrides,
  };
}

/** Issues of the EnvValidationError `loadEnv` throws for `source`; fails the test when it parses. */
function envIssues(source: NodeJS.ProcessEnv): string[] {
  try {
    loadEnv(communicationsEnvSchema, source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
  throw new Error('loadEnv accepted the environment');
}

const stateDirs: string[] = [];

/** Builds the app over test fakes for every port but the mail transport, which buildApp creates from `overrides`. */
async function buildWith(overrides: Overrides): Promise<FastifyInstance> {
  const env = await testEnv(overrides);
  stateDirs.push(env.OPT2_STATE_DIR);
  return buildApp({
    env,
    clock: TEST_CLOCK,
    verifierOverride: testVerifier(),
    db: createRecordingDb(),
    publisher: createCapturingPublisher(),
    taskPort: createFakeTaskPort(),
    deliveryStatus: createFakeDeliveryStatus(),
    senderAddress: createFakeSenderAddress(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dir of stateDirs.splice(0)) removeTestStateDir(dir);
});

describe('SMTP_CREDENTIAL in communicationsEnvSchema', () => {
  it.each([
    { label: 'SMTP_CREDENTIAL unset', overrides: {}, contains: [CLOUD_REQUIRED], absent: [] },
    { label: 'SMTP_CREDENTIAL blank', overrides: { SMTP_CREDENTIAL: '  ' }, contains: [CLOUD_REQUIRED], absent: [] },
    {
      label: 'SMTP_CREDENTIAL and SMTP_HOST unset',
      overrides: { SMTP_HOST: undefined },
      contains: ['SMTP_HOST: is required', CLOUD_REQUIRED],
      absent: [],
    },
    {
      label: 'an invalid OPT2_ENV and no SMTP_CREDENTIAL',
      overrides: { OPT2_ENV: 'staging' },
      contains: [expect.stringMatching(/^OPT2_ENV: /)],
      absent: [CLOUD_REQUIRED],
    },
  ])('reports the issues of a cloud environment with $label', ({ overrides, contains, absent }) => {
    const issues = envIssues(cloudSource(overrides));

    expect(issues).toEqual(expect.arrayContaining(contains));
    for (const issue of absent) expect(issues).not.toContain(issue);
  });

  it.each([
    { label: 'cloud with SMTP_CREDENTIAL', mode: 'cloud', credential: CREDENTIAL, expected: CREDENTIAL },
    { label: 'local without SMTP_CREDENTIAL', mode: 'local', credential: undefined, expected: undefined },
    { label: 'local with SMTP_CREDENTIAL', mode: 'local', credential: CREDENTIAL, expected: CREDENTIAL },
    { label: 'local with a blank SMTP_CREDENTIAL', mode: 'local', credential: ' ', expected: undefined },
  ])('parses $label', async ({ mode, credential, expected }) => {
    const overrides = { SMTP_CREDENTIAL: credential };
    const env = mode === 'cloud' ? loadEnv(communicationsEnvSchema, cloudSource(overrides)) : await testEnv(overrides);
    stateDirs.push(env.OPT2_STATE_DIR);

    expect(env.OPT2_ENV).toBe(mode);
    expect(env.SMTP_CREDENTIAL).toBe(expected);
  });
});

describe('buildApp SMTP transport', () => {
  it.each([
    { label: 'AUTH over STARTTLS on 587', port: 587, credential: CREDENTIAL, tls: { secure: false, requireTLS: true, auth: AUTH } },
    { label: 'AUTH over implicit TLS on 465', port: 465, credential: CREDENTIAL, tls: { secure: true, requireTLS: false, auth: AUTH } },
    { label: 'no AUTH without SMTP_CREDENTIAL', port: 1025, credential: undefined, tls: { secure: false } },
  ])('opens the transport with $label and closes it with the app', async ({ port, credential, tls }) => {
    const app = await buildWith({ SMTP_HOST: 'relay.test', SMTP_PORT: String(port), SMTP_CREDENTIAL: credential });
    try {
      await app.ready();

      expect(mailer.createTransport.mock.calls).toStrictEqual([[{ host: 'relay.test', port, ...tls, ...TIMEOUTS }]]);
      expect(vi.mocked(createService)).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
    expect(mailer.close).toHaveBeenCalledTimes(1);
  });

  it.each(['c0-not-json-secret', '{"user":"comms-user"}', '{"user":"","pass":"comms-pass"}'])(
    'rejects the malformed SMTP_CREDENTIAL %j before createService runs, without echoing it',
    async (credential) => {
      const failure = await buildWith({ SMTP_CREDENTIAL: credential }).then(
        async (app) => {
          await app.close();
          return undefined;
        },
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(CREDENTIAL_FORMAT_ERROR);
      expect((failure as Error).message).not.toContain(credential);
      expect(vi.mocked(createService)).not.toHaveBeenCalled();
      expect(mailer.createTransport).not.toHaveBeenCalled();
    },
  );
});
