/** The route registry: the route set it composes, and the login-mail settings it builds from Masa's `MURA_<KEY>` configuration. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVOCATION_HEADER, collectRouteMatrix } from '@opt2/platform/auth';
import type { EventEnvelope } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { registerWritePositionHeader } from '@opt2/platform/migration-kit';
import { createOutbox } from '@opt2/platform/outbox';
import { createService, loadEnv, type BaseEnv, type FastifyInstance, type ServiceClient } from '@opt2/platform/service-kit';
import { createCapturingPublisher, mintServiceToken, testVerifier, writeTestSecrets } from '@opt2/platform/testing';
import { createTokenService } from '../../src/domain/tokens.js';
import { identityPayloadValidators } from '../../src/events/publish.js';
import { registerRoutes } from '../../src/routes/index.js';
import { createMemoryIdentityRepo, createRecordingDb, type RecordingDb } from '../helpers/memory-repo.js';
import { EDITOR } from '../helpers/rows.js';
import { CLOCK, SERVICE, SITE_A, buildIdentityApp, credentialsFor, defaultSeed, registryAnswer, subjectNamed } from '../helpers/service.js';

interface Composed {
  app: FastifyInstance;
  db: RecordingDb;
}

interface MailPayload {
  from: string;
  subject: string;
  text: string;
  returnId: string;
  userId: string;
}

/** No route module calls another service while serving the requests below. */
const NO_CALLS: ServiceClient = {
  request: (req) => Promise.reject(new Error(`unexpected call ${req.service} ${req.method} ${req.path}`)),
  close: () => Promise.resolve(),
};

const MASA_KEYS = ['MURA_SITEIDINURLS', 'MURA_INDEXFILEINURLS', 'MURA_HASHURLS', 'MURA_ADMINSSL', 'MURA_PORT', 'MURA_CONTEXT'] as const;

let stateDir: string;
let env: BaseEnv;
const opened: FastifyInstance[] = [];

/** The identity routes as `registerRoutes` composes them over the memory repository, with `masa` as the only `MURA_*` variables. */
async function compose(masa: Partial<Record<(typeof MASA_KEYS)[number], string>> = {}): Promise<Composed> {
  for (const key of MASA_KEYS) vi.stubEnv(key, masa[key]);
  const db = createRecordingDb();
  db.respond(/FROM identity\.tenant_registry\b/, registryAnswer);
  const repository = createMemoryIdentityRepo(defaultSeed(), { clock: CLOCK });
  const logger = createLogger({ service: SERVICE, version: '1.0.0', env: 'local', destination: { write: () => undefined } });
  createOutbox({ service: SERVICE, db, publisher: createCapturingPublisher(), logger, clock: CLOCK, payloadValidators: identityPayloadValidators });
  const app = await createService({ name: SERVICE, version: '1.0.0', env, verifierOverride: testVerifier(SERVICE), logger });
  opened.push(app);
  registerWritePositionHeader(app);
  await registerRoutes(app, { repository, db, clock: CLOCK, client: NO_CALLS, tokens: createTokenService({ env, clock: CLOCK, db, repo: repository }) });
  await app.ready();
  return { app, db };
}

function declarations(app: FastifyInstance): string[] {
  return collectRouteMatrix(app).routes.map((route) => JSON.stringify(route)).sort();
}

function mailPayloads(db: RecordingDb): MailPayload[] {
  return db
    .writes()
    .filter((write) => write.verb === 'INSERT' && write.table === 'identity.outbox')
    .map((write) => (JSON.parse(String(write.values[5])) as EventEnvelope).payload as MailPayload);
}

/** POSTs the forgot-password form as the gateway relays an anonymous login screen. */
async function requestLoginMail(app: FastifyInstance, siteid: string) {
  const invocation = await mintServiceToken({ caller: 'gateway', audience: SERVICE });
  return app.inject({
    method: 'POST',
    url: '/v1/login-mail',
    headers: { [INVOCATION_HEADER]: `Bearer ${invocation}`, host: 'admin.example.test:8080' },
    payload: { email: EDITOR.contact.email ?? '', siteid },
  });
}

beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-identity-routes-'));
  await writeTestSecrets(stateDir);
  env = loadEnv(undefined, {
    PORT: '8111',
    OPT2_SERVICE_NAME: SERVICE,
    OPT2_ENV: 'local',
    OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
    OPT2_TOKEN_ISSUER: 'opt2-local-identity',
    OPT2_TOKEN_AUDIENCE: 'opt2-local',
    OPT2_STATE_DIR: stateDir,
    TZ: 'UTC',
  });
});

afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.opt2.shutdown()));
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe('registerRoutes', () => {
  it('registers every route family with the declarations the composed test service carries', async () => {
    const reference = await buildIdentityApp();
    try {
      const { app } = await compose();
      expect(declarations(app)).toEqual(declarations(reference.app));
    } finally {
      await reference.close();
    }
  });

  it.each([
    ['unset flags take the settings template values', {}, 'http://admin.example.test/index.cfm/{id}/'],
    ['CFML booleans are taken as given', { MURA_SITEIDINURLS: 'yes', MURA_INDEXFILEINURLS: 'no' }, 'http://admin.example.test/default/{id}/'],
    ['a flag that is not a CFML boolean keeps the configBean default', { MURA_SITEIDINURLS: 'sometimes' }, 'http://admin.example.test/index.cfm/default/{id}/'],
    ['the JSON API settings give the protocol, port and context', { MURA_ADMINSSL: 'true', MURA_PORT: '8443', MURA_CONTEXT: '/masa' }, 'https://admin.example.test:8443/masa/index.cfm/{id}/'],
  ])('builds the empty-site mail link: %s', async (_name, masa, link) => {
    const { app, db } = await compose(masa);

    const res = await requestLoginMail(app, '');

    expect(res.json()).toEqual({ status: 'messagesent' });
    const [mail] = mailPayloads(db);
    expect(mail).toMatchObject({ from: 'Masa CMS', subject: 'Masa CMS Account Information' });
    expect(mail?.text).toContain(`${link.replace('{id}', mail?.returnId ?? '')}?userID=${mail?.userId ?? ''}`);
  });

  it('refuses a site-scoped mail with the legacy 503 before writing anything, as identity holds no site mail settings', async () => {
    const { app, db } = await compose();

    const res = await requestLoginMail(app, SITE_A);

    expect(res.statusCode).toBe(503);
    expect(db.writes()).toEqual([]);
  });

  it('lists the session sites under the empty site name', async () => {
    const { app } = await compose();

    const res = await app.inject({ method: 'GET', url: '/v1/sessions/current/sites', headers: await credentialsFor(subjectNamed('s2')) });

    const { sites } = res.json() as { sites: Array<{ siteID: string; site: string }> };
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.map((entry) => entry.site)).toEqual(sites.map(() => ''));
  });
});
