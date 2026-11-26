import { createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { tenantDbFromPool, type NotificationHandlers, type NotificationListener, type TenantDb } from '../../src/tenancy/index.js';
import { TENANT_A, createThrowawaySchema, pgAvailable, runCleanup, testPgConfig, type ThrowawaySchema } from '../../src/testing/index.js';

const NOTIFY_SQL = 'SELECT pg_notify($1, $2)';
const WAIT = { timeout: 5_000, interval: 20 };
// AuthenticationOk then ReadyForQuery: the reply of a server that starts a session and then answers nothing.
const STARTED_SESSION = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

/** Handlers recording every payload, LISTEN start and loss. */
function recorder(): NotificationHandlers & { payloads: string[]; listening: number; lost: Error[] } {
  const record = {
    payloads: [] as string[],
    listening: 0,
    lost: [] as Error[],
    onNotification: (payload: string) => void record.payloads.push(payload),
    onListening: () => void (record.listening += 1),
    onLost: (err: Error) => void record.lost.push(err),
  };
  return record;
}

describe('TenantDb.listen', () => {
  let handle: ThrowawaySchema;
  let db: TenantDb;
  let channel: string;
  const open: NotificationListener[] = [];

  /** Opens a recorded listener on `channel` over `db` and waits until it listens. */
  async function listening(on: TenantDb = db): Promise<{ listener: NotificationListener; record: ReturnType<typeof recorder> }> {
    const record = recorder();
    const listener = on.listen?.(channel, record);
    if (listener === undefined) throw new Error('TenantDb has no listen');
    open.push(listener);
    await vi.waitFor(() => expect(record.listening).toBe(1), WAIT);
    return { listener, record };
  }

  /** Commits a tenant transaction that notifies `payload` on `channel`. */
  const notify = (payload: string): Promise<unknown> => db.withTenant(TENANT_A.tenantId, (tx) => tx.query(NOTIFY_SQL, [channel, payload]));

  /** Listening sessions of the app role, by backend pid. */
  async function listenSessions(): Promise<number[]> {
    const { rows } = await handle.adminPool.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE usename = $1 AND query LIKE 'LISTEN %'",
      [handle.roles.app],
    );
    return rows.map((row) => row.pid);
  }

  beforeAll(async () => {
    const config = testPgConfig();
    if (!(await pgAvailable())) {
      throw new Error(`PostgreSQL at PG_HOST:PG_PORT (${config.host}:${String(config.port)}) is not reachable`);
    }
    handle = await createThrowawaySchema({ service: 'notify' });
    db = handle.app;
    channel = `listen_${handle.schema}`;
  });

  afterEach(async () => {
    await Promise.all(open.splice(0).map((listener) => listener.close()));
  });

  afterAll(async () => {
    await runCleanup('TenantDb.listen suite', [() => handle?.drop()]);
  });

  it('delivers notifications of committed tenant transactions in commit order, none of a rolled-back one, and none after close', async () => {
    const { listener, record } = await listening();
    const sentinel = await listening();
    await notify('first');
    await expect(
      db.withTenant(TENANT_A.tenantId, async (tx) => {
        await tx.query(NOTIFY_SQL, [channel, 'rolled-back']);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    await notify('second');
    await vi.waitFor(() => expect(record.payloads).toEqual(['first', 'second']), WAIT);

    await listener.close();
    await notify('after-close');
    await vi.waitFor(() => expect(sentinel.record.payloads).toEqual(['first', 'second', 'after-close']), WAIT);
    expect(record.payloads).toEqual(['first', 'second']);
    expect([record.lost, sentinel.record.lost]).toEqual([[], []]);
  });

  it('reports a terminated session as lost, listens again and delivers what is sent afterwards', async () => {
    const { record } = await listening();
    // Sessions of earlier tests' closed listeners may still be exiting.
    await vi.waitFor(async () => expect(await listenSessions()).toHaveLength(1), WAIT);
    const [pid] = await listenSessions();
    await handle.adminPool.query('SELECT pg_terminate_backend($1)', [pid]);
    await vi.waitFor(() => expect(record.lost).toHaveLength(1), WAIT);
    expect(record.lost[0]).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(record.listening).toBe(2), WAIT);
    expect(await listenSessions()).not.toContain(pid);
    await notify('after-reconnect');
    await vi.waitFor(() => expect(record.payloads).toEqual(['after-reconnect']), WAIT);
  });

  it('reports each failed connection attempt and stops retrying once closed', async () => {
    const unreachable = tenantDbFromPool(new pg.Pool({ ...testPgConfig(), port: 1, max: 1 }), { schema: handle.schema });
    try {
      const record = recorder();
      const listener = unreachable.listen?.(channel, record);
      await vi.waitFor(() => expect(record.lost).toHaveLength(1), WAIT);
      await listener?.close();
      await sleep(1_200);
      expect(record.lost).toHaveLength(1);
      expect(record.listening).toBe(0);
    } finally {
      await unreachable.end();
    }
  });

  it.each([
    ['the connection', undefined, 'timeout expired'],
    ['LISTEN', STARTED_SESSION, 'Query read timeout'],
  ])('gives up at connectionTimeoutMillis when the server never answers %s, leaving no socket or retry once closed', async (_stage, reply, message) => {
    const sockets = new Set<Socket>();
    let accepted = 0;
    const stalled = createServer((socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('data', () => {
        if (reply !== undefined) socket.write(reply);
      });
      // Flowing, so the server sees the client's FIN and closes its side.
      socket.resume();
    });
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
    const { port } = stalled.address() as AddressInfo;
    const silent = tenantDbFromPool(new pg.Pool({ ...testPgConfig(), host: '127.0.0.1', port, connectionTimeoutMillis: 200, max: 1 }), {
      schema: handle.schema,
    });
    try {
      const record = recorder();
      const listener = silent.listen?.(channel, record);
      await vi.waitFor(() => expect(record.lost).toHaveLength(1), WAIT);
      expect(record.lost[0]?.message).toBe(message);
      await listener?.close();
      await vi.waitFor(() => expect(sockets.size).toBe(0), WAIT);
      await sleep(1_200);
      expect([accepted, record.lost.length, record.listening]).toEqual([1, 1, 0]);
    } finally {
      await silent.end();
      await new Promise((resolve) => stalled.close(resolve));
    }
  });

  it('closes its open listeners on end() and refuses to listen afterwards', async () => {
    const own = tenantDbFromPool(handle.connect('app'), { schema: handle.schema });
    await listening(own);
    await vi.waitFor(async () => expect(await listenSessions()).toHaveLength(1), WAIT);
    await own.end();
    await vi.waitFor(async () => expect(await listenSessions()).toEqual([]), WAIT);
    expect(() => own.listen?.(channel, recorder())).toThrow('Cannot listen on a TenantDb after end()');
  });

  it.each(['Listen', 'a-b', 'a"b', '', '1abc', 'x'.repeat(64)])('rejects channel %j with TypeError', (name) => {
    expect(() => db.listen?.(name, recorder())).toThrow(TypeError);
  });
});
