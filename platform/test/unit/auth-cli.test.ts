// `opt2-auth` CLI of @opt2/platform/auth: argument handling, builder loading, route-matrix output and app shutdown.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fastify, type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../../src/auth/cli.js';
import {
  PUBSUB_INVOKER_ROLE,
  Roles,
  collectRouteMatrix,
  registerAuth,
  serializeRouteMatrix,
  type Transport,
  type TransportAuthenticator,
  type TransportSet,
} from '../../src/auth/index.js';

const USAGE = 'usage: opt2-auth matrix --app <module> [--export <name>] [--options <json>] [--out <file>]';

type Builder = (exportName: string, options: unknown) => unknown;
type WriteCallback = (err?: Error | null) => void;

const scope = globalThis as typeof globalThis & { __opt2AuthCliBuilder?: Builder };

const BUILDER_MODULE = `const delegate = (name) => (options) => globalThis.__opt2AuthCliBuilder(name, options);
export const buildApp = delegate('buildApp');
export const buildAdminApp = delegate('buildAdminApp');
export const nope = 42;
`;

const anonymous = (transport: Transport): TransportAuthenticator => ({
  transport,
  authenticate: () => Promise.resolve({}),
});

const TRANSPORTS: TransportSet = {
  service: anonymous('service'),
  'pubsub-push': anonymous('pubsub-push'),
  'cloud-tasks': anonymous('cloud-tasks'),
};

const DECLARED_MATRIX = {
  routes: [
    { method: 'GET', url: '/healthz', transport: 'service', public: true, siteCheck: true },
    { method: 'HEAD', url: '/healthz', transport: 'service', public: true, siteCheck: true },
    {
      method: 'POST',
      url: '/internal/v1/events/people-archived',
      transport: 'pubsub-push',
      requires: [PUBSUB_INVOKER_ROLE],
      siteCheck: false,
    },
    { method: 'GET', url: '/v1/people', transport: 'service', requires: [Roles.siteAdmin, Roles.s2], siteCheck: true },
    { method: 'HEAD', url: '/v1/people', transport: 'service', requires: [Roles.siteAdmin, Roles.s2], siteCheck: true },
  ],
};

let dir: string;
let modulePath: string;
let stdout: string;
let stderr: string;
const apps: FastifyInstance[] = [];

/** A `write` replacement that appends each chunk to `sink` and answers the callback with `error`. */
function capture(sink: (chunk: string) => void, error: Error | null = null) {
  return (chunk: string | Uint8Array, encodingOrCallback?: BufferEncoding | WriteCallback, callback?: WriteCallback): boolean => {
    sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    (typeof encodingOrCallback === 'function' ? encodingOrCallback : callback)?.(error);
    return error === null;
  };
}

/** The message of a usage error written to stderr, between its `opt2-auth: ` prefix and usage suffix. */
function usageMessage(text: string): string {
  const prefix = 'opt2-auth: ';
  const suffix = `; ${USAGE}\n`;
  expect(text.slice(0, prefix.length)).toBe(prefix);
  expect(text.slice(-suffix.length)).toBe(suffix);
  return text.slice(prefix.length, -suffix.length);
}

function trackedApp(): FastifyInstance {
  const app = fastify();
  apps.push(app);
  return app;
}

/** An app with registerAuth applied and one requires, one public and one pubsub-push route without the site check. */
function declaredApp(): FastifyInstance {
  const app = trackedApp();
  registerAuth(app, { transports: TRANSPORTS });
  app.get('/v1/people', { config: { opt2: { requires: [Roles.siteAdmin, Roles.s2] } } }, async () => ({}));
  app.get('/healthz', { config: { opt2: { public: true } } }, async () => ({}));
  app.post(
    '/internal/v1/events/people-archived',
    { config: { opt2: { requires: [PUBSUB_INVOKER_ROLE], transport: 'pubsub-push', siteCheck: false } } },
    async () => ({}),
  );
  return app;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'opt2-auth-cli-'));
  modulePath = join(dir, 'builder.mjs');
  await writeFile(modulePath, BUILDER_MODULE, 'utf8');
  stdout = '';
  stderr = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(
    capture((chunk) => {
      stdout += chunk;
    }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(
    capture((chunk) => {
      stderr += chunk;
    }),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete scope.__opt2AuthCliBuilder;
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await rm(dir, { recursive: true, force: true });
});

describe('main', () => {
  it.each([{ argv: ['--help'] }, { argv: ['-h'] }, { argv: ['matrix', '--app', 'app.mjs', '--help'] }])(
    'prints the help on stdout and exits 0 for $argv',
    async ({ argv }) => {
      expect(await main(argv)).toBe(0);
      expect(stdout.startsWith(`${USAGE}\n\n`)).toBe(true);
      for (const flag of ['--app <module>', '--export <name>', '--options <json>', '--out <file>', '-h, --help']) {
        expect(stdout).toContain(`\n  ${flag} `);
      }
      expect(stdout).toMatch(/\nEnvironment:\n {2}opt2-auth reads no variable itself\./);
      expect(stdout).toMatch(/\nExit codes: 0 [^\n]+, 1 [^\n]+, 2 [^\n]+\n$/);
      expect(stderr).toBe('');
    },
  );

  it('fails with exit code 1 when stdout rejects the write', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(capture(() => undefined, new Error('write EPIPE')));
    expect(await main(['--help'])).toBe(1);
    expect(stderr).toBe('opt2-auth: write EPIPE\n');
  });

  it.each([
    { argv: [], message: /^missing subcommand$/ },
    { argv: ['foo'], message: /^unknown subcommand "foo"$/ },
    { argv: ['matrix', 'extra', '--app', 'app.mjs'], message: /^unknown subcommand "matrix extra"$/ },
    { argv: ['matrix'], message: /^missing --app$/ },
    { argv: ['matrix', '--app', ''], message: /^missing --app$/ },
    { argv: ['matrix', '--app', 'app.mjs', '--options', '{bad'], message: /^--options is not valid JSON: \S/ },
    { argv: ['matrix', '--app', 'app.mjs', '--verbose'], message: /^Unknown option '--verbose'/ },
    { argv: ['matrix', '--app'], message: /^Option '--app <value>' argument missing/ },
  ])('answers $argv with a usage error and exit code 2 without calling a builder', async ({ argv, message }) => {
    const builder = vi.fn<Builder>();
    scope.__opt2AuthCliBuilder = builder;
    expect(await main(argv)).toBe(2);
    expect(usageMessage(stderr)).toMatch(message);
    expect(stdout).toBe('');
    expect(builder).not.toHaveBeenCalled();
  });

  it.each(['nope', 'absent'])('answers --export %s, which is not a function, with a usage error and exit code 2', async (name) => {
    expect(await main(['matrix', '--app', modulePath, '--export', name])).toBe(2);
    expect(usageMessage(stderr)).toBe(`export ${JSON.stringify(name)} of ${modulePath} is not a function`);
    expect(stdout).toBe('');
  });

  it.each([
    { label: 'undefined', built: undefined },
    { label: 'a string', built: 'app' },
    { label: 'an object without ready and close', built: { routes: [] } },
    { label: '{ app } holding a non-app', built: { app: { ready: () => undefined } } },
  ])('fails with exit code 1 when the builder returns $label', async ({ built }) => {
    scope.__opt2AuthCliBuilder = () => built;
    expect(await main(['matrix', '--app', modulePath])).toBe(1);
    expect(stderr).toBe('opt2-auth: the builder returned neither a Fastify instance nor { app }\n');
    expect(stdout).toBe('');
  });

  it.each([
    {
      label: 'throws an Error',
      builder: (): never => {
        throw new Error('database unreachable');
      },
      message: 'database unreachable',
    },
    { label: 'rejects with an Error', builder: () => Promise.reject(new Error('pool exhausted')), message: 'pool exhausted' },
    {
      label: 'throws a non-Error value',
      builder: (): never => {
        throw 'plain failure';
      },
      message: 'plain failure',
    },
  ])('fails with exit code 1 and the error message when the builder $label', async ({ builder, message }) => {
    scope.__opt2AuthCliBuilder = builder;
    expect(await main(['matrix', '--app', modulePath])).toBe(1);
    expect(stderr).toBe(`opt2-auth: ${message}\n`);
    expect(stdout).toBe('');
  });

  it('writes the sorted matrix of the default export to stdout, passes --options and closes the never-listening app', async () => {
    const app = declaredApp();
    const close = vi.spyOn(app, 'close');
    const builder = vi.fn<Builder>(() => app);
    scope.__opt2AuthCliBuilder = builder;
    const options = { siteid: 'tenant-a', limits: [1, 2] };
    const argv = ['matrix', '--app', relative(process.cwd(), modulePath), '--options', JSON.stringify(options)];
    expect(await main(argv)).toBe(0);
    expect(builder).toHaveBeenCalledExactlyOnceWith('buildApp', options);
    expect(stdout).toBe(serializeRouteMatrix(collectRouteMatrix(app)));
    expect(stdout).toBe(`${JSON.stringify(DECLARED_MATRIX, null, 2)}\n`);
    expect(stderr).toBe('');
    expect(close).toHaveBeenCalledOnce();
    expect(app.server.listening).toBe(false);
  });

  it('writes the matrix of an async { app } builder named by --export to --out, creating parent directories', async () => {
    const app = declaredApp();
    const close = vi.spyOn(app, 'close');
    const builder = vi.fn<Builder>(async () => ({ app }));
    scope.__opt2AuthCliBuilder = builder;
    const out = join(dir, 'nested', 'dir', 'matrix.json');
    expect(await main(['matrix', '--app', modulePath, '--export', 'buildAdminApp', '--out', out])).toBe(0);
    expect(builder).toHaveBeenCalledExactlyOnceWith('buildAdminApp', {});
    expect(await readFile(out, 'utf8')).toBe(serializeRouteMatrix(collectRouteMatrix(app)));
    expect(JSON.parse(await readFile(out, 'utf8'))).toStrictEqual(DECLARED_MATRIX);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: 'registerAuth was not applied',
      build: (): FastifyInstance => {
        const app = trackedApp();
        app.get('/healthz', async () => ({}));
        return app;
      },
      asRecord: false,
      message: 'registerAuth was not applied to this Fastify instance',
    },
    {
      label: 'a plugin of the returned { app } fails while it becomes ready',
      build: (): FastifyInstance => {
        const app = declaredApp();
        void app.register(async () => {
          throw new Error('plugin failed');
        });
        return app;
      },
      asRecord: true,
      message: 'plugin failed',
    },
  ])('fails with exit code 1 and still closes the app when $label', async ({ build, asRecord, message }) => {
    const app = build();
    const close = vi.spyOn(app, 'close');
    scope.__opt2AuthCliBuilder = () => (asRecord ? { app } : app);
    expect(await main(['matrix', '--app', modulePath])).toBe(1);
    expect(stderr).toBe(`opt2-auth: ${message}\n`);
    expect(stdout).toBe('');
    expect(close).toHaveBeenCalledOnce();
  });
});
