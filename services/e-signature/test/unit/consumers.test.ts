// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumer registration of e-signature on the programs-sites site registry topic. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SECRET_FILES, PUBSUB_INVOKER_ROLE, localSecretPath, recordedRoutes } from '@opt2/platform/auth';
import { compileTopicSchema, pushPath, registerConsumers, subscriptionName } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type TenantDb } from '@opt2/platform/tenancy';
import { createCapturingPublisher, registryPayloads } from '@opt2/platform/testing';
import { SITE_CHANGED_SUBSCRIPTION, consumers, siteChangedSchema } from '../../src/events/consumers.js';

const HTTP_METHODS = ['get', 'put', 'post', 'patch', 'delete'];

const producerContract = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

// js-yaml is not declared here, so it is loaded through the declared json-schema-to-typescript, which depends on it.
const requireHere = createRequire(import.meta.url);
const { load } = createRequire(requireHere.resolve('json-schema-to-typescript'))('js-yaml') as {
  load: (text: string) => unknown;
};

/** Push operations the e-signature OpenAPI contract declares under `/internal/v1/events/`. */
function contractPushOperations(): Array<{ method: string; url: string; operationId: unknown }> {
  const contract = load(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as {
    paths: Record<string, Record<string, { operationId?: unknown }>>;
  };
  return Object.entries(contract.paths)
    .filter(([url]) => url.startsWith('/internal/v1/events/'))
    .flatMap(([url, item]) =>
      Object.entries(item)
        .filter(([method]) => HTTP_METHODS.includes(method))
        .map(([method, op]) => ({ method: method.toUpperCase(), url, operationId: op.operationId })),
    );
}

/** TenantDb fake for registration-only tests; it runs no SQL. */
function memoryDb(): TenantDb {
  const noSql = (): Promise<never> => Promise.reject(new Error('consumer registration runs no SQL'));
  return { schema: 'esignature', withTenant: noSql, withMetadata: noSql, end: async () => undefined };
}

const fixturePayloads = registryPayloads().map((payload) => ({ siteId: payload.siteId, payload }));
const sitePayload = registryPayloads()[0]!;

const invalidPayloads = [
  {
    label: 'without a siteId',
    payload: Object.fromEntries(Object.entries(sitePayload).filter(([key]) => key !== 'siteId')),
  },
  { label: 'with an empty siteId', payload: { ...sitePayload, siteId: '' } },
  { label: 'with a contentPoolIds string', payload: { ...sitePayload, contentPoolIds: 'tenant-a' } },
  { label: 'with an undeclared property', payload: { ...sitePayload, tenantId: 'tenant-a' } },
];

const siteChangedValidator = compileTopicSchema(siteChangedSchema);

let stateDir: string;

// createService's local auth reads the verification key and push key from OPT2_STATE_DIR.
beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-e-signature-consumers-'));
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const files = {
    [LOCAL_SECRET_FILES.tokenSigningPublicKey]: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    [LOCAL_SECRET_FILES.pubsubPushKey]: randomUUID(),
  };
  for (const [file, content] of Object.entries(files)) {
    const target = localSecretPath(stateDir, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.opt2.shutdown()));
});

/** An e-signature service app over a fake database that is never queried. */
async function serviceApp(): Promise<FastifyInstance> {
  const app = await createService({
    name: 'e-signature',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8120',
      OPT2_SERVICE_NAME: 'e-signature',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    pool: memoryDb(),
    logger: createLogger({ service: 'e-signature', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

describe('e-signature site registry consumer', () => {
  it('reads the site.changed payload schema unchanged from the programs-sites contract', () => {
    expect(siteChangedSchema).toStrictEqual(producerContract);
  });

  it('declares the site.changed topic with the state kind the registry consumer applies', () => {
    expect(siteChangedValidator.meta.kind).toBe(tenantRegistryConsumer.kind);
  });

  it.each(fixturePayloads)('accepts the $siteId fixture site.changed payload', ({ payload }) => {
    expect(siteChangedValidator.validatePayload(payload)).toStrictEqual({ ok: true, value: payload });
  });

  it.each(invalidPayloads)('rejects a site.changed payload $label', ({ payload }) => {
    expect(siteChangedValidator.validatePayload(payload).ok).toBe(false);
  });

  it('subscribes e-signature to the programs-sites site.changed topic as <consumer>.<topic>', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('e-signature', SITE_CHANGED_TOPIC));
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('e-signature.programs-sites.site.changed.v1');
  });

  it('registers only the platform tenant registry consumer, validated against the producer schema', () => {
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumer).toBe(tenantRegistryConsumer);
    expect(consumers[0]?.payloadSchema).toBe(siteChangedSchema);
  });

  it('mounts one push route for its subscription, at the pushSiteChanged path of the e-signature contract', async () => {
    const app = await serviceApp();
    const publisher = createCapturingPublisher();
    const mountedBefore = recordedRoutes(app).length;

    registerConsumers(app, { service: 'e-signature', consumers, publisher });

    const mounted = recordedRoutes(app).slice(mountedBefore);
    expect(mounted).toStrictEqual([
      {
        method: 'POST',
        url: pushPath(SITE_CHANGED_SUBSCRIPTION),
        config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
      },
    ]);
    expect(pushPath(SITE_CHANGED_SUBSCRIPTION)).toBe('/internal/v1/events/e-signature.programs-sites.site.changed.v1');
    expect(contractPushOperations()).toStrictEqual(
      mounted.map(({ method, url }) => ({ method, url, operationId: 'pushSiteChanged' })),
    );
  });
});
