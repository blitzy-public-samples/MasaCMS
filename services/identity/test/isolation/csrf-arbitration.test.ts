/** CSRF claim uniqueness of concurrent target consumes over a throwaway `identity` schema in PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CsrfConsumeRequest } from '@opt2/platform/service-kit';
import { withMetadata, withTenant, type QueryConfig, type QueryResultRow, type TenantDb, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { consumeToken, issueTokens, type CsrfDeps } from '../../src/domain/csrf.js';
import { createBridgeRelay } from '../../src/legacy/bridge-relay.js';
import { createIdentityRepository } from '../../src/repo/repository.js';
import { createClientRecorder } from '../helpers/app.js';

const SESSION_ID = 'S-1';
const NOW = new Date(2026, 5, 30, 12, 0, 0, 123);
const CLOCK = fixedClock(NOW);
const LOGIN = 'login';

/** A consume request of session S-1 carrying the `login` token issued under `secret` at the test clock. */
function consumeRequest(secret: string): CsrfConsumeRequest {
  return { sessionId: SESSION_ID, ...issueTokens({ csrfSecret: secret }, { context: LOGIN, clock: CLOCK }), context: LOGIN };
}

/** `db` whose tenant transactions record the error of every failed statement in `failures`. */
function failureRecordingDb(db: TenantDb, failures: unknown[]): TenantDb {
  const observed = (tx: TenantTx): TenantTx => ({
    kind: tx.kind,
    tenantId: tx.tenantId,
    schema: tx.schema,
    onCommit: (cb, onError) => tx.onCommit(cb, onError),
    async query<R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]) {
      try {
        return await tx.query<R>(text, values);
      } catch (err) {
        failures.push(err);
        throw err;
      }
    },
  });
  return {
    schema: db.schema,
    withTenant: (tenantId, fn, options) => db.withTenant(tenantId, (tx) => fn(observed(tx)), options),
    withMetadata: (fn, options) => db.withMetadata(fn, options),
    end: () => db.end(),
  };
}

// An unset PG_HOST skips the suite without probing the server.
const pgReady = process.env.PG_HOST === undefined ? false : await pgAvailable();

describe.skipIf(!pgReady)('claim uniqueness in PostgreSQL', () => {
  const SECRET = 'K0000000-0000-0000-0000000000000001';
  const failures: unknown[] = [];
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    const repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, $3)`, [
        TENANT_A.siteId,
        TENANT_A.tenantId,
        NOW,
      ]),
    );
    await withTenant(handle.app, TENANT_A.tenantId, (tx) =>
      repo.insertSession(tx, { session_id: SESSION_ID, csrf_secret: SECRET, mode: 'target-primary', state: 'active' }),
    );
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it('lets exactly one of two concurrent target consumes win the csrf_claim primary key', async () => {
    const db = failureRecordingDb(handle.app, failures);
    const client = createClientRecorder();
    // Each consume has its own repository, so the only state the two share is the database.
    const depsOf = (): CsrfDeps => ({ db, repo: createIdentityRepository({ clock: CLOCK, schema: handle.schema }), bridge: createBridgeRelay(client), clock: CLOCK });
    const request = consumeRequest(SECRET);

    const results = await Promise.all([consumeToken(depsOf(), request), consumeToken(depsOf(), request)]);

    expect(results.filter((result) => result.valid)).toHaveLength(1);
    expect(failures).toEqual([expect.objectContaining({ code: '23505', table: 'csrf_claim', constraint: 'csrf_claim_pkey' })]);
  });
});
