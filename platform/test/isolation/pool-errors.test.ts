import { trace } from '@opentelemetry/api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger, serializeError } from '../../src/logging/index.js';
import { tenantDbFromPool, type CommitErrorHandler, type TenantDb, type TxBase } from '../../src/tenancy/index.js';
import { TENANT_A, createThrowawaySchema, pgAvailable, runCleanup, testPgConfig, type ThrowawaySchema } from '../../src/testing/index.js';
import { MemorySpanExporter, shutdownTracing, startTracing } from '../../src/tracing/sdk.js';

const REQUIRED_PG_ENV = ['PG_HOST', 'PG_PORT', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'] as const;
const ADMIN_SHUTDOWN = '57P01';
const TRACE_KEYS = ['traceId', 'spanId', 'traceSampled'] as const;

type Run = (db: TenantDb, fn: (tx: TxBase) => Promise<unknown>) => Promise<unknown>;

const TRANSACTIONS: readonly [string, Run][] = [
  ['withTenant', (db, fn) => db.withTenant(TENANT_A.tenantId, fn)],
  ['withMetadata', (db, fn) => db.withMetadata(fn)],
  ['withMetadata under an abort signal', (db, fn) => db.withMetadata(fn, { signal: new AbortController().signal })],
];

let handle: ThrowawaySchema | undefined;
const uncaught = vi.fn();

/** The throwaway schema handle created in beforeAll. */
function schema(): ThrowawaySchema {
  if (handle === undefined) {
    throw new Error('The throwaway schema was not created');
  }
  return handle;
}

/** A TenantDb over a fresh single-connection app pool whose onError logs as service-kit does, with its log lines. */
function harness(): { db: TenantDb; onError: ReturnType<typeof vi.fn<CommitErrorHandler>>; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'platform',
    version: '0.0.0',
    env: 'local',
    destination: { write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>) },
  });
  const onError = vi.fn<CommitErrorHandler>((err) => logger.error({ error: serializeError(err) }, 'database pool error'));
  const db = tenantDbFromPool(schema().connect('app', { max: 1 }), { schema: schema().schema, onError });
  return { db, onError, lines };
}

/** Runs `fn` inside an active request span. */
function inRequestSpan<T>(fn: () => Promise<T>): Promise<T> {
  return trace.getTracer('pool-errors').startActiveSpan('request', async (span) => {
    try {
      return await fn();
    } finally {
      span.end();
    }
  });
}

/** The PostgreSQL backend pid of the connection `tx` runs on. */
async function backendPid(tx: TxBase): Promise<number> {
  const { rows } = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  const pid = rows[0]?.pid;
  if (pid === undefined) {
    throw new Error('pg_backend_pid() returned no row');
  }
  return pid;
}

/** Terminates backend `pid` from the bootstrap user's pool, as a PostgreSQL shutdown does. */
async function terminate(pid: number): Promise<void> {
  const { rows } = await schema().adminPool.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [pid]);
  expect(rows[0]?.ok, `pg_terminate_backend(${String(pid)})`).toBe(true);
}

/** Asserts one reported 57P01 error, logged without trace fields, and no uncaught exception. */
function expectReportedOnceOutsideTrace(h: ReturnType<typeof harness>): void {
  expect(uncaught).not.toHaveBeenCalled();
  expect(h.onError).toHaveBeenCalledOnce();
  expect(h.onError.mock.calls[0]?.[0]).toMatchObject({ code: ADMIN_SHUTDOWN });
  expect(h.lines).toHaveLength(1);
  expect(h.lines[0]).toMatchObject({ severity: 'ERROR', message: 'database pool error' });
  for (const key of TRACE_KEYS) {
    expect(h.lines[0]).not.toHaveProperty(key);
  }
}

describe('pool connection errors against PostgreSQL', () => {
  beforeAll(async () => {
    const missing = REQUIRED_PG_ENV.filter((name) => !process.env[name]);
    if (missing.length > 0) {
      throw new Error(`The pool error isolation suite needs ${missing.join(', ')} in the environment`);
    }
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`The pool error isolation suite cannot reach PostgreSQL at ${host}:${String(port)}`);
    }
    process.on('uncaughtException', uncaught);
    await startTracing({ serviceName: 'pool-errors', version: '0.0.0', exporter: new MemorySpanExporter() });
    handle = await createThrowawaySchema({ service: 'isope' });
  });

  afterAll(async () => {
    process.off('uncaughtException', uncaught);
    await runCleanup('pool error suite', [() => handle?.drop(), () => shutdownTracing()]);
  });

  it.each(TRANSACTIONS)('fails a %s transaction whose connection is terminated, then serves the next one', async (_label, run) => {
    const h = harness();
    try {
      let lost: number | undefined;
      const failed = inRequestSpan(() =>
        run(h.db, async (tx) => {
          lost = await backendPid(tx);
          await terminate(lost);
          await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());
          return tx.query('SELECT 1');
        }),
      );

      await expect(failed).rejects.toThrow(/not queryable/);
      expectReportedOnceOutsideTrace(h);
      const next = await run(h.db, backendPid);
      expect(next).toEqual(expect.any(Number));
      expect(next).not.toBe(lost);
    } finally {
      await h.db.end();
    }
  });

  it('reports the termination of an idle connection outside the trace it was opened in, then reconnects', async () => {
    const h = harness();
    try {
      const lost = await inRequestSpan(() => h.db.withTenant(TENANT_A.tenantId, backendPid));

      await terminate(lost);
      await vi.waitFor(() => expect(h.onError).toHaveBeenCalled());

      expectReportedOnceOutsideTrace(h);
      expect(await h.db.withTenant(TENANT_A.tenantId, backendPid)).not.toBe(lost);
    } finally {
      await h.db.end();
    }
  });
});
