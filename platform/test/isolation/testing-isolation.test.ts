import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect, isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eventsSql, registerPushSubscription, subscriptionName, type ConsumerDefinition, type EventEnvelope } from '../../src/events/index.js';
import { cfUuid } from '../../src/legacy-compat/ids.js';
import { createLogger } from '../../src/logging/index.js';
import { createService, loadEnv, type FastifyInstance } from '../../src/service-kit/index.js';
import { rlsSql, tenantRegistrySql, withTenant, type TenantTx } from '../../src/tenancy/index.js';
import { createCapturingPublisher, testEnvelope } from '../../src/testing/events.js';
import { TENANT_A, TENANT_B, TENANT_UMBRELLA, type TenantFixture } from '../../src/testing/fixtures.js';
import {
  defineIsolationSuite,
  type IsolationEventOptions,
  type IsolationSuiteOptions,
  type SuiteApi,
} from '../../src/testing/isolation.js';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '../../src/testing/schema.js';
import { testVerifier } from '../../src/testing/tokens.js';

const available = await pgAvailable();
const SOURCE = 'tiso';
const TABLES = [
  'note',
  'leaked_note',
  'leaked_mapped_note',
  'bare_note',
  'mapped_note',
  'open_note',
  'revoked_note',
  'partial_note',
  'misnamed_note',
] as const;
/** Cases defineIsolationSuite registers for one table: 3 read, 6 write, 1 pooled-reuse, catalog and guard. */
const CASES_PER_TABLE = 12;
const TOPIC = `${SOURCE}.note.written.v1`;

/** A business table whose id is a NOT NULL domain and whose payload is NOT NULL, neither with a default. */
function tableSql(table: string): string {
  return `CREATE TABLE ${SOURCE}.${table} (tenant_id uuid NOT NULL, id ${SOURCE}.cf_id PRIMARY KEY, body text NOT NULL)`;
}

/** The tenant policy of `table`, with WITH CHECK (true) on open_note so any tenant's row passes the write check. */
function policySql(table: string): string {
  const sql = rlsSql(SOURCE, table);
  return table === 'open_note' ? sql.replace(/WITH CHECK \(.*\);$/, 'WITH CHECK (true);') : sql;
}

type Note = { id: string; body: string };
type NotePayload = { noteId: string };

let handle: ThrowawaySchema | undefined;
let app: FastifyInstance | undefined;
const publisher = createCapturingPublisher();
/** Subscription and destination tenant of every apply the event scenarios' consumers completed. */
const applied: { subscription: string; tenantId: string }[] = [];
/** DTOs without tenant fields of the rows writeAs stored, per table. */
const written = new Map<string, Note[]>();
/** Tenant id of each id writeAs stored. */
const ownerOfId = new Map<string, string>();

/** A fresh complete row of `table` for `tenant`. */
function completeRow(table: string, tenant: TenantFixture): Note {
  return { id: cfUuid(), body: `${table} of ${tenant.key}` };
}

/** Inserts a complete row of `table` for `tenant` and records its DTO and owner. */
async function writeComplete(tx: TenantTx, table: string, tenant: TenantFixture): Promise<void> {
  const row = completeRow(table, tenant);
  await tx.query(`INSERT INTO ${tx.schema}.${table} (tenant_id, id, body) VALUES ($1, $2, $3)`, [tenant.tenantId, row.id, row.body]);
  written.set(table, [...(written.get(table) ?? []), row]);
  ownerOfId.set(row.id, tenant.tenantId);
}

/** The rows of `table` visible in `tx`, with their tenant ids. */
async function readWithTenant(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT tenant_id::text AS tenant_id, id, body FROM ${tx.schema}.${table}`)).rows;
}

/** The rows of `table` visible in `tx`, as DTOs without tenant fields. */
async function readBare(tx: TenantTx, table: string): Promise<unknown[]> {
  return (await tx.query(`SELECT id, body FROM ${tx.schema}.${table}`)).rows;
}

/** Every tenant's DTOs of `table` from the write cache, ignoring the transaction's tenant. */
function readLeaked(_tx: TenantTx, table: string): Promise<unknown[]> {
  return Promise.resolve([...(written.get(table) ?? [])]);
}

/** The tenant writeAs stored a DTO's id under. */
function tenantFromId(_table: string, row: unknown): string | undefined {
  return ownerOfId.get((row as Note).id);
}

/** Suite options over `table` with complete writes and rows, tenant-carrying reads and `overrides`. */
function optionsFor(table: string, overrides: Partial<IsolationSuiteOptions> = {}): IsolationSuiteOptions {
  return { db: () => handle, tables: [table], writeAs: writeComplete, readAs: readWithTenant, rowFor: completeRow, ...overrides };
}

const NOTE_PAYLOAD_SCHEMA = {
  'x-opt2-kind': 'process',
  type: 'object',
  required: ['noteId'],
  additionalProperties: false,
  properties: { noteId: { type: 'string', minLength: 1 } },
};

/** A contract-valid envelope of the test topic for `tenantId`, on a fresh aggregate. */
function noteEnvelope(tenantId: string): EventEnvelope<NotePayload> {
  return testEnvelope({ topic: TOPIC, tenantId, aggregateId: cfUuid(), payload: { noteId: cfUuid() } });
}

/** Event options of `subscription` on the shared app and capturing publisher. */
function eventOptions(subscription: string): IsolationEventOptions {
  return { app: () => app, subscription, envelopeFor: noteEnvelope, publisher };
}

/** The tenantless and tenant A delivery case titles of `subscription`, as the isolation report matches them. */
function eventTitles(subscription: string): [tenantless: string, delivery: string] {
  return [
    `an event without a tenant on ${subscription} is acked, dead-lettered as missing-tenant and changes no rows`,
    `a tenant A delivery on ${subscription} is acked and changes no rows of tenant B or tenant umbrella`,
  ];
}

type Kind = 'read' | 'write' | 'pool' | 'other';

/** The case family a registered case name belongs to. */
function kindOf(name: string): Kind {
  if (name.includes('sees only its own rows')) return 'read';
  if (name.includes('cannot insert, move into')) return 'write';
  if (name.includes('pooled connection reused')) return 'pool';
  return 'other';
}

/** Throws a message naming `label`, `actual` and `expected` unless `pass`. */
function check(pass: boolean, label: string | undefined, actual: unknown, relation: string, expected: unknown): void {
  if (!pass) {
    const show = (value: unknown): string => inspect(value, { breakLength: Infinity });
    throw new Error(`${label ?? 'value'}: expected ${show(actual)} ${relation} ${show(expected)}`);
  }
}

interface Recorded {
  api: SuiteApi;
  hooks: (() => Promise<void>)[];
  cases: { name: string; fn: () => Promise<void> }[];
}

/**
 * A SuiteApi that runs describe bodies at once, collects hooks and cases, and throws on the first failed expectation;
 * without `withHooks` it has no beforeAll, so the suite registers its seeding as a case.
 */
function recordingApi(withHooks = true): Recorded {
  const recorded: Recorded = {
    hooks: [],
    cases: [],
    api: {
      describe: (_name, fn) => {
        fn();
      },
      it: (name, fn) => {
        recorded.cases.push({ name, fn });
      },
      ...(withHooks
        ? {
            beforeAll: (fn: () => Promise<void>) => {
              recorded.hooks.push(fn);
            },
          }
        : {}),
      expect: (actual, label) => ({
        toBe: (expected) => {
          check(Object.is(actual, expected), label, actual, 'to be', expected);
        },
        toEqual: (expected) => {
          check(isDeepStrictEqual(actual, expected), label, actual, 'to equal', expected);
        },
        toBeGreaterThanOrEqual: (expected) => {
          check(typeof actual === 'number' && actual >= expected, label, actual, 'to be at least', expected);
        },
      }),
    },
  };
  return recorded;
}

interface Scenario {
  label: string;
  table: (typeof TABLES)[number];
  overrides?: Partial<IsolationSuiteOptions>;
  afterSeed?: (db: ThrowawaySchema) => Promise<void>;
  failures: Partial<Record<Kind, number>>;
  /** Pattern every failure message matches. */
  message?: RegExp;
}

const SCENARIOS: Scenario[] = [
  {
    label: 'a readAs leaking the DTOs of every tenant without tenant fields fails every read case',
    table: 'leaked_note',
    overrides: { readAs: readLeaked },
    failures: { read: 3 },
    message: /owners other than tenant .* in leaked_note: expected \[ 'no tenant', 'no tenant', 'no tenant' \]/,
  },
  {
    label: 'a readAs leaking the DTOs of every tenant fails every read case when tenantOf names their owners',
    table: 'leaked_mapped_note',
    overrides: { readAs: readLeaked, tenantOf: tenantFromId },
    failures: { read: 3 },
    message: /owners other than tenant .* in leaked_mapped_note: expected \[ '[0-9a-f-]{36}', '[0-9a-f-]{36}' \]/,
  },
  {
    label: 'own-tenant DTOs without tenant fields fail every read case when no tenantOf names their owner',
    table: 'bare_note',
    overrides: { readAs: readBare },
    failures: { read: 3 },
    message: /expected \[ 'no tenant' \]/,
  },
  {
    label: 'own-tenant DTOs without tenant fields pass every case when tenantOf names their owner',
    table: 'mapped_note',
    overrides: { readAs: readBare, tenantOf: tenantFromId },
    failures: {},
  },
  {
    label: 'a WITH CHECK (true) policy fails every cross-tenant write case and the pooled-reuse case',
    table: 'open_note',
    failures: { write: 6, pool: 1 },
    message: /INSERT of the same row .*'no error'/,
  },
  {
    label: 'an app role without INSERT fails every write and pooled-reuse case on the complete-row control',
    table: 'revoked_note',
    afterSeed: async (db) => {
      await db.adminPool.query(`REVOKE INSERT ON ${db.schema}.revoked_note FROM ${db.roles.app}`);
    },
    failures: { write: 6, pool: 1 },
    message: /INSERT of a complete .*: expected '42501' to be 'no error'/,
  },
  {
    label: 'a rowFor omitting the NOT NULL payload fails every write and pooled-reuse case on the complete-row control',
    table: 'partial_note',
    overrides: { rowFor: () => ({ id: cfUuid() }) },
    failures: { write: 6, pool: 1 },
    message: /INSERT of a complete .*: expected '23502' to be 'no error'/,
  },
  {
    label: 'a rowFor returning a non-snake column fails every write and pooled-reuse case with a TypeError naming it',
    table: 'misnamed_note',
    overrides: { rowFor: () => ({ id: cfUuid(), 'Body") --': 'x' }) },
    failures: { write: 6, pool: 1 },
    message: /^defineIsolationSuite: rowFor\("misnamed_note"\) returned non-snake columns \["Body\\"\) --"\]$/,
  },
];

/** How apply changes another tenant's rows: a new row, an UPDATE of its rows, or a delete and re-insert of the same count. */
type ForeignWrite = 'insert' | 'update' | 'replace';

interface EventScenario {
  label: string;
  /** Consumer segment of the scenario's subscription. */
  consumer: string;
  /** The business table its consumer writes. */
  table: string;
  /** Other tenants' rows apply also changes, each in its own transaction, as a consumer taking a tenant from the payload would. */
  alsoWrites?: readonly { tenant: TenantFixture; write: ForeignWrite }[];
  /** Answer of the tenant re-check; defaults to the registry lookup. */
  checkTenant?: boolean;
  /** Makes apply throw, so the push nacks. */
  throws?: boolean;
  /** Destination tenants of the applies that completed. */
  appliedIn: readonly TenantFixture[];
  /** Failure message of the tenant A delivery case, which fails alone when given. */
  failure?: string;
}

const EVENT_SCENARIOS: EventScenario[] = [
  {
    label: 'a consumer writing only the delivery tenant passes the tenant A delivery and tenantless cases',
    consumer: 'own',
    table: 'own_note',
    appliedIn: [TENANT_A],
  },
  {
    label: 'a consumer also writing a tenant B row fails the tenant A delivery case on the tenant B count',
    consumer: 'leak-b',
    table: 'leak_b_note',
    alsoWrites: [{ tenant: TENANT_B, write: 'insert' }],
    appliedIn: [TENANT_A],
    failure: "tables of tenant B or tenant umbrella changed by the tenant A delivery: expected [ 'B leak_b_note: 1 -> 2 rows' ] to equal []",
  },
  {
    label: 'a consumer also writing a tenant umbrella row fails the tenant A delivery case on the umbrella count',
    consumer: 'leak-umbrella',
    table: 'leak_umbrella_note',
    alsoWrites: [{ tenant: TENANT_UMBRELLA, write: 'insert' }],
    appliedIn: [TENANT_A],
    failure:
      "tables of tenant B or tenant umbrella changed by the tenant A delivery: expected [ 'umbrella leak_umbrella_note: 1 -> 2 rows' ] to equal []",
  },
  {
    label: 'a consumer also updating a seeded tenant B row fails the tenant A delivery case on the tenant B contents',
    consumer: 'update-b',
    table: 'update_b_note',
    alsoWrites: [{ tenant: TENANT_B, write: 'update' }],
    appliedIn: [TENANT_A],
    failure: "tables of tenant B or tenant umbrella changed by the tenant A delivery: expected [ 'B update_b_note: contents changed' ] to equal []",
  },
  {
    label: 'a consumer also updating a seeded tenant umbrella row fails the tenant A delivery case on the umbrella contents',
    consumer: 'update-umbrella',
    table: 'update_umbrella_note',
    alsoWrites: [{ tenant: TENANT_UMBRELLA, write: 'update' }],
    appliedIn: [TENANT_A],
    failure:
      "tables of tenant B or tenant umbrella changed by the tenant A delivery: expected [ 'umbrella update_umbrella_note: contents changed' ] to equal []",
  },
  {
    label: 'a consumer also replacing a seeded tenant B row, keeping the count, fails the tenant A delivery case on the tenant B contents',
    consumer: 'replace-b',
    table: 'replace_b_note',
    alsoWrites: [{ tenant: TENANT_B, write: 'replace' }],
    appliedIn: [TENANT_A],
    failure: "tables of tenant B or tenant umbrella changed by the tenant A delivery: expected [ 'B replace_b_note: contents changed' ] to equal []",
  },
  {
    label: 'a consumer dead-lettering the tenant A delivery fails the tenant A delivery case on its dead letter',
    consumer: 'mismatch',
    table: 'mismatch_note',
    checkTenant: false,
    appliedIn: [],
    failure: `dead letters on mismatch.${TOPIC}: expected [ 'tenant-mismatch' ] to equal []`,
  },
  {
    label: 'a consumer whose apply throws fails the tenant A delivery case on the nack',
    consumer: 'failing',
    table: 'failing_note',
    throws: true,
    appliedIn: [],
    failure: 'push answered 500: expected false to be true',
  },
];

/** The schema beforeAll created; throws when its creation failed. */
function schemaHandle(): ThrowawaySchema {
  if (handle === undefined) throw new Error('The throwaway schema was not created; see the beforeAll failure');
  return handle;
}

/** The scenario's consumer: one row of the delivery tenant in its transaction, then each `alsoWrites` change. */
function consumerOf({ consumer, table, alsoWrites = [], checkTenant, throws }: EventScenario): ConsumerDefinition<NotePayload> {
  const subscription = subscriptionName(consumer, TOPIC);
  const insert = (tx: TenantTx): Promise<unknown> =>
    tx.query(`INSERT INTO ${tx.schema}.${table} (tenant_id, id, body) VALUES ($1, $2, $3)`, [tx.tenantId, cfUuid(), subscription]);
  // RLS limits the UPDATE and DELETE to the rows of the transaction's tenant.
  const writes: Record<ForeignWrite, (tx: TenantTx) => Promise<unknown>> = {
    insert,
    update: (tx) => tx.query(`UPDATE ${tx.schema}.${table} SET body = $1`, [subscription]),
    replace: async (tx) => {
      await tx.query(`DELETE FROM ${tx.schema}.${table}`);
      return insert(tx);
    },
  };
  return {
    topic: TOPIC,
    kind: 'process',
    ...(checkTenant === undefined ? {} : { checkTenant: () => checkTenant }),
    async apply(tx) {
      if (throws === true) throw new Error(`apply failure injected on ${subscription}`);
      await insert(tx);
      for (const { tenant, write } of alsoWrites) await withTenant(schemaHandle().app, tenant.tenantId, writes[write]);
      applied.push({ subscription, tenantId: tx.tenantId });
    },
  };
}

/** Runs `cases` in order, collecting each failure's case name and message. */
async function runCases(cases: readonly { name: string; fn: () => Promise<void> }[]): Promise<{ name: string; message: string }[]> {
  const failed: { name: string; message: string }[] = [];
  for (const { name, fn } of cases) {
    try {
      await fn();
    } catch (err) {
      failed.push({ name, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return failed;
}

describe('defineIsolationSuite event options', () => {
  const [first, second, third] = ['own', 'leak-b', 'mismatch'].map((consumer) => subscriptionName(consumer, TOPIC)) as [string, string, string];

  it.each([
    { label: 'event', options: { event: eventOptions(first) }, subscriptions: [first] },
    { label: 'events', options: { events: [eventOptions(first), eventOptions(second)] }, subscriptions: [first, second] },
    {
      label: 'event and events',
      options: { event: eventOptions(first), events: [eventOptions(second), eventOptions(third)] },
      subscriptions: [first, second, third],
    },
  ])('registers the tenantless and tenant A delivery cases for each subscription of $label, in order', ({ options, subscriptions }) => {
    const recorded = recordingApi();
    defineIsolationSuite(recorded.api, optionsFor('note', options));
    expect(recorded.cases.slice(CASES_PER_TABLE).map(({ name }) => name)).toEqual(subscriptions.flatMap(eventTitles));
  });

  it.each([
    { label: 'event and events', options: { event: eventOptions(first), events: [eventOptions(second), eventOptions(first)] } },
    { label: 'events', options: { events: [eventOptions(first), eventOptions(second), eventOptions(first)] } },
  ])('rejects a subscription given twice across $label with a TypeError naming it', ({ options }) => {
    const define = (): void => defineIsolationSuite(recordingApi().api, optionsFor('note', options));
    expect(define).toThrow(TypeError);
    expect(define).toThrow(`defineIsolationSuite needs each subscription once across event and events; got ${JSON.stringify([first])} more than once`);
  });
});

describe.skipIf(!available)('defineIsolationSuite', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'testing-isolation',
      schemaName: SOURCE,
      extraSql: [
        `CREATE DOMAIN ${SOURCE}.cf_id AS char(35) NOT NULL`,
        tenantRegistrySql(SOURCE),
        eventsSql(SOURCE),
        ...[...TABLES, ...EVENT_SCENARIOS.map(({ table }) => table)].flatMap((table) => [tableSql(table), policySql(table)]),
      ],
    });
    app = await createService({
      name: SOURCE,
      version: '1.0.0',
      env: loadEnv(undefined, {
        PORT: '8199',
        OPT2_SERVICE_NAME: SOURCE,
        OPT2_ENV: 'local',
        OPT2_JWKS_URL: 'http://127.0.0.1:9/jwks',
        OPT2_TOKEN_ISSUER: 'opt2-local-identity',
        OPT2_TOKEN_AUDIENCE: 'opt2-local',
        OPT2_STATE_DIR: join(tmpdir(), 'opt2-testing-isolation-unused'),
        TZ: 'UTC',
      }),
      verifierOverride: testVerifier(SOURCE),
      logger: createLogger({ service: SOURCE, version: 'test', env: 'local', destination: { write: () => undefined } }),
      pool: handle.app,
    });
    for (const scenario of EVENT_SCENARIOS) {
      const subscription = subscriptionName(scenario.consumer, TOPIC);
      registerPushSubscription(app, { subscription, consumer: consumerOf(scenario), payloadSchema: NOTE_PAYLOAD_SCHEMA, publisher });
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await handle?.drop();
    }
  });

  defineIsolationSuite({ describe, it, expect, beforeAll }, optionsFor('note', { name: 'NOT NULL domain id and payload' }));

  it.each(SCENARIOS)('$label', async ({ table, overrides, afterSeed, failures, message }) => {
    const recorded = recordingApi();
    defineIsolationSuite(recorded.api, optionsFor(table, overrides));
    for (const hook of recorded.hooks) await hook();
    if (afterSeed !== undefined && handle !== undefined) await afterSeed(handle);
    const failed = await runCases(recorded.cases);
    const counts: Partial<Record<Kind, number>> = {};
    for (const { name } of failed) counts[kindOf(name)] = (counts[kindOf(name)] ?? 0) + 1;
    expect(recorded.cases).toHaveLength(CASES_PER_TABLE);
    expect(counts).toEqual(failures);
    expect(failed.filter((failure) => message !== undefined && !message.test(failure.message))).toEqual([]);
  });

  it.each(EVENT_SCENARIOS)('$label', async (scenario) => {
    const subscription = subscriptionName(scenario.consumer, TOPIC);
    const [tenantless, delivery] = eventTitles(subscription);
    const recorded = recordingApi(false);
    defineIsolationSuite(recorded.api, optionsFor(scenario.table, { events: [eventOptions(subscription)] }));
    const byName = new Map(recorded.cases.map((registered) => [registered.name, registered]));
    // The delivery case runs first and with no seeding case before it, then the tenantless case.
    const cases = [delivery, tenantless].map((name) => byName.get(name) ?? { name, fn: () => Promise.reject(new Error(`${name} is not registered`)) });
    const failed = await runCases(cases);
    expect(failed).toEqual(scenario.failure === undefined ? [] : [{ name: delivery, message: scenario.failure }]);
    expect(applied.filter((entry) => entry.subscription === subscription).map(({ tenantId }) => tenantId)).toEqual(
      scenario.appliedIn.map(({ tenantId }) => tenantId),
    );
  });
});
