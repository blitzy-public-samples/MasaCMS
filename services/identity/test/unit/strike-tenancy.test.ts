/** Migration-applied account changes move strike rows to the tenant legacy's tuserstrikes rule gives them, against PostgreSQL. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cfUuid } from '@opt2/platform/legacy-compat';
import { closeGates, openGates, type ApplyRequest } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import {
  TENANT_A,
  TENANT_B,
  TENANT_UMBRELLA,
  createThrowawaySchema,
  pgAvailable,
  seedRegistry,
  type TenantFixture,
  type ThrowawaySchema,
} from '@opt2/platform/testing';
import { tusersGroupAccountMapping, tusersUserAccountMapping, tuserstrikesMapping } from '../../src/migration/mappings/index.js';
import { buildTestApp, headersFor, type TestApp } from '../helpers/app.js';
import { batchOf } from '../helpers/migration-batches.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const PG_READY = ['PG_HOST', 'PG_USER', 'PG_PASSWORD', 'PG_DATABASE'].every((name) => Boolean(process.env[name])) && (await pgAvailable());
/** The identity units legacy's user delete window holds in v0002 (gateway/cutover/versions/v0002.json). */
const WINDOW_UNITS = ['identity.credential', 'identity.login_state', 'identity.oauth_token', 'identity.trash', 'identity.user_account'];
const A = TENANT_A;
const B = TENANT_B;
const U = TENANT_UMBRELLA;

/** A tusers row of the case: `type` 1 is a group, 2 (the default) a user. */
interface AccountSpec {
  id: number;
  name: number;
  tenant: TenantFixture;
  type?: 1 | 2;
}

/** A strike row of the case, by the case's username number. */
interface StrikeSpec {
  name: number;
  tenant: TenantFixture;
  strikes: number;
  at: string;
}

interface StrikeCase {
  title: string;
  accounts: AccountSpec[];
  strikes: StrikeSpec[];
  step: { op: 'upsert' | 'delete'; origin: ApplyRequest['origin']; account: AccountSpec };
  expected: StrikeSpec[];
}

const CASES: StrikeCase[] = [
  {
    title: "a window's user delete moves the deleted name's strike to the umbrella",
    accounts: [{ id: 1, name: 1, tenant: A }],
    strikes: [{ name: 1, tenant: A, strikes: 2, at: '2026-06-30 09:00:00' }],
    step: { op: 'delete', origin: 'legacy-window', account: { id: 1, name: 1, tenant: A } },
    expected: [{ name: 1, tenant: U, strikes: 2, at: '2026-06-30 09:00:00' }],
  },
  {
    title: "a feed rename orphans the old name's strike and adopts the new name's",
    accounts: [{ id: 1, name: 1, tenant: A }],
    strikes: [
      { name: 1, tenant: A, strikes: 1, at: '2026-06-30 09:00:00' },
      { name: 2, tenant: U, strikes: 3, at: '2026-06-30 10:00:00' },
    ],
    step: { op: 'upsert', origin: 'migration-feed', account: { id: 1, name: 2, tenant: A } },
    expected: [
      { name: 1, tenant: U, strikes: 1, at: '2026-06-30 09:00:00' },
      { name: 2, tenant: A, strikes: 3, at: '2026-06-30 10:00:00' },
    ],
  },
  {
    title: 'an account of the same name in a second tenant sends the strike to the umbrella',
    accounts: [{ id: 1, name: 1, tenant: A }],
    strikes: [{ name: 1, tenant: A, strikes: 0, at: '2026-06-30 09:00:00' }],
    step: { op: 'upsert', origin: 'migration-feed', account: { id: 2, name: 1, tenant: B } },
    expected: [{ name: 1, tenant: U, strikes: 0, at: '2026-06-30 09:00:00' }],
  },
  {
    title: 'a strike already in its home tenant stays as stored and the stray copy goes',
    accounts: [{ id: 1, name: 1, tenant: A }],
    strikes: [
      { name: 1, tenant: A, strikes: 1, at: '2026-06-30 09:00:00' },
      { name: 1, tenant: U, strikes: 4, at: '2026-06-30 11:00:00' },
    ],
    step: { op: 'delete', origin: 'legacy-window', account: { id: 1, name: 1, tenant: A } },
    expected: [{ name: 1, tenant: U, strikes: 4, at: '2026-06-30 11:00:00' }],
  },
  {
    title: "a window's user create adopts the umbrella strike of its name",
    accounts: [],
    strikes: [{ name: 1, tenant: U, strikes: 5, at: '2026-06-30 08:00:00' }],
    step: { op: 'upsert', origin: 'legacy-window', account: { id: 1, name: 1, tenant: A } },
    expected: [{ name: 1, tenant: A, strikes: 5, at: '2026-06-30 08:00:00' }],
  },
  {
    title: "a group's delete moves the strike of its username to the umbrella",
    accounts: [{ id: 1, name: 1, tenant: B, type: 1 }],
    strikes: [{ name: 1, tenant: B, strikes: 1, at: '2026-06-30 09:00:00' }],
    step: { op: 'delete', origin: 'migration-feed', account: { id: 1, name: 1, tenant: B, type: 1 } },
    expected: [{ name: 1, tenant: U, strikes: 1, at: '2026-06-30 09:00:00' }],
  },
];

describe.skipIf(!PG_READY)('strike tenancy of migration-applied account changes', () => {
  let schema!: ThrowawaySchema;
  let app!: TestApp['app'];

  beforeAll(async () => {
    schema = await createThrowawaySchema({ service: 'identity', migrationsDir: MIGRATIONS_DIR });
    await seedRegistry(schema.app, schema.schema);
    ({ app } = await buildTestApp({ db: schema.app }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await schema?.drop();
  });

  async function apply(body: ApplyRequest): Promise<void> {
    const res = await app.inject({ method: 'POST', url: '/internal/v1/migration/apply', headers: await headersFor('service:migration'), payload: body });
    expect(res.statusCode, res.body).toBe(200);
  }

  it.each(CASES)('$title', async ({ accounts, strikes, step, expected }) => {
    const run = cfUuid().slice(0, 8);
    const ids = new Map<number, string>();
    const idOf = (n: number): string => ids.get(n) ?? (ids.set(n, cfUuid()).get(n) as string);
    const nameOf = (n: number): string => `strike-${run}-${String(n)}`;
    const names = [...new Set([...strikes, ...expected].map(({ name }) => nameOf(name)))];
    const tusers = (spec: AccountSpec) => ({
      UserID: idOf(spec.id),
      UserName: nameOf(spec.name),
      Type: spec.type ?? 2,
      SiteID: spec.tenant.siteId,
      ...(spec.type === 1 ? { GroupName: `Group ${run}` } : { S2: 0, InActive: 0, isPublic: 0 }),
    });
    const accountBatch = (op: 'upsert' | 'delete', origin: ApplyRequest['origin'], spec: AccountSpec, holderId?: string): ApplyRequest =>
      batchOf(spec.type === 1 ? tusersGroupAccountMapping : tusersUserAccountMapping, spec.tenant.siteId, origin, [{ op, values: tusers(spec) }], holderId);

    for (const spec of accounts) await apply(accountBatch('upsert', 'backfill', spec));
    for (const { name, tenant, strikes: count, at } of strikes) {
      const values = { username: nameOf(name), strikes: count, lastAttempt: at };
      await apply(batchOf(tuserstrikesMapping, tenant.siteId, 'backfill', [{ op: 'upsert', values }]));
    }

    // Under a window the account gates stay closed in the import phase, which the apply's own reads must pass.
    const holderId = step.origin === 'legacy-window' ? `window-${run}` : undefined;
    if (holderId !== undefined) await closeGates(schema.app, { units: WINDOW_UNITS, holderId, phase: 'importing', allowLegacy: true });
    const body = accountBatch(step.op, step.origin, step.account, holderId);
    try {
      await apply(body);
    } finally {
      if (holderId !== undefined) await openGates(schema.app, { units: WINDOW_UNITS, holderId, state: 'open' });
    }

    const stored: StrikeSpec[] = [];
    const origins = new Set<string>();
    for (const tenant of [A, B, U]) {
      await withTenant(schema.app, tenant.tenantId, async (tx) => {
        const rows = await tx.query<{ username: string; strikes: number; at: string }>(
          `SELECT username, strikes, to_char(lastattempt, 'YYYY-MM-DD HH24:MI:SS') AS at FROM ${schema.schema}.user_strike WHERE username = ANY($1::text[])`,
          [names],
        );
        for (const row of rows.rows) stored.push({ name: Number(row.username.split('-').at(-1)), tenant, strikes: row.strikes, at: row.at });
        const logged = await tx.query<{ origin: string }>(
          `SELECT origin FROM ${schema.schema}.changelog WHERE "table" = 'user_strike' AND request_id = $1`,
          [body.batchId],
        );
        for (const row of logged.rows) origins.add(row.origin);
      });
    }
    const order = (specs: StrikeSpec[]): StrikeSpec[] => [...specs].sort((a, b) => a.name - b.name || a.tenant.siteId.localeCompare(b.tenant.siteId));
    expect(order(stored)).toEqual(order(expected));
    // The reverse projector passes over apply origins, so legacy's tuserstrikes rows stay as they are.
    expect([...origins]).toEqual([step.origin]);
  });
});
