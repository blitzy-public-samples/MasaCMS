import type { Pool, QueryResult } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDiagnosticLogger } from '../../src/logging/diagnostics.js';
import { createLogger } from '../../src/logging/logger.js';
import { validateLogRecord } from '../../src/logging/validate.js';
import { tenantDbFromPool } from '../../src/tenancy/pool.js';
import { tenantIdForSite } from '../../src/tenancy/tenant-id.js';
import type { CommitErrorHandler } from '../../src/tenancy/transaction.js';

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

/** A TenantDb over a fake pool whose connections accept every statement, with the listener it registered for 'error'. */
function setup(onError?: CommitErrorHandler) {
  const result = (text: string): QueryResult => ({ command: text, rowCount: 0, oid: 0, fields: [], rows: [] });
  const client = { query: vi.fn((text: string) => Promise.resolve(result(text))), release: vi.fn() };
  const on = vi.fn();
  const db = tenantDbFromPool({ connect: vi.fn(() => Promise.resolve(client)), on } as unknown as Pool, { schema: 'people', onError });
  const listener = on.mock.calls.find(([event]) => event === 'error')?.[1] as ((...args: unknown[]) => void) | undefined;
  return { client, db, listener };
}

type Setup = ReturnType<typeof setup>;

/** Emits `err` on the pool as pg-pool does for an idle client: with the client as a second argument. */
function idleClientError(h: Setup, err: Error): Promise<void> {
  h.listener?.(err, h.client);
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

  it('leaves a caller-supplied onError the raw error and emits no warning', async () => {
    const onError = vi.fn<CommitErrorHandler>();
    const h = setup(onError);
    const emitWarning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    const err = new Error(LEAKY_TEXT);

    await commitCallbackFailure(h, err);

    expect(h.listener).toBe(onError);
    expect(onError).toHaveBeenCalledExactlyOnceWith(err);
    expect(err.message).toBe(LEAKY_TEXT);
    expect(emitWarning).not.toHaveBeenCalled();
  });
});
