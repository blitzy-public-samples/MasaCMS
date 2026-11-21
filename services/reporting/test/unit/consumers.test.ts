// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Push consumer registration of reporting on the programs-sites site registry topic. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SECRET_FILES, PUBSUB_INVOKER_ROLE, localSecretPath, recordedRoutes } from '@opt2/platform/auth';
import {
  compileTopicSchema,
  pushPath,
  registerConsumers,
  subscriptionName,
  type EventPublisher,
} from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type TenantDb } from '@opt2/platform/tenancy';
import { SITE_CHANGED_SUBSCRIPTION, consumers, siteChangedSchema } from '../../src/events/consumers.js';

const producerContract = JSON.parse(
  readFileSync(new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const sitePayload: Record<string, unknown> = {
  siteId: 'tenant-a',
  publicUserPoolId: 'umbrella',
  privateUserPoolId: 'tenant-a',
  categoryPoolId: 'tenant-a',
  filePoolId: 'tenant-a',
  displayPoolId: 'tenant-a',
  contentPoolIds: ['tenant-a', 'umbrella'],
  domains: ['a.example.test'],
};
const { siteId: _siteId, ...sitePayloadWithoutSiteId } = sitePayload;

/** Push operations the reporting OpenAPI contract declares under `/internal/v1/events/`. */
function contractPushOperations(): Array<{ method: string; url: string }> {
  const text = readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8');
  return [...text.matchAll(/^ {2}(\/internal\/v1\/events\/[^\s:]+):\n((?: {4,}\S.*\n)*)/gm)].flatMap(([, url = '', body = '']) =>
    [...body.matchAll(/^ {4}(get|put|post|patch|delete):$/gm)].map(([, method = '']) => ({ method: method.toUpperCase(), url })),
  );
}

/** TenantDb fake for registration-only tests; it runs no SQL. */
function memoryDb(): TenantDb {
  const noSql = (): Promise<never> => Promise.reject(new Error('consumer registration runs no SQL'));
  return { schema: 'reporting', withTenant: noSql, withMetadata: noSql, end: async () => undefined };
}

/** EventPublisher fake for registration-only tests; it publishes nothing. */
function idlePublisher(): EventPublisher {
  const noPublish = (): Promise<never> => Promise.reject(new Error('consumer registration publishes nothing'));
  return { publish: noPublish, publishRaw: noPublish, close: async () => undefined };
}

let stateDir: string;

// createService's local auth reads the verification key and push key from OPT2_STATE_DIR.
beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-reporting-consumers-'));
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

/** A reporting service app over a fake database that is never queried. */
async function serviceApp(): Promise<FastifyInstance> {
  const app = await createService({
    name: 'reporting',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8116',
      OPT2_SERVICE_NAME: 'reporting',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    pool: memoryDb(),
    logger: createLogger({ service: 'reporting', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

describe('reporting site registry consumer', () => {
  it('reads the site.changed payload schema unchanged from the programs-sites contract', () => {
    expect(siteChangedSchema).toStrictEqual(producerContract);
  });

  it('accepts a site payload the programs-sites contract allows', () => {
    expect(compileTopicSchema(siteChangedSchema).validatePayload(sitePayload)).toStrictEqual({ ok: true, value: sitePayload });
  });

  it.each<{ name: string; payload: Record<string, unknown>; schemaPath: string }>([
    { name: 'without its site id', payload: sitePayloadWithoutSiteId, schemaPath: '#/required' },
    { name: 'with a property the contract does not declare', payload: { ...sitePayload, tenantId: 'tenant-a' }, schemaPath: '#/additionalProperties' },
  ])('rejects a site payload $name', ({ payload, schemaPath }) => {
    expect(compileTopicSchema(siteChangedSchema).validatePayload(payload)).toMatchObject({ ok: false, schemaPaths: [schemaPath] });
  });

  it('subscribes reporting to the programs-sites site.changed topic as <consumer>.<topic>', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('reporting', SITE_CHANGED_TOPIC));
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('reporting.programs-sites.site.changed.v1');
  });

  it('registers only the platform tenant registry consumer, validated against the producer schema', () => {
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumer).toBe(tenantRegistryConsumer);
    expect(consumers[0]?.payloadSchema).toBe(siteChangedSchema);
  });

  it('mounts one push route for its subscription, at the path the reporting contract declares', async () => {
    const app = await serviceApp();
    const mountedBefore = recordedRoutes(app).length;

    registerConsumers(app, { service: 'reporting', consumers, publisher: idlePublisher() });

    const mounted = recordedRoutes(app).slice(mountedBefore);
    expect(mounted).toStrictEqual([
      {
        method: 'POST',
        url: pushPath(SITE_CHANGED_SUBSCRIPTION),
        config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
      },
    ]);
    expect(pushPath(SITE_CHANGED_SUBSCRIPTION)).toBe('/internal/v1/events/reporting.programs-sites.site.changed.v1');
    expect(contractPushOperations()).toStrictEqual(mounted.map(({ method, url }) => ({ method, url })));
  });
});
