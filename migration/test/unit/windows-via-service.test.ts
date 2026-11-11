// Unit tests for the CLI's write-window calls: request shape, open's longer bound, and failure mapping.
import { Buffer } from 'node:buffer';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  REQUEST_ID_HEADER,
  ServiceUnavailableError,
  createServiceClient,
  type ServiceClient,
  type ServiceRequest,
  type ServiceResponse,
} from '@opt2/platform/service-kit';
import { describe, expect, it } from 'vitest';

import { loadConfig, type LoadedMigrationConfig } from '../../src/config.js';
import type { MigrationContext, ServiceCaller } from '../../src/context.js';
import {
  STARTUP_ROUTE_KEY,
  WindowCallError,
  completeWindowViaService,
  openWindowViaService,
  resolveWindowViaService,
  type WriteWindow,
} from '../../src/windows/via-service.js';

type WindowContext = Pick<MigrationContext, 'clientAs' | 'config'>;

const CONFIG = loadConfig();
const WINDOW_ID = '6A1B2C3D-4E5F-4061-7283940516273849';
const UNITS = ['content.content', 'content.content_category'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPENED = { windowId: WINDOW_ID, state: 'open', phase: 'executing' };
const RESOLVED: WriteWindow = {
  windowId: WINDOW_ID,
  routeKey: STARTUP_ROUTE_KEY,
  units: UNITS,
  scope: { table: true },
  state: 'closed',
  phase: 'importing',
  phases: [{ phase: 'quiet', at: '2026-03-01T10:00:00.000Z' }],
  rowsImported: 2,
  outcome: 'resolved',
};

/** A context whose `operator` client is `client`; asking for any other caller fails the test. */
function contextOver(client: ServiceClient, config: LoadedMigrationConfig = CONFIG): WindowContext {
  const clientAs = (caller: ServiceCaller): ServiceClient => {
    if (caller !== 'operator') throw new Error(`clientAs(${caller}) was called`);
    return client;
  };
  return { clientAs, config };
}

/** A context answering every call with `answer` merged over a bodiless 200, recording each request. */
function answeringContext(answer: Partial<ServiceResponse>, config?: LoadedMigrationConfig): { ctx: WindowContext; calls: ServiceRequest[] } {
  const calls: ServiceRequest[] = [];
  const client: ServiceClient = {
    request<T>(req: ServiceRequest): Promise<ServiceResponse<T>> {
      calls.push(req);
      return Promise.resolve({ status: 200, headers: {}, body: undefined, ...answer } as ServiceResponse<T>);
    },
    close: () => Promise.resolve(),
  };
  return { ctx: contextOver(client, config), calls };
}

const withOpenBudget = (openBudgetMs: number): LoadedMigrationConfig => ({ ...CONFIG, windows: { ...CONFIG.windows, openBudgetMs } });

type Operation = (ctx: WindowContext) => Promise<unknown>;

const OPEN_DEFAULTS: Operation = (ctx) => openWindowViaService(ctx, { units: UNITS });
const COMPLETE: Operation = (ctx) => completeWindowViaService(ctx, WINDOW_ID, { forwarded: true });
const RESOLVE: Operation = (ctx) => resolveWindowViaService(ctx, WINDOW_ID);

interface RequestCase {
  name: string;
  call: Operation;
  config?: LoadedMigrationConfig;
  status: number;
  answer: unknown;
  request: ServiceRequest;
}

describe('window calls via the migration service', () => {
  it.each<RequestCase>([
    {
      name: 'open fills the start-up route key and table scope and waits the configured budget plus the call bound',
      call: OPEN_DEFAULTS,
      status: 201,
      answer: OPENED,
      request: {
        service: 'migration',
        method: 'POST',
        path: '/internal/v1/windows',
        json: { routeKey: STARTUP_ROUTE_KEY, units: UNITS, scope: { table: true }, requestId: expect.stringMatching(UUID) as unknown },
        headers: { [REQUEST_ID_HEADER]: expect.stringMatching(UUID) as unknown as string },
        userToken: null,
        timeoutMs: 40_000,
      },
    },
    {
      name: 'open sends a given route key and scope and follows a changed budget',
      call: (ctx) => openWindowViaService(ctx, { routeKey: 'admin:csettings.updatesite', units: UNITS, scope: { keys: { siteid: 'tenant-a' } } }),
      config: withOpenBudget(5_000),
      status: 201,
      answer: OPENED,
      request: {
        service: 'migration',
        method: 'POST',
        path: '/internal/v1/windows',
        json: { routeKey: 'admin:csettings.updatesite', units: UNITS, scope: { keys: { siteid: 'tenant-a' } }, requestId: expect.stringMatching(UUID) as unknown },
        headers: { [REQUEST_ID_HEADER]: expect.stringMatching(UUID) as unknown as string },
        userToken: null,
        timeoutMs: 15_000,
      },
    },
    {
      name: 'complete posts the legacy outcome under the client default',
      call: COMPLETE,
      status: 200,
      answer: { state: 'closed' },
      request: { service: 'migration', method: 'POST', path: `/internal/v1/windows/${WINDOW_ID}:complete`, json: { forwarded: true }, userToken: null },
    },
    {
      name: 'resolve posts no body under the client default',
      call: RESOLVE,
      status: 200,
      answer: RESOLVED,
      request: { service: 'migration', method: 'POST', path: `/internal/v1/windows/${WINDOW_ID}:resolve`, userToken: null },
    },
  ])('$name', async ({ call, config, status, answer, request }) => {
    const { ctx, calls } = answeringContext({ status, body: answer }, config);

    await expect(call(ctx)).resolves.toEqual(answer);
    expect(calls).toEqual([request]);
    expect(calls[0]?.timeoutMs).toBe(request.timeoutMs);
  });

  it('open sends a fresh request id each time', async () => {
    const { ctx, calls } = answeringContext({ status: 201, body: OPENED });

    await OPEN_DEFAULTS(ctx);
    await OPEN_DEFAULTS(ctx);

    const ids = calls.map((call) => (call.json as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
  });

  it.each<[string, Operation]>([
    ['open', OPEN_DEFAULTS],
    ['complete', COMPLETE],
    ['resolve', RESOLVE],
  ])('%s answering 503 throws the legacy 503 error', async (_label, call) => {
    const { ctx } = answeringContext({ status: 503, body: { error: { message: 'Leases not taken within 30 s' } } });

    const error = await call(ctx).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({ service: 'migration', message: 'Service migration unavailable (HTTP_503)', cause: { code: 'HTTP_503' } });
  });

  it.each<[string, number, Operation, unknown, string]>([
    ['open', 400, OPEN_DEFAULTS, { error: { message: 'Invalid units' } }, 'Migration windowOpen answered HTTP 400: Invalid units'],
    ['complete', 404, COMPLETE, { error: 'not-found' }, 'Migration windowComplete answered HTTP 404'],
    ['resolve', 409, RESOLVE, { error: { message: 'Window is not import-pending' } }, 'Migration windowResolve answered HTTP 409: Window is not import-pending'],
    ['open', 302, OPEN_DEFAULTS, undefined, 'Migration windowOpen answered HTTP 302'],
  ])('%s answering %s throws WindowCallError with the legacy message', async (_label, status, call, body, message) => {
    const { ctx } = answeringContext({ status, body });

    const error = await call(ctx).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WindowCallError);
    expect(error).toMatchObject({ name: 'WindowCallError', message, status, body });
  });
});

describe('window calls with the platform service client', () => {
  it('lets open outlast the client default while complete stays held to it', async () => {
    const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const timers = new Set<NodeJS.Timeout>();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const opening = req.url === '/internal/v1/windows';
        const timer = setTimeout(() => {
          timers.delete(timer);
          res.writeHead(opening ? 201 : 200, { 'content-type': 'application/json' }).end(JSON.stringify(opening ? OPENED : { state: 'closed' }));
        }, 400);
        timers.add(timer);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = createServiceClient({
      serviceUrls: { migration: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` },
      self: 'operator',
      credentials: { headersFor: () => Promise.resolve({}) },
      timeoutMs: 200,
    });
    try {
      const ctx = contextOver(client);

      await expect(openWindowViaService(ctx, { units: UNITS })).resolves.toEqual(OPENED);
      await expect(completeWindowViaService(ctx, WINDOW_ID, { forwarded: false })).rejects.toBeInstanceOf(ServiceUnavailableError);
      expect(seen.map(({ url }) => url)).toEqual(['/internal/v1/windows', `/internal/v1/windows/${WINDOW_ID}:complete`]);
      expect(JSON.parse(seen[0]?.body ?? '')).toMatchObject({ routeKey: STARTUP_ROUTE_KEY, units: UNITS, scope: { table: true } });
      expect(seen[0]?.headers.authorization).toBeUndefined();
    } finally {
      await client.close();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }
  });
});
