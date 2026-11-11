/** Push consumer registration of programs-sites on its own site registry topic. */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SECRET_FILES, PUBSUB_INVOKER_ROLE, localSecretPath, recordedRoutes } from '@opt2/platform/auth';
import { pushPath, registerConsumers, subscriptionName, type EventPublisher } from '@opt2/platform/events';
import { createLogger } from '@opt2/platform/logging';
import { createService, loadEnv, type FastifyInstance } from '@opt2/platform/service-kit';
import { SITE_CHANGED_TOPIC, tenantRegistryConsumer, type SiteChangedPayload, type TenantDb } from '@opt2/platform/tenancy';
import {
  SITE_CHANGED_SUBSCRIPTION,
  siteChangedSchema,
  siteChangedValidator,
  siteRegistryConsumerRegistration,
} from '../../src/events/consumers.js';

const contract = JSON.parse(
  readFileSync(new URL('../../contracts/events/programs-sites.site.changed.v1.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const REQUIRED_FIELDS = [
  'siteId',
  'publicUserPoolId',
  'privateUserPoolId',
  'categoryPoolId',
  'filePoolId',
  'displayPoolId',
  'contentPoolIds',
  'domains',
] as const;

function sitePayload(overrides: Partial<SiteChangedPayload> = {}): Record<string, unknown> {
  return {
    siteId: 'tenant-a',
    publicUserPoolId: 'umbrella',
    privateUserPoolId: 'tenant-a',
    categoryPoolId: 'tenant-a',
    filePoolId: 'tenant-a',
    displayPoolId: 'tenant-a',
    contentPoolIds: ['tenant-a', 'umbrella'],
    domains: ['a.example.test', 'www.a.example.test'],
    ...overrides,
  };
}

function withoutField(field: (typeof REQUIRED_FIELDS)[number]): Record<string, unknown> {
  const { [field]: _removed, ...rest } = sitePayload();
  return rest;
}

/** TenantDb fake for registration-only tests; it runs no SQL. */
function memoryDb(): TenantDb {
  const noSql = (): Promise<never> => Promise.reject(new Error('consumer registration runs no SQL'));
  return { schema: 'programs_sites', withTenant: noSql, withMetadata: noSql, end: async () => undefined };
}

/** EventPublisher fake for registration-only tests; it publishes nothing. */
function idlePublisher(): EventPublisher {
  const noPublish = (): Promise<never> => Promise.reject(new Error('consumer registration publishes nothing'));
  return { publish: noPublish, publishRaw: noPublish, close: async () => undefined };
}

let stateDir: string;

// createService's local auth reads the verification key and push key from OPT2_STATE_DIR.
beforeAll(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'opt2-programs-sites-consumers-'));
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

/** A programs-sites service app over a fake database that is never queried. */
async function serviceApp(): Promise<FastifyInstance> {
  const app = await createService({
    name: 'programs-sites',
    version: '1.0.0',
    env: loadEnv(undefined, {
      PORT: '8113',
      OPT2_SERVICE_NAME: 'programs-sites',
      OPT2_ENV: 'local',
      OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
      OPT2_TOKEN_ISSUER: 'opt2-local-identity',
      OPT2_TOKEN_AUDIENCE: 'opt2-local',
      OPT2_STATE_DIR: stateDir,
      TZ: 'UTC',
    }),
    pool: memoryDb(),
    logger: createLogger({ service: 'programs-sites', version: '1.0.0', env: 'local', destination: { write: () => undefined } }),
  });
  apps.push(app);
  return app;
}

describe('site registry consumer registration', () => {
  it('reads the site.changed payload schema unchanged from the service contract', () => {
    expect(siteChangedSchema).toStrictEqual(contract);
    expect(siteChangedSchema.$id).toBe(contract.$id);
    expect(siteChangedSchema.$id).toBe('urn:opt2:programs-sites:event:programs-sites.site.changed.v1');
  });

  it('subscribes programs-sites to the platform site.changed topic as <consumer>.<topic>', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('programs-sites', SITE_CHANGED_TOPIC));
    expect(SITE_CHANGED_SUBSCRIPTION).toBe('programs-sites.programs-sites.site.changed.v1');
  });

  it('applies deliveries with the platform tenant registry consumer against the contract schema', () => {
    expect(siteRegistryConsumerRegistration.consumer).toBe(tenantRegistryConsumer);
    expect(siteRegistryConsumerRegistration.payloadSchema).toBe(siteChangedSchema);
    expect(siteRegistryConsumerRegistration.consumer.kind).toBe(siteChangedValidator.meta.kind);
  });

  it('passes the platform registration check and mounts the push route of its subscription', async () => {
    const app = await serviceApp();

    registerConsumers(app, { service: 'programs-sites', consumers: [siteRegistryConsumerRegistration], publisher: idlePublisher() });

    expect(recordedRoutes(app).filter((route) => route.url.startsWith('/internal/v1/events/'))).toStrictEqual([
      {
        method: 'POST',
        url: pushPath(SITE_CHANGED_SUBSCRIPTION),
        config: { transport: 'pubsub-push', requires: [PUBSUB_INVOKER_ROLE] },
      },
    ]);
    expect(pushPath(SITE_CHANGED_SUBSCRIPTION)).toBe('/internal/v1/events/programs-sites.programs-sites.site.changed.v1');
  });
});

describe('site.changed payload validator', () => {
  it('declares a state topic without tenant fan-out under the contract $id', () => {
    expect(siteChangedValidator.meta).toStrictEqual({ kind: 'state' });
    expect(siteChangedValidator.schemaId).toBe(contract.$id);
  });

  it.each<{ name: string; payload: Record<string, unknown> }>([
    { name: 'a site with its own pools and domain aliases', payload: sitePayload() },
    {
      name: 'a site whose pools all belong to the umbrella site',
      payload: sitePayload({
        publicUserPoolId: 'umbrella',
        privateUserPoolId: 'umbrella',
        categoryPoolId: 'umbrella',
        filePoolId: 'umbrella',
        displayPoolId: 'umbrella',
        contentPoolIds: ['umbrella'],
      }),
    },
    { name: 'a site without domains or content pools', payload: sitePayload({ contentPoolIds: [], domains: [] }) },
  ])('accepts $name', ({ payload }) => {
    expect(siteChangedValidator.validatePayload(payload)).toStrictEqual({ ok: true, value: payload });
  });

  it.each<{ name: string; payload: Record<string, unknown>; errors: string[]; schemaPaths: string[] }>([
    {
      name: 'a property the contract does not declare',
      payload: { ...sitePayload(), tenantId: 'tenant-a' },
      errors: ['/ must NOT have additional properties (tenantId)'],
      schemaPaths: ['#/additionalProperties'],
    },
    ...REQUIRED_FIELDS.map((field) => ({
      name: `a payload without ${field}`,
      payload: withoutField(field),
      errors: [`/ must have required property '${field}'`],
      schemaPaths: ['#/required'],
    })),
    {
      name: 'an empty site id',
      payload: sitePayload({ siteId: '' }),
      errors: ['/siteId must NOT have fewer than 1 characters'],
      schemaPaths: ['#/properties/siteId/minLength'],
    },
    {
      name: 'an empty content pool id',
      payload: sitePayload({ contentPoolIds: ['tenant-a', ''] }),
      errors: ['/contentPoolIds/1 must NOT have fewer than 1 characters'],
      schemaPaths: ['#/properties/contentPoolIds/items/minLength'],
    },
    {
      name: "Masa's comma-separated contentPoolID text instead of a list",
      payload: sitePayload({ contentPoolIds: 'tenant-a,umbrella' }),
      errors: ['/contentPoolIds must be array'],
      schemaPaths: ['#/properties/contentPoolIds/type'],
    },
    {
      name: 'a null pool id',
      payload: sitePayload({ filePoolId: null }),
      errors: ['/filePoolId must be string'],
      schemaPaths: ['#/properties/filePoolId/type'],
    },
  ])('rejects $name', ({ payload, errors, schemaPaths }) => {
    expect(siteChangedValidator.validatePayload(payload)).toStrictEqual({ ok: false, errors, schemaPaths });
  });
});
