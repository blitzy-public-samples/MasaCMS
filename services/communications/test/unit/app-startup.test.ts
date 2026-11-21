// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Process start-up: the environments communicationsEnvSchema refuses, and what a buildApp failing after createService closes. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '@opt2/platform/logging';
import { EnvValidationError, createService } from '@opt2/platform/service-kit';
import { createCapturingPublisher, testVerifier } from '@opt2/platform/testing';
import { buildApp, type CommunicationsEnv } from '../../src/app.js';
import {
  TEST_CLOCK,
  createFakeDeliveryStatus,
  createFakeMailTransport,
  createFakeSenderAddress,
  createFakeTaskPort,
  createRecordingDb,
  removeTestStateDir,
  testEnv,
  type FakeMailTransport,
} from '../helpers/app.js';

vi.mock('@opt2/platform/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/service-kit')>();
  return { ...actual, createService: vi.fn(actual.createService) };
});

type Overrides = Readonly<Record<string, string | undefined>>;

const URLS: Readonly<Record<string, string>> = {
  communications: 'http://127.0.0.1:8115',
  identity: 'http://127.0.0.1:8111',
  surveys: 'http://127.0.0.1:8117',
};
const CLEANUP_SECRET = 'c7-relay-secret';

const stateDirs: string[] = [];

afterEach(() => {
  for (const dir of stateDirs.splice(0)) removeTestStateDir(dir);
  vi.mocked(createService).mockClear();
});

/** OPT2_SERVICE_URLS naming every callee but `missing`. */
function urlsWithout(missing: string): string {
  return JSON.stringify(Object.fromEntries(Object.entries(URLS).filter(([name]) => name !== missing)));
}

/** The safe log text of the EnvValidationError `testEnv(overrides)` rejects with; fails the test when it parses. */
async function refusalText(overrides: Overrides): Promise<string> {
  const failure = await testEnv(overrides).then(
    (env) => {
      stateDirs.push(env.OPT2_STATE_DIR);
      return undefined;
    },
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(EnvValidationError);
  return serializeError(failure).message;
}

/**
 * Runs buildApp over fakes with an unparsed environment lacking the self entry its outbox sweep targets, so it fails after
 * createService; createService gets a capturing logger and, standing in for the pool it would open, the recording database.
 */
async function buildWithoutSelfEntry(opts: { ownsPool: boolean; mail: FakeMailTransport }) {
  const parsed = await testEnv();
  stateDirs.push(parsed.OPT2_STATE_DIR);
  const { communications: _self, ...callees } = parsed.OPT2_SERVICE_URLS;
  const env: CommunicationsEnv = { ...parsed, OPT2_SERVICE_URLS: callees };
  const db = createRecordingDb();
  const end = vi.spyOn(db, 'end');
  const publisher = createCapturingPublisher();
  const closePublisher = vi.spyOn(publisher, 'close');
  const taskPort = createFakeTaskPort();
  const lines: string[] = [];
  const logger = createLogger({
    service: 'communications',
    version: '1.0.0',
    env: 'local',
    destination: { write: (line: string) => void lines.push(line) },
  });
  const actual = vi.mocked(createService).getMockImplementation();
  if (actual === undefined) throw new TypeError('createService is not mocked');
  vi.mocked(createService).mockImplementationOnce((options) => actual({ ...options, schema: undefined, pool: db, logger }));

  const failure = await buildApp({
    env,
    clock: TEST_CLOCK,
    verifierOverride: testVerifier(),
    ...(opts.ownsPool ? {} : { db }),
    publisher,
    taskPort,
    mailTransport: opts.mail,
    deliveryStatus: createFakeDeliveryStatus(),
    senderAddress: createFakeSenderAddress(),
  }).then(
    async (app) => {
      await app.close();
      return undefined;
    },
    (error: unknown) => error,
  );
  return { failure, end, closePublisher, taskPort, lines };
}

describe('communicationsEnvSchema', () => {
  it.each([
    {
      label: 'another OPT2_SERVICE_NAME',
      overrides: { OPT2_SERVICE_NAME: 'surveys' },
      text: 'surveys: invalid environment (OPT2_SERVICE_NAME: must be communications)',
    },
    ...Object.keys(URLS).map((callee) => ({
      label: `no OPT2_SERVICE_URLS.${callee}`,
      overrides: { OPT2_SERVICE_URLS: urlsWithout(callee) },
      text: `communications: invalid environment (OPT2_SERVICE_URLS.${callee}: is required)`,
    })),
    {
      label: 'no OPT2_SERVICE_URLS',
      overrides: { OPT2_SERVICE_URLS: undefined },
      text:
        'communications: invalid environment (OPT2_SERVICE_URLS.communications: is required; ' +
        'OPT2_SERVICE_URLS.identity: is required; OPT2_SERVICE_URLS.surveys: is required)',
    },
    {
      label: 'no OPT2_DB_AUTH',
      overrides: { OPT2_DB_AUTH: undefined },
      text: 'communications: invalid environment (OPT2_DB_AUTH: is required)',
    },
    {
      label: 'no PG_DATABASE',
      overrides: { PG_DATABASE: undefined },
      text: 'communications: invalid environment (PG_DATABASE: is required)',
    },
  ])('refuses an environment with $label, naming what is missing', async ({ overrides, text }) => {
    await expect(refusalText(overrides)).resolves.toBe(text);
  });
});

describe('buildApp failing after createService', () => {
  it.each([
    { label: 'the pool it opened', ownsPool: true },
    { label: 'an injected pool', ownsPool: false },
  ])('closes the app, its task port, publisher and mail transport, and ends only $label', async ({ ownsPool }) => {
    const mail = createFakeMailTransport();

    const { failure, end, closePublisher, taskPort, lines } = await buildWithoutSelfEntry({ ownsPool, mail });

    expect(failure).toMatchObject({ name: 'UnknownTaskTargetError' });
    expect(taskPort.closed).toBe(true);
    expect(closePublisher).toHaveBeenCalledTimes(1);
    expect(mail.closed).toBe(true);
    expect(end).toHaveBeenCalledTimes(ownsPool ? 1 : 0);
    expect(lines).toStrictEqual([]);
  });

  it('logs a failed cleanup step sanitized, still ends the pool, and rethrows the build failure', async () => {
    const mail = createFakeMailTransport();
    vi.spyOn(mail, 'close').mockRejectedValueOnce(new Error(`relay refused ${CLEANUP_SECRET}`));

    const { failure, end, lines } = await buildWithoutSelfEntry({ ownsPool: true, mail });

    expect(failure).toMatchObject({ name: 'UnknownTaskTargetError' });
    const records = lines.map((line) => JSON.parse(line) as unknown);
    expect(records).toMatchObject([{ message: 'start-up cleanup failed', severity: 'ERROR', error: { type: 'Error' } }]);
    expect(lines.join('\n')).not.toContain(CLEANUP_SECRET);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
