import type { Pool, QueryConfig, QueryResult } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDiagnosticLogger } from '../../src/logging/diagnostics.js';
import { createLogger } from '../../src/logging/logger.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { InvalidTenantIdError, tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import {
  OutsideTenantTransactionError,
  TransactionEndedError,
  TransactionRolledBackError,
  currentTenantTx,
  currentTransaction,
  requireTenantTx,
  runTenantTransaction,
  runTransaction,
  withTenant,
  type CommitErrorHandler,
  type MetadataTx,
  type TenantDb,
  type TenantTx,
  type TransactionRunnerOptions,
  type TxBase,
} from '../../src/tenancy/transaction.js';

const TENANT_A = tenantIdForSite('tenant-a');
const TENANT_B = tenantIdForSite('tenant-b');
const SET_TENANT = "SELECT set_config('app.tenant_id', $1, true)";
const SECRET = ['c10', 'sentinel', 'secret'].join('-');
const MAILBOX = ['c10', 'sentinel', 'mailbox'].join('-');
/** Error text with credentials, session material, echoed input, an email address and line-forging control characters. */
const LEAKY_TEXT = [
  `connect postgres://svc:${SECRET}@db/x?sslpassword=${SECRET} refused`,
  `Cookie: CFID=${SECRET}`,
  `syntax error at or near "'${SECRET}'"`,
  `owner ${MAILBOX}@example.com\r\u001b[31mforged\u2028line\u0085end`,
].join('\n');
const RAW_CONTROL = /[\p{Cc}\u2028\u2029]/u;

type Recorded = [text: string, values: unknown[] | undefined];

/** Structural stand-in for a pg PoolClient that records statements and releases. */
class FakeClient {
  readonly calls: Recorded[] = [];
  readonly releases: (Error | boolean | undefined)[] = [];
  readonly failures = new Map<string, Error>();
  /** Command tags answered in place of the statement text, keyed by statement. */
  readonly commands = new Map<string, string>();
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const sql = typeof text === 'string' ? text : text.text;
    this.calls.push([sql, values]);
    this.events.push(sql);
    const failure = this.failures.get(sql);
    if (failure !== undefined) {
      return Promise.reject(failure);
    }
    return Promise.resolve({ command: this.commands.get(sql) ?? sql, rowCount: 0, oid: 0, fields: [], rows: [] });
  }

  release(err?: Error | boolean): void {
    this.releases.push(err);
    this.events.push('release');
  }
}

function setup() {
  const events: string[] = [];
  const client = new FakeClient(events);
  const connect = vi.fn(() => Promise.resolve(client));
  const onError = vi.fn<CommitErrorHandler>();
  const opts: TransactionRunnerOptions = { schema: 'people', onError };
  return { events, client, connect, onError, opts, pool: { connect } as unknown as Pool };
}

const asMetadata = (base: TxBase): MetadataTx => ({ ...base, kind: 'metadata' });

/** Labelled commit error handlers of every failure shape, each failing with `text`, and whether the failure has a stack. */
function failingHandlers(text: string): (readonly [string, CommitErrorHandler, boolean])[] {
  const nonError: unknown = text;
  return [
    [
      'throws an Error',
      () => {
        throw new Error(text);
      },
      true,
    ],
    ['rejects with an Error', () => Promise.reject(new Error(text)), true],
    [
      'throws a non-Error value',
      () => {
        throw nonError;
      },
      false,
    ],
    ['rejects with a non-Error value', () => Promise.reject(nonError), false],
  ];
}

/** Warning detail of a failure: its frames under `Error: [REDACTED]` on one line, or none without a stack. */
const SAFE_DETAIL = /^Error: \[REDACTED\]\\n {4}at \S/;

/** A promise plus the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

afterEach(() => {
  setDiagnosticLogger(undefined);
  vi.restoreAllMocks();
});

describe('runTenantTransaction', () => {
  it('sets the tenant first, runs the callback, commits and releases', async () => {
    const h = setup();
    const result = await runTenantTransaction(h.pool, h.opts, TENANT_A, async (tx) => {
      await tx.query('SELECT id FROM people.person WHERE id = $1', ['p1']);
      return 'done';
    });

    expect(result).toBe('done');
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, [TENANT_A]],
      ['SELECT id FROM people.person WHERE id = $1', ['p1']],
      ['COMMIT', undefined],
    ]);
    expect(h.client.releases).toEqual([undefined]);
    expect(h.events.at(-1)).toBe('release');
  });

  it('hands the callback a frozen tenant handle with a lower-cased tenant id', async () => {
    const h = setup();
    const tx = await runTenantTransaction(h.pool, h.opts, TENANT_A.toUpperCase(), (t) => Promise.resolve(t));

    expect(tx).toMatchObject({ kind: 'tenant', tenantId: TENANT_A, schema: 'people' });
    expect(Object.isFrozen(tx)).toBe(true);
    expect(h.client.calls[1]).toEqual([SET_TENANT, [TENANT_A]]);
  });

  it.each([
    ['a non-uuid', 'tenant-a'],
    ['an empty string', ''],
    ['a CF-format uuid', 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6'],
  ])('rejects %s before connecting', async (_label, tenantId) => {
    const h = setup();
    const fn = vi.fn(() => Promise.resolve());

    await expect(runTenantTransaction(h.pool, h.opts, tenantId, fn)).rejects.toBeInstanceOf(InvalidTenantIdError);
    expect(h.connect).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('rolls back, releases and rethrows when the callback throws', async () => {
    const h = setup();
    const failure = new Error('boom');

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, async (tx) => {
        await tx.query('INSERT INTO people.person (id) VALUES ($1)', ['p1']);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(h.client.calls.map(([text]) => text)).toEqual([
      'BEGIN',
      SET_TENANT,
      'INSERT INTO people.person (id) VALUES ($1)',
      'ROLLBACK',
    ]);
    expect(h.client.releases).toEqual([undefined]);
  });

  it.each(['BEGIN', SET_TENANT, 'COMMIT'])('rolls back, releases and rethrows when %s fails', async (statement) => {
    const h = setup();
    const failure = new Error(`${statement} failed`);
    h.client.failures.set(statement, failure);
    const committed = vi.fn();
    const sequence = ['BEGIN', SET_TENANT, 'SELECT 1', 'COMMIT'];

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, async (tx) => {
        tx.onCommit(committed);
        await tx.query('SELECT 1');
      }),
    ).rejects.toBe(failure);
    expect(h.client.calls.map(([text]) => text)).toEqual([
      ...sequence.slice(0, sequence.indexOf(statement) + 1),
      'ROLLBACK',
    ]);
    expect(h.client.releases).toEqual([undefined]);
    expect(committed).not.toHaveBeenCalled();
  });

  it('destroys the client when ROLLBACK fails', async () => {
    const h = setup();
    const failure = new Error('boom');
    const rollbackFailure = new Error('connection lost');
    h.client.failures.set('ROLLBACK', rollbackFailure);

    await expect(runTenantTransaction(h.pool, h.opts, TENANT_A, () => Promise.reject(failure))).rejects.toBe(failure);
    expect(h.client.releases).toEqual([rollbackFailure]);
  });
});

describe('metadata transactions', () => {
  it('set an empty app.tenant_id', async () => {
    const h = setup();
    const tx = await runTransaction(h.pool, h.opts, '', asMetadata, async (t) => {
      await t.query('SELECT site_id FROM people.tenant_registry');
      return t;
    });

    expect(tx).toMatchObject({ kind: 'metadata', schema: 'people' });
    expect(h.client.calls).toEqual([
      ['BEGIN', undefined],
      [SET_TENANT, ['']],
      ['SELECT site_id FROM people.tenant_registry', undefined],
      ['COMMIT', undefined],
    ]);
    expect(h.client.releases).toEqual([undefined]);
  });
});

describe('ended transactions', () => {
  it.each([
    ['commits', false],
    ['rolls back', true],
  ])('refuse statements and commit callbacks after the transaction %s', async (_label, fail) => {
    const h = setup();
    let captured: TenantTx | undefined;
    const run = runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
      captured = tx;
      return fail ? Promise.reject(new Error('boom')) : Promise.resolve();
    });
    await (fail ? expect(run).rejects.toThrow('boom') : run);
    const issued = h.client.calls.length;

    await expect(captured?.query('SELECT 1')).rejects.toBeInstanceOf(TransactionEndedError);
    expect(() => captured?.onCommit(() => undefined)).toThrow(TransactionEndedError);
    expect(h.client.calls).toHaveLength(issued);
  });
});

describe('commit callbacks', () => {
  it('run in registration order after COMMIT and release, before the result resolves', async () => {
    const h = setup();
    const result = await runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
      tx.onCommit(async () => {
        h.events.push('first:start');
        await new Promise<void>((resolve) => setImmediate(resolve));
        h.events.push('first:end');
      });
      tx.onCommit(() => {
        h.events.push('second');
      });
      return Promise.resolve('value');
    });

    expect(result).toBe('value');
    expect(h.events).toEqual(['BEGIN', SET_TENANT, 'COMMIT', 'release', 'first:start', 'first:end', 'second']);
  });

  it('never run when the callback throws', async () => {
    const h = setup();
    const committed = vi.fn();
    const own = vi.fn<CommitErrorHandler>();

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
        tx.onCommit(committed, own);
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');
    expect(committed).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  const RUNNERS: readonly (readonly [
    string,
    (h: ReturnType<typeof setup>, fn: (tx: TxBase) => Promise<string>) => Promise<string>,
  ])[] = [
    ['tenant', (h, fn) => runTenantTransaction(h.pool, h.opts, TENANT_A, fn)],
    ['metadata', (h, fn) => runTransaction(h.pool, h.opts, '', asMetadata, fn)],
  ];

  it.each(RUNNERS)('never run when PostgreSQL rolls a %s transaction back at COMMIT', async (_label, run) => {
    const h = setup();
    const insert = 'INSERT INTO people.person (id) VALUES ($1)';
    h.client.failures.set(insert, new Error('duplicate key value violates unique constraint'));
    h.client.commands.set('COMMIT', 'ROLLBACK');
    const committed = vi.fn(() => Promise.reject(new Error('published')));
    const own = vi.fn<CommitErrorHandler>();

    await expect(
      run(h, async (tx) => {
        tx.onCommit(committed, own);
        tx.onCommit(committed);
        await tx.query(insert, ['p1']).catch(() => undefined);
        return 'value';
      }),
    ).rejects.toBeInstanceOf(TransactionRolledBackError);
    expect(h.events).toEqual(['BEGIN', SET_TENANT, insert, 'COMMIT', 'ROLLBACK', 'release']);
    expect(h.client.releases).toEqual([undefined]);
    expect(committed).not.toHaveBeenCalled();
    expect(own).not.toHaveBeenCalled();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('run outside the transaction scope and may open their own transaction', async () => {
    const h = setup();
    let seen: unknown = 'unset';
    let inner: string | undefined;

    await runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
      tx.onCommit(async () => {
        seen = currentTransaction();
        inner = await runTenantTransaction(h.pool, h.opts, TENANT_B, () => Promise.resolve(requireTenantTx().tenantId));
      });
      return Promise.resolve();
    });

    expect(seen).toBeUndefined();
    expect(inner).toBe(TENANT_B);
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.client.calls.filter(([text]) => text === SET_TENANT)).toEqual([
      [SET_TENANT, [TENANT_A]],
      [SET_TENANT, [TENANT_B]],
    ]);
  });

  it('send failures to their own handler, else to the runner handler, and keep going', async () => {
    const h = setup();
    const own = vi.fn<CommitErrorHandler>();
    const thrown = new Error('thrown');
    const rejected = new Error('rejected');
    const last = vi.fn();

    const result = await runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
      tx.onCommit(() => {
        throw thrown;
      }, own);
      tx.onCommit(() => Promise.reject(rejected));
      tx.onCommit(last);
      return Promise.resolve('value');
    });

    expect(result).toBe('value');
    expect(own).toHaveBeenCalledExactlyOnceWith(thrown);
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(rejected);
    expect(last).toHaveBeenCalledOnce();
  });

  it.each(failingHandlers('handler down'))('turn a handler that %s into an OPT2_TENANCY warning', async (_label, handler, stack) => {
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
        tx.onCommit(() => Promise.reject(new Error('callback down')), handler);
        return Promise.resolve('value');
      }),
    ).resolves.toBe('value');
    await vi.waitFor(() => {
      expect(emitWarning).toHaveBeenCalledOnce();
    });
    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(message).toBe('Commit callback error handler failed: [REDACTED]');
    expect(options?.code).toBe('OPT2_TENANCY');
    expect(options?.detail).toEqual(stack ? expect.stringMatching(SAFE_DETAIL) : undefined);
    expect(options?.detail ?? '').not.toContain('handler down');
  });

  it.each(failingHandlers(LEAKY_TEXT))('redact a handler that %s and keep its warning on one line', async (_label, handler, stack) => {
    const h = setup();
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
        tx.onCommit(() => Promise.reject(new Error('callback down')), handler);
        return Promise.resolve('value');
      }),
    ).resolves.toBe('value');
    await vi.waitFor(() => {
      expect(emitWarning).toHaveBeenCalledOnce();
    });
    const [message, options] = emitWarning.mock.calls[0] ?? [];
    expect(options?.code).toBe('OPT2_TENANCY');
    expect(message).toBe('Commit callback error handler failed: [REDACTED]');
    expect(options?.detail).toEqual(stack ? expect.stringMatching(SAFE_DETAIL) : undefined);
    for (const text of [message, options?.detail ?? '']) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(MAILBOX);
      expect(text).not.toContain('forged');
      expect(text).not.toMatch(RAW_CONTROL);
    }
  });

  it.each(failingHandlers(LEAKY_TEXT))('write a handler that %s to a registered diagnostic logger', async (_label, handler) => {
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

    await expect(
      runTenantTransaction(h.pool, h.opts, TENANT_A, (tx) => {
        tx.onCommit(() => Promise.reject(new Error('callback down')), handler);
        return Promise.resolve('value');
      }),
    ).resolves.toBe('value');
    await vi.waitFor(() => {
      expect(lines).toHaveLength(1);
    });
    expect(emitWarning).not.toHaveBeenCalled();
    expect(validateLogRecord(lines[0])).toStrictEqual({ valid: true, errors: [] });
    expect(lines[0]).toMatchObject({
      severity: 'WARNING',
      message: 'OPT2_TENANCY: Commit callback error handler failed: [REDACTED]',
      error: { message: '[REDACTED]' },
    });
    for (const text of [SECRET, MAILBOX, 'forged']) {
      expect(JSON.stringify(lines[0])).not.toContain(text);
    }
  });
});

describe('transaction context helpers', () => {
  it('find no transaction outside one', () => {
    expect(currentTransaction()).toBeUndefined();
    expect(currentTenantTx()).toBeUndefined();
    expect(() => requireTenantTx()).toThrow(OutsideTenantTransactionError);
  });

  it('return the open tenant transaction inside its callback', async () => {
    const h = setup();

    await runTenantTransaction(h.pool, h.opts, TENANT_A, async (tx) => {
      await Promise.resolve();
      expect(currentTransaction()).toBe(tx);
      expect(currentTenantTx()).toBe(tx);
      expect(requireTenantTx()).toBe(tx);
    });
  });

  it('treat a metadata transaction as no tenant transaction', async () => {
    const h = setup();

    await runTransaction(h.pool, h.opts, '', asMetadata, (tx) => {
      expect(currentTransaction()).toBe(tx);
      expect(currentTenantTx()).toBeUndefined();
      expect(() => requireTenantTx()).toThrow(OutsideTenantTransactionError);
      return Promise.resolve();
    });
  });

  it('keep concurrent transactions apart', async () => {
    const a = setup();
    const b = setup();
    const both = gate();

    const seen = await Promise.all([
      runTenantTransaction(a.pool, a.opts, TENANT_A, async () => {
        await both.promise;
        return requireTenantTx().tenantId;
      }),
      runTenantTransaction(b.pool, b.opts, TENANT_B, async () => {
        both.open();
        await both.promise;
        return requireTenantTx().tenantId;
      }),
    ]);

    expect(seen).toEqual([TENANT_A, TENANT_B]);
  });

  it('drop the transaction from continuations that outlive its callback', async () => {
    const h = setup();
    const later = gate();
    let leaked: Promise<unknown> = Promise.resolve('unset');

    await runTenantTransaction(h.pool, h.opts, TENANT_A, () => {
      leaked = later.promise.then(() => currentTransaction());
      return Promise.resolve();
    });
    later.open();

    await expect(leaked).resolves.toBeUndefined();
  });
});

/** A FakeClient whose `stalls` statements never answer; destroying it rejects them as pg's ended connection does. */
class StallingClient extends FakeClient {
  readonly stalls = new Set<string>();
  readonly #pending: ((err: Error) => void)[] = [];

  override query(text: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const sql = typeof text === 'string' ? text : text.text;
    if (!this.stalls.has(sql)) {
      return super.query(text, values);
    }
    this.calls.push([sql, values]);
    this.events.push(sql);
    return new Promise((_resolve, reject) => this.#pending.push(reject));
  }

  override release(err?: Error | boolean): void {
    super.release(err);
    if (err instanceof Error) {
      for (const reject of this.#pending.splice(0)) reject(new Error('Connection terminated'));
    }
  }
}

describe('abortable metadata transactions', () => {
  const unhandled = vi.fn();
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  afterEach(() => {
    process.off('unhandledRejection', unhandled);
    unhandled.mockReset();
  });

  const watchRejections = (): void => {
    process.on('unhandledRejection', unhandled);
  };

  it.each([
    ['no signal', () => undefined],
    ['a signal that never aborts', () => new AbortController().signal],
  ])('with %s run BEGIN, the setting, the work and COMMIT, then release once', async (_label, signal) => {
    const h = setup();
    const committed = vi.fn();

    const result = await runTransaction(
      h.pool,
      h.opts,
      '',
      asMetadata,
      async (tx) => {
        tx.onCommit(committed);
        await tx.query('SELECT 1');
        return 'value';
      },
      { signal: signal() },
    );

    expect(result).toBe('value');
    expect(h.events).toEqual(['BEGIN', SET_TENANT, 'SELECT 1', 'COMMIT', 'release']);
    expect(h.client.releases).toEqual([undefined]);
    expect(committed).toHaveBeenCalledOnce();
  });

  it('rejects with the reason of an already aborted signal without connecting', async () => {
    const h = setup();
    const reason = new Error('deadline passed');
    const fn = vi.fn(() => Promise.resolve());

    await expect(runTransaction(h.pool, h.opts, '', asMetadata, fn, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(h.connect).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['hands a client over', true],
    ['fails', false],
  ])('rejects at once when aborted during a pending checkout that later %s, and never queries', async (_label, arrives) => {
    watchRejections();
    const h = setup();
    let deliver: () => void = () => undefined;
    h.connect.mockImplementationOnce(
      () =>
        new Promise<FakeClient>((resolve, reject) => {
          deliver = () => (arrives ? resolve(h.client) : reject(new Error('connect failed')));
        }),
    );
    const controller = new AbortController();
    const reason = new Error('deadline passed');
    const fn = vi.fn(() => Promise.resolve());

    const run = runTransaction(h.pool, h.opts, '', asMetadata, fn, { signal: controller.signal });
    expect(h.connect).toHaveBeenCalledOnce();
    controller.abort(reason);
    await expect(run).rejects.toBe(reason);
    deliver();
    await flush();

    expect(h.client.calls).toEqual([]);
    expect(h.client.releases).toEqual(arrives ? [undefined] : []);
    expect(fn).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });

  it.each([
    ['BEGIN', ['BEGIN'], new Error('deadline passed')],
    [SET_TENANT, ['BEGIN', SET_TENANT], new Error('deadline passed')],
    ['the callback', ['BEGIN', SET_TENANT, 'SELECT 1'], new Error('deadline passed')],
    ['COMMIT', ['BEGIN', SET_TENANT, 'SELECT 1', 'COMMIT'], 'deadline passed'],
  ] as const)('when aborted during %s, destroys the client once, discards commit callbacks and rejects with the reason', async (phase, issued, reason) => {
    watchRejections();
    const h = setup();
    const client = new StallingClient(h.events);
    h.connect.mockImplementation(() => Promise.resolve(client));
    client.stalls.add(phase);
    const controller = new AbortController();
    const reached = gate();
    const resume = gate();
    const committed = vi.fn();
    let late: { query: unknown; onCommit: unknown; current: unknown } | undefined;

    const run = runTransaction(
      h.pool,
      h.opts,
      '',
      asMetadata,
      async (tx) => {
        tx.onCommit(committed);
        await tx.query('SELECT 1');
        if (phase === 'the callback') {
          reached.open();
          await resume.promise;
          late = {
            query: await tx.query('SELECT 2').catch((err: unknown) => err),
            onCommit: (() => {
              try {
                tx.onCommit(committed);
                return undefined;
              } catch (err) {
                return err;
              }
            })(),
            current: currentTransaction(),
          };
        }
        return 'value';
      },
      { signal: controller.signal },
    );
    if (phase === 'the callback') {
      await reached.promise;
    } else {
      await vi.waitFor(() => expect(client.calls.map(([text]) => text)).toContain(phase));
    }
    controller.abort(reason);

    await expect(run).rejects.toBe(reason);
    expect(client.releases).toEqual([reason instanceof Error ? reason : new Error(reason)]);
    resume.open();
    await flush();
    await flush();

    expect(client.calls.map(([text]) => text)).toEqual(issued);
    expect(client.releases).toHaveLength(1);
    expect(committed).not.toHaveBeenCalled();
    if (phase === 'the callback') {
      expect(late?.query).toBeInstanceOf(TransactionEndedError);
      expect(late?.onCommit).toBeInstanceOf(TransactionEndedError);
      expect(late?.current).toBeUndefined();
    }
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('discards commit callbacks when the abort lands after COMMIT answers but before the connection is released', async () => {
    const h = setup();
    const controller = new AbortController();
    const reason = new Error('deadline passed');
    const query = h.client.query.bind(h.client);
    vi.spyOn(h.client, 'query').mockImplementation((text, values) => {
      if (text === 'COMMIT') queueMicrotask(() => controller.abort(reason));
      return query(text, values);
    });
    const committed = vi.fn();

    await expect(
      runTransaction(
        h.pool,
        h.opts,
        '',
        asMetadata,
        (tx) => {
          tx.onCommit(committed);
          return Promise.resolve('value');
        },
        { signal: controller.signal },
      ),
    ).rejects.toBe(reason);
    expect(h.client.releases).toEqual([reason]);
    expect(committed).not.toHaveBeenCalled();
  });

  it('ignores an abort once the connection is back in the pool and still runs every commit callback', async () => {
    const h = setup();
    const controller = new AbortController();
    const second = vi.fn();

    const result = await runTransaction(
      h.pool,
      h.opts,
      '',
      asMetadata,
      (tx) => {
        tx.onCommit(() => {
          controller.abort(new Error('late'));
        });
        tx.onCommit(second);
        return Promise.resolve('value');
      },
      { signal: controller.signal },
    );

    expect(result).toBe('value');
    expect(h.client.releases).toEqual([undefined]);
    expect(second).toHaveBeenCalledOnce();
  });
});

describe('withTenant', () => {
  it('runs the callback through the TenantDb', async () => {
    const h = setup();
    const db: TenantDb = {
      schema: 'people',
      withTenant: (tenantId, fn) => runTenantTransaction(h.pool, h.opts, tenantId, fn),
      withMetadata: (fn) => runTransaction(h.pool, h.opts, '', asMetadata, fn),
      end: () => Promise.resolve(),
    };
    const delegate = vi.spyOn(db, 'withTenant');
    const fn = (tx: TenantTx): Promise<string> => Promise.resolve(tx.tenantId);

    await expect(withTenant(db, TENANT_A, fn)).resolves.toBe(TENANT_A);
    expect(delegate).toHaveBeenCalledExactlyOnceWith(TENANT_A, fn);
    expect(h.client.calls[1]).toEqual([SET_TENANT, [TENANT_A]]);
  });

  it('forwards its options to the TenantDb, so an aborted signal rejects before connecting', async () => {
    const h = setup();
    const db: TenantDb = {
      schema: 'people',
      withTenant: (tenantId, fn, options) => runTenantTransaction(h.pool, h.opts, tenantId, fn, options),
      withMetadata: (fn) => runTransaction(h.pool, h.opts, '', asMetadata, fn),
      end: () => Promise.resolve(),
    };
    const delegate = vi.spyOn(db, 'withTenant');
    const reason = new Error('client closed');
    const options = { signal: AbortSignal.abort(reason) };
    const fn = vi.fn((tx: TenantTx): Promise<string> => Promise.resolve(tx.tenantId));

    await expect(withTenant(db, TENANT_A, fn, options)).rejects.toBe(reason);
    expect(delegate).toHaveBeenCalledExactlyOnceWith(TENANT_A, fn, options);
    expect(h.connect).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
