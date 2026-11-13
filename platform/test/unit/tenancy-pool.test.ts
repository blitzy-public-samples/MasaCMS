import { EventEmitter } from 'node:events';
import { PassThrough, type Duplex } from 'node:stream';
import { trace } from '@opentelemetry/api';
import pg, { type Pool, type QueryResult } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setDiagnosticLogger } from '../../src/logging/diagnostics.js';
import { createLogger, serializeError } from '../../src/logging/logger.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { tenantDbFromPool } from '../../src/tenancy/pool.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { CommitErrorHandler } from '../../src/tenancy/transaction.js';
import { MemorySpanExporter, shutdownTracing, startTracing } from '../../src/tracing/sdk.js';

const TENANT_A = tenantIdForSite('tenant-a');
const SECRET = ['c10', 'sentinel', 'secret'].join('-');
const MAILBOX = ['c10', 'sentinel', 'mailbox'].join('-');
/** Error text with credentials, session material, an email address and line-forging control characters. */
const LEAKY_TEXT = [
  `connect postgres://svc:${SECRET}@db/x?sslpassword=${SECRET} refused`,
  `Cookie: CFID=${SECRET}`,
  `owner ${MAILBOX}@example.com\r\u001b[31mforged\u2028line\u0085end`,
].join('\n');
const RAW_CONTROL = /[\p{Cc}\u2028\u2029]/u;

/** A TenantDb over a fake pool whose connections accept every statement, with the pool listeners it registered. */
function setup(onError?: CommitErrorHandler) {
  const result = (text: string): QueryResult => ({ command: text, rowCount: 0, oid: 0, fields: [], rows: [] });
  const client = Object.assign(new EventEmitter(), { query: vi.fn((text: string) => Promise.resolve(result(text))), release: vi.fn() });
  const on = vi.fn();
  const db = tenantDbFromPool({ connect: vi.fn(() => Promise.resolve(client)), on } as unknown as Pool, { schema: 'people', onError });
  const poolListener = (name: string) => on.mock.calls.find(([event]) => event === name)?.[1] as ((...args: unknown[]) => void) | undefined;
  return { client, db, listener: poolListener('error'), poolListener };
}

type Setup = ReturnType<typeof setup>;

/** Emits `err` on the pool as pg-pool does for an idle client: with the client as a second argument. */
function idleClientError(h: Setup, err: Error): Promise<void> {
  h.listener?.(err, h.client);
  return Promise.resolve();
}

/** Emits `err` on a client between pg-pool's 'acquire' and 'release' events, as a lost connection of an open transaction does. */
function checkedOutClientError(h: Setup, err: Error): Promise<void> {
  h.poolListener('acquire')?.(h.client);
  h.client.emit('error', err);
  h.poolListener('release')?.(err, h.client);
  return Promise.resolve();
}

/** Commits a tenant transaction whose one commit callback, registered without a handler, throws `err`. */
function commitCallbackFailure(h: Setup, err: Error): Promise<void> {
  return h.db.withTenant(TENANT_A, (tx) => {
    tx.onCommit(() => {
      throw err;
    });
    return Promise.resolve();
  });
}

const DELIVERIES = [
  ['an idle-client error', idleClientError],
  ['a checked-out client error', checkedOutClientError],
  ['a commit callback failure without its own handler', commitCallbackFailure],
] as const;

afterEach(() => {
  setDiagnosticLogger(undefined);
  vi.restoreAllMocks();
});

describe('tenantDbFromPool default error handler', () => {
  it.each(DELIVERIES)('emits %s as a redacted single-line OPT2_TENANCY warning', async (_label, deliver) => {
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await deliver(h, new Error(LEAKY_TEXT));

    expect(emitWarning).toHaveBeenCalledOnce();
    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(options?.code).toBe('OPT2_TENANCY');
    expect(message).toBe('[REDACTED]');
    expect(options?.detail).toMatch(/^Error: \[REDACTED\]\\n {4}at \S/);
    for (const text of [message, options?.detail]) {
      expect(text).toEqual(expect.any(String));
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(MAILBOX);
      expect(text).not.toContain('forged');
      expect(text).not.toMatch(RAW_CONTROL);
    }
  });

  it.each(DELIVERIES)('writes %s to a registered diagnostic logger instead of a process warning', async (_label, deliver) => {
    const lines: Record<string, unknown>[] = [];
    setDiagnosticLogger(
      createLogger({
        service: 'people',
        version: '1.0.0',
        env: 'local',
        destination: { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
      }),
    );
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await deliver(h, new Error(LEAKY_TEXT));

    expect(emitWarning).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    expect(lines[0]).toMatchObject({ severity: 'WARNING', message: 'OPT2_TENANCY: [REDACTED]', error: { message: '[REDACTED]' } });
    expect(JSON.stringify(lines[0])).not.toContain(SECRET);
    expect(JSON.stringify(lines[0])).not.toContain(MAILBOX);
  });

  it('omits the detail of an error without a stack', () => {
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const err = new Error('idle client lost');
    delete err.stack;

    h.listener?.(err, h.client);

    expect(emitWarning).toHaveBeenCalledExactlyOnceWith('[REDACTED]', { code: 'OPT2_TENANCY', detail: undefined });
  });

  it('keeps the SQLSTATE of an idle-client PostgreSQL error', () => {
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const err = Object.assign(new Error(LEAKY_TEXT), { name: 'error', code: '57P01', severity: 'FATAL' });

    h.listener?.(err, h.client);

    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(message).toBe('PostgreSQL error 57P01');
    expect(options?.detail).toMatch(/^error: PostgreSQL error 57P01\\n {4}at \S/);
    expect(options?.detail).not.toContain(SECRET);
  });

  it.each(DELIVERIES)('leaves a caller-supplied onError the raw error of %s and emits no warning', async (_label, deliver) => {
    const onError = vi.fn<CommitErrorHandler>();
    const h = setup(onError);
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const err = new Error(LEAKY_TEXT);

    await deliver(h, err);

    expect(onError).toHaveBeenCalledExactlyOnceWith(err);
    expect(err.message).toBe(LEAKY_TEXT);
    expect(emitWarning).not.toHaveBeenCalled();
  });

  it('listens on a client only while it is checked out and reports its first connection error once', () => {
    const onError = vi.fn<CommitErrorHandler>();
    const h = setup(onError);
    const lost = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });

    h.poolListener('acquire')?.(h.client);
    const listening = h.client.listenerCount('error');
    h.client.emit('error', lost);
    h.client.emit('error', new Error('Connection terminated unexpectedly'));
    h.poolListener('release')?.(lost, h.client);

    expect(listening).toBe(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(lost);
    expect(h.client.listenerCount('error')).toBe(0);
  });
});

describe('tenantDbFromPool error trace context', () => {
  beforeAll(async () => {
    await startTracing({ serviceName: 'tenancy-pool-test', version: '0.0.0', exporter: new MemorySpanExporter() });
  });

  afterAll(async () => {
    await shutdownTracing();
  });

  it.each([
    ['an idle-client error', 'outside', idleClientError],
    ['a checked-out client error', 'outside', checkedOutClientError],
    ['a commit callback failure without its own handler', 'inside', commitCallbackFailure],
  ] as const)('logs %s raised during a request span %s that trace', async (_label, where, deliver) => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'people',
      version: '1.0.0',
      env: 'local',
      destination: { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    });
    const h = setup((err) => logger.error({ error: serializeError(err) }, 'database pool error'));

    const { traceId, spanId } = await trace.getTracer('tenancy-pool-test').startActiveSpan('request', async (span) => {
      try {
        await deliver(h, new Error('connection lost'));
        return span.spanContext();
      } finally {
        span.end();
      }
    });

    expect(lines).toHaveLength(1);
    expect({ traceId: lines[0]?.traceId, spanId: lines[0]?.spanId }).toEqual(where === 'inside' ? { traceId, spanId } : {});
  });
});

describe('tenantDbFromPool listen', () => {
  const handlers = { onNotification: vi.fn(), onListening: vi.fn(), onLost: vi.fn() };

  /** Replaces pg.Client with a stub whose connect never settles and whose end runs `end`; returns each config it received. */
  function stubClients(end: () => Promise<void> = () => Promise.resolve()): pg.ClientConfig[] {
    const configs: pg.ClientConfig[] = [];
    vi.spyOn(pg, 'Client').mockImplementation(function (config?: pg.ClientConfig | string) {
      configs.push(config as pg.ClientConfig);
      return Object.assign(new EventEmitter(), { connect: () => new Promise(() => undefined), end }) as unknown as pg.Client;
    });
    return configs;
  }

  it.each([
    [undefined, 10_000],
    [0, 10_000],
    [250, 250],
  ])('bounds connect and LISTEN of a pool with connectionTimeoutMillis %s at %i ms, keeping its hidden password, SSL key and stream', async (configured, bound) => {
    const configs = stubClients();
    const stream = (): Duplex => new PassThrough();
    const pool = new pg.Pool({ host: '127.0.0.1', password: SECRET, ssl: { key: SECRET }, stream, connectionTimeoutMillis: configured });
    const db = tenantDbFromPool(pool, { schema: 'people' });

    await db.listen?.('tasks_people', handlers).close();
    await db.end();

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ host: '127.0.0.1', stream, connectionTimeoutMillis: bound, query_timeout: bound });
    expect(configs[0]?.password).toBe(SECRET);
    expect(Object.keys(configs[0] ?? {})).not.toContain('password');
    expect(configs[0]?.ssl).toBe(pool.options.ssl);
    expect((configs[0]?.ssl as { key?: string } | undefined)?.key).toBe(SECRET);
    expect(pool.options.connectionTimeoutMillis).toBe(configured);
  });

  it('refuses to listen once end() has started, while its listeners are still closing', async () => {
    let closed: () => void = () => undefined;
    const configs = stubClients(
      () =>
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
    );
    const pool = new pg.Pool({ host: '127.0.0.1' });
    const db = tenantDbFromPool(pool, { schema: 'people' });
    db.listen?.('tasks_people', handlers);

    const ending = db.end();
    expect(pool.ending).toBe(false);
    expect(() => db.listen?.('tasks_people', handlers)).toThrow('Cannot listen on a TenantDb after end()');
    closed();
    await ending;

    expect([configs.length, pool.ended]).toEqual([1, true]);
  });

  it('ends the pool and runs onEnd although a listener fails to close, then rejects with that failure', async () => {
    const failure = new Error('listener close failed');
    stubClients(() => Promise.reject(failure));
    const pool = new pg.Pool({ host: '127.0.0.1' });
    const onEnd = vi.fn();
    const db = tenantDbFromPool(pool, { schema: 'people', onEnd });
    db.listen?.('tasks_people', handlers);

    await expect(db.end()).rejects.toBe(failure);

    expect([pool.ended, onEnd.mock.calls.length]).toEqual([true, 1]);
  });
});
