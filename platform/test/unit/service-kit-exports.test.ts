import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z as zod } from 'zod';
import * as clock from '../../src/service-kit/clock.js';
import * as client from '../../src/service-kit/client.js';
import * as context from '../../src/service-kit/context.js';
import * as createServiceModule from '../../src/service-kit/create-service.js';
import * as csrfHook from '../../src/service-kit/csrf-hook.js';
import * as env from '../../src/service-kit/env.js';
import * as eventScope from '../../src/service-kit/event-scope.js';
import * as signalBoundFetch from '../../src/service-kit/fetch.js';
import * as kit from '../../src/service-kit/index.js';
import {
  baseEnvSchema,
  createService,
  loadEnv,
  z,
  type CreateServiceOptions,
  type FastifyInstance,
  type LoadedEnv,
} from '../../src/service-kit/index.js';

const SERVICE_KIT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/service-kit');

const VALUE_EXPORTS = {
  './clock.js': [clock, ['systemClock', 'fixedClock', 'isClock']],
  './env.js': [
    env,
    [
      'baseEnvSchema',
      'loadEnv',
      'envModeIssues',
      'EnvValidationError',
      'publisherEmulatorHost',
      'optionalEnvString',
      'requiredEnvString',
      'envUrl',
      'envPort',
    ],
  ],
  './context.js': [
    context,
    [
      'requestContext',
      'currentRequestContext',
      'requireRequestContext',
      'runWithRequestContext',
      'newRequestContext',
      'requestIdFrom',
      'recordWritePosition',
      'REQUEST_ID_HEADER',
      'NoRequestContextError',
      'RequestAbortedError',
      'throwIfRequestAborted',
    ],
  ],
  './client.js': [
    client,
    [
      'createServiceClient',
      'decodeServiceBody',
      'SERVICE_CALL_TIMEOUT_MS',
      'ServiceUnavailableError',
      'UnknownServiceError',
    ],
  ],
  './fetch.js': [signalBoundFetch, ['createSignalBoundFetch']],
  './create-service.js': [
    createServiceModule,
    [
      'abandonOnDisconnect',
      'createService',
      'defaultSurfaceOf',
      'isUnstorableTextError',
      'legacyParamsOf',
      'multipartFilesOf',
      'recordOutcomeReason',
      'sendLegacyResponse',
      'LEGACY_POST_LIMIT_BYTES',
    ],
  ],
  './event-scope.js': [eventScope, ['recordEventScope']],
  './csrf-hook.js': [csrfHook, ['csrfPreHandler', 'csrfTokenFrom', 'CSRF_CONSUME_PATH', 'IDENTITY_SERVICE']],
} as const satisfies Record<string, readonly [Record<string, unknown>, readonly string[]]>;

const reexported = Object.entries(VALUE_EXPORTS).flatMap(([from, [module, names]]) =>
  names.map((name) => [name, from, module] as const),
);

const localEnv = {
  PORT: '8115',
  OPT2_SERVICE_NAME: 'communications',
  OPT2_ENV: 'local',
  OPT2_JWKS_URL: 'http://127.0.0.1:8111/internal/v1/jwks',
  OPT2_TOKEN_ISSUER: 'opt2-local-identity',
  OPT2_TOKEN_AUDIENCE: 'opt2-local',
  TZ: 'UTC',
  SMTP_HOST: '127.0.0.1',
};

describe('@opt2/platform/service-kit barrel', () => {
  it.each(reexported)('exposes %s from %s as the same binding', (name, _from, module) => {
    const value = (kit as Record<string, unknown>)[name];
    expect(typeof value).not.toBe('undefined');
    expect(value).toBe(module[name as keyof typeof module]);
  });

  it('exposes zod as z and no runtime name beyond the listed ones', () => {
    expect(kit.z).toBe(zod);
    expect(Object.keys(kit).sort()).toEqual([...reexported.map(([name]) => name), 'z'].sort());
  });

  it('lets a consumer extend the base schema and load it with the extension typed', () => {
    const schema = baseEnvSchema.extend({ SMTP_HOST: z.string() });
    const loaded = loadEnv(schema, localEnv);
    expectTypeOf(loaded.SMTP_HOST).toEqualTypeOf<string>();
    expectTypeOf(loaded).toEqualTypeOf<Readonly<LoadedEnv<typeof schema>>>();
    expectTypeOf(createService<typeof loaded>).returns.toEqualTypeOf<Promise<FastifyInstance>>();
    expectTypeOf<CreateServiceOptions<typeof loaded>['env']>().toEqualTypeOf<typeof loaded>();
    expect(loaded.SMTP_HOST).toBe('127.0.0.1');
    expect(loaded.OPT2_TASKS_ADAPTER).toBe('local');
  });

  it('keeps service-kit free of outbox, events, tasks, storage and migration-kit imports, and of wildcard re-exports', async () => {
    const files = (await readdir(SERVICE_KIT_DIR)).filter((file) => file.endsWith('.ts'));
    expect(files).toContain('index.ts');
    const forbidden = /from\s+['"]\.\.\/(?:outbox|events|tasks|storage|migration-kit)(?:\/|['"])/;
    for (const file of files) {
      const source = await readFile(path.join(SERVICE_KIT_DIR, file), 'utf8');
      expect(source, file).not.toMatch(forbidden);
      expect(source, file).not.toMatch(/export\s+\*/);
    }
  });
});
