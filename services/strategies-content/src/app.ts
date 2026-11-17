/** Composition root of the strategies-content service. */
import { readFile } from 'node:fs/promises';
import { createPublisher, registerConsumers, type EventPublisher } from '@opt2/platform/events';
import { serializeError } from '@opt2/platform/logging';
import { registerMigrationHandlers, registerWritePositionHeader } from '@opt2/platform/migration-kit';
import {
  IDENTITY_SERVICE,
  baseEnvSchema,
  createService,
  loadEnv,
  optionalEnvString,
  processEnvSchema,
  publisherEmulatorHost,
  systemClock,
  z,
  type Clock,
  type CreateServiceOptions,
  type FastifyInstance,
  type LoadedEnv,
} from '@opt2/platform/service-kit';
import { createStoragePort, type StoragePort } from '@opt2/platform/storage';
import type { TaskPort } from '@opt2/platform/tasks';
import type { TenantDb } from '@opt2/platform/tenancy';
import { contentConsumers } from './events/consumers.js';
import { registerJobRoutes } from './jobs/index.js';
import { mappings, units } from './migration/mappings/index.js';
import { createExportObjects } from './migration/objects.js';
import { OWNER, SCHEMA, createContentRepository } from './repo/repository.js';
import { LEGACY_API_PREFIXES, registerRoutes } from './routes/index.js';
import { rawSurfaceOf } from './routes/v1/raw.js';
import { createContentTaskPort, registerContentQueueControl } from './tasks/port.js';

// Default project of the harness's local Pub/Sub topology; OPT2_ENV=cloud makes GOOGLE_CLOUD_PROJECT required.
const LOCAL_PROJECT_ID = 'opt2-local';

/** ColdFusion boolean spellings of the `variations` setting, and those of them that read as true. */
const CF_BOOLEAN = /^(?:true|yes|1|false|no|0)$/i;
const CF_TRUE = /^(?:true|yes|1)$/i;

/**
 * Base variables plus configBean `variations` from `MURA_VARIATIONS`, a ColdFusion boolean that is false when unset;
 * requires this service's own name, its database and the URLs of identity and of itself, the target of its own tasks.
 */
export const contentEnvSchema = processEnvSchema(
  baseEnvSchema.extend({
    MURA_VARIATIONS: optionalEnvString(z.string().regex(CF_BOOLEAN, 'must be true, yes, 1, false, no or 0')).transform(
      (value) => value !== undefined && CF_TRUE.test(value),
    ),
  }),
  { service: OWNER, callees: [OWNER, IDENTITY_SERVICE], database: true },
);

// LoadedEnv rather than z.infer: createService, the storage port and the task port need the adapter choices loadEnv always sets.
/** Parsed strategies-content environment, as `loadEnv(contentEnvSchema)` returns it. */
export type ContentEnv = Readonly<LoadedEnv<typeof contentEnvSchema>>;

/** Dependencies `buildApp` uses instead of building its own from the environment; the app never closes injected ones. */
export interface BuildAppOptions {
  env?: ContentEnv;
  clock?: Clock;
  verifierOverride?: CreateServiceOptions['verifierOverride'];
  db?: TenantDb;
  publisher?: EventPublisher;
  taskPort?: TaskPort;
  storage?: StoragePort;
}

/** Version of the package manifest, which sits one level above both `src/` and `dist/`. */
async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return manifest.version;
}

/** Builds the strategies-content Fastify app with every route and hook registered; never listens. */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? loadEnv(contentEnvSchema);
  const clock = options.clock ?? systemClock;
  // Checked before createService acquires anything; an injected publisher needs no emulator.
  const emulatorHost = options.publisher === undefined ? publisherEmulatorHost(env) : undefined;
  const app = await createService({
    name: OWNER,
    version: await packageVersion(),
    env,
    clock,
    verifierOverride: options.verifierOverride,
    // Legacy serves the JSON API, feed, render and variation leads in any letter case; the gateway forwards them as sent.
    noCasePathPrefixes: LEGACY_API_PREFIXES,
    surfaceOf: rawSurfaceOf,
    // createService takes an injected pool or the schema whose pool it opens, never both.
    ...(options.db === undefined ? { schema: SCHEMA } : { pool: options.db }),
  });

  // Only what buildApp created is closed, the task port before the publisher; injected instances belong to the caller.
  const owned: { taskPort?: TaskPort; publisher?: EventPublisher } = {};
  app.addHook('onClose', async () => {
    try {
      await owned.taskPort?.close();
    } finally {
      await owned.publisher?.close();
    }
  });

  try {
    const { db, logger } = app.opt2;
    if (db === undefined) throw new Error(`${OWNER}: createService opened no database`);

    // Signs local URLs on the clock the signed-file route verifies them with.
    const storage = options.storage ?? (await createStoragePort(env, { now: () => clock.now().getTime() }));
    const taskPort = options.taskPort ?? (owned.taskPort = await createContentTaskPort(env, { db, clock, logger }));
    // An injected throwaway pool names its own schema; the service's own pool names `content`.
    const repository = createContentRepository({ clock, schema: db.schema });
    // Must precede the routes and registerMigrationHandlers, which refuses to register without it.
    registerWritePositionHeader(app);

    await registerRoutes(app, { env, repository, storage, taskPort, clock });
    registerMigrationHandlers(app, {
      owner: OWNER,
      repository: repository.platform,
      mappings,
      units,
      exportObjects: createExportObjects({ storage }),
    });
    // Publishes dead letters only: strategies-content produces no topic, so it has no outbox or sweep.
    const publisher =
      options.publisher ??
      (owned.publisher = createPublisher({ projectId: env.GOOGLE_CLOUD_PROJECT ?? LOCAL_PROJECT_ID, emulatorHost }));
    registerConsumers(app, { service: OWNER, consumers: contentConsumers(repository), publisher, db });
    registerJobRoutes(app, { repository, clock, storage });
    registerContentQueueControl(app, { port: taskPort, serviceUrls: env.OPT2_SERVICE_URLS, clock });
    return app;
  } catch (err) {
    await closePartialApp(app, options.db === undefined);
    throw err;
  }
}

/** Closes a failed build's app with its owned resources, its service client and, when `ownsPool`, its pool; failures are logged. */
async function closePartialApp(app: FastifyInstance, ownsPool: boolean): Promise<void> {
  const { client, db, logger } = app.opt2;
  for (const step of [() => app.close(), () => client.close(), () => (ownsPool ? db?.end() : undefined)]) {
    try {
      await step();
    } catch (err) {
      logger.error({ error: serializeError(err) }, 'start-up cleanup failed');
    }
  }
}
