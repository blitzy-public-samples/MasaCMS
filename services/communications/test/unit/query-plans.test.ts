// SYNTHETIC: communications - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Plans PostgreSQL chooses for the communications reads exactly as production code sends them inside a tenant transaction. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureUnitGates, qualified } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type QueryConfig, type QueryResultRow, type TenantTx } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  getMessageDetail,
  listAdoptedScheduledTasks,
  listMessages,
  listTemplates,
  queuedLoginMailOlderThan,
  unstampedScheduledTasksOlderThan,
  type RecoveryBatch,
} from '../../src/repo/queries.js';
import { createCommunicationsRepository } from '../../src/repo/repository.js';
import { MESSAGE_STATES, UNITS } from '../../src/repo/tables.js';

const ROWS_PER_TENANT = 240;
const SITES = ['tenant-a', 'TENANT-A ', 'Tenant-B', 'tenant-c  ', 'other'];
const T0 = '2026-06-30 09:00:00';
const MESSAGE_ID = '00000001-AAAA-BBBB-CCCCDDDDEEEEFFFF';
const SORT_NODES = new Set(['Sort', 'Incremental Sort']);

/** One statement as production code sent it. */
interface Statement {
  text: string;
  values: unknown[];
}

/** A node of `EXPLAIN (FORMAT JSON)` output. */
interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

/** Runs `fn` on a handle of `tx` that records every statement sent through it; returns them in send order. */
async function capture(tx: TenantTx, fn: (recording: TenantTx) => Promise<unknown>): Promise<Statement[]> {
  const sent: Statement[] = [];
  const recording: TenantTx = {
    ...tx,
    query: <R extends QueryResultRow = QueryResultRow>(text: string | QueryConfig, values?: unknown[]) => {
      sent.push(typeof text === 'string' ? { text, values: values ?? [] } : { text: text.text, values: values ?? text.values ?? [] });
      return tx.query<R>(text, values);
    },
  };
  await fn(recording);
  return sent;
}

/** `plan` and every node below it, depth first. */
function nodesOf(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodesOf)];
}

type ExplainRow = { 'QUERY PLAN': [{ Plan: PlanNode }] };

/** Nodes of the plan chosen for `statement` in `tx` once sequential scans and sorts are priced out. */
async function planOf(tx: TenantTx, statement: Statement): Promise<PlanNode[]> {
  await tx.query('SET LOCAL enable_seqscan = off');
  await tx.query('SET LOCAL enable_sort = off');
  const { rows } = await tx.query<ExplainRow>(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values);
  return nodesOf((rows[0] as ExplainRow)['QUERY PLAN'][0].Plan);
}

/** One read: `run` sends it, and the `nth` SELECT from `table` it sends is the statement planned. */
interface PlanCase {
  read: string;
  table: string;
  nth: number;
  /** The only index the plan may read; null admits any of the table's indexes, as for counts, whose site match can only filter the tenant's rows. */
  index: string | null;
  /** The statement's ORDER BY must come from the index, with no sort node. */
  ordered: boolean;
  /** Text the index condition must also contain, such as a batch cursor's row comparison. */
  cond?: string;
  run: (tx: TenantTx, schema: string) => Promise<unknown>;
}

const PAGE = { siteId: 'Tenant-A', pageIndex: 2, itemsPerPage: 20 } as const;
const CUTOFF = new Date(2026, 5, 30, 12, 0, 0);
const AFTER = { limit: 25, after: { at: new Date(2026, 5, 30, 9, 30, 0), id: '00000120-AAAA-BBBB-CCCCDDDDEEEEFFFF' } };
const ADOPTED_NAMES = ['opt2-survey-S3-launch', 'opt2-survey-S9-launch'];
const MESSAGE_CURSOR = 'ROW(created, message_id) >';
const TASK_CURSOR = 'ROW(created_at, scheduled_task_id) >';

type BatchRead = (tx: TenantTx, batch?: RecoveryBatch) => Promise<unknown>;

/** Keyset batch reads: name, table, the partial index each batch must read, the cursor's index condition, and the read. */
const BATCH_READS: ReadonlyArray<[string, string, string, string, BatchRead]> = [
  ['stale queued login mail', 'message', 'message_login_mail_queued_idx', MESSAGE_CURSOR, (tx, batch) => queuedLoginMailOlderThan(tx, CUTOFF, batch)],
  ['overdue unstamped tasks', 'scheduled_task', 'scheduled_task_unstamped_idx', TASK_CURSOR, (tx, batch) => unstampedScheduledTasksOlderThan(tx, CUTOFF, batch)],
  ['scheduled adopted tasks', 'scheduled_task', 'scheduled_task_adopted_idx', TASK_CURSOR, (tx, batch) => listAdoptedScheduledTasks(tx, undefined, batch)],
  ['scheduled adopted tasks by name', 'scheduled_task', 'scheduled_task_adopted_idx', TASK_CURSOR, (tx, batch) => listAdoptedScheduledTasks(tx, ADOPTED_NAMES, batch)],
];

const CASES: readonly PlanCase[] = [
  {
    read: 'template list count',
    table: 'message_template',
    nth: 0,
    index: null,
    ordered: false,
    run: (tx) => listTemplates(tx, PAGE),
  },
  {
    read: 'template list page',
    table: 'message_template',
    nth: 1,
    index: 'message_template_site_created_idx',
    ordered: true,
    run: (tx) => listTemplates(tx, PAGE),
  },
  {
    read: 'message list count',
    table: 'message',
    nth: 0,
    index: null,
    ordered: false,
    run: (tx) => listMessages(tx, PAGE),
  },
  {
    read: 'message list page',
    table: 'message',
    nth: 1,
    index: 'message_site_created_idx',
    ordered: true,
    run: (tx) => listMessages(tx, PAGE),
  },
  {
    read: 'message delivery history',
    table: 'delivery_status',
    nth: 0,
    index: 'delivery_status_message_idx',
    ordered: true,
    run: (tx) => getMessageDetail(tx, MESSAGE_ID),
  },
  {
    read: 'latest delivery status before an append',
    table: 'delivery_status',
    nth: 0,
    index: 'delivery_status_message_idx',
    ordered: false,
    run: (tx, schema) =>
      createCommunicationsRepository({ clock: fixedClock('2026-06-30T12:00:00'), schema }).appendDeliveryStatus(tx, {
        messageId: MESSAGE_ID,
        state: 'sent',
        source: 'send',
      }),
  },
  {
    read: 'adopted task lookup by name before adoption',
    table: 'scheduled_task',
    nth: 0,
    index: 'scheduled_task_adopted_name_key',
    ordered: false,
    cond: 'task_name',
    // S12 is already adopted, so the adoption only reads.
    run: (tx, schema) =>
      createCommunicationsRepository({ clock: fixedClock('2026-06-30T12:00:00'), schema }).adoptScheduledTasks(tx, [
        {
          taskName: 'opt2-survey-S12-launch',
          queue: 'surveys-launch',
          queueTaskName: 'opt2-survey-S12-launch-v2',
          kind: 'survey-launch',
          sourceType: 'survey',
          sourceId: '00000012-AAAA-BBBB-CCCCDDDDEEEEFFFF',
          scheduleTime: CUTOFF,
          targetRoute: '/internal/v1/surveys/S12/launch',
          scheduleVersion: 2,
        },
      ]),
  },
  ...BATCH_READS.flatMap(([read, table, index, cond, run]): PlanCase[] => [
    { read: `${read} first batch`, table, nth: 0, index, ordered: true, run: (tx) => run(tx) },
    { read: `${read} batch after a cursor`, table, nth: 0, index, ordered: true, cond, run: (tx) => run(tx, AFTER) },
  ]),
];

const available = await pgAvailable();

describe.skipIf(!available)('communications query plans against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  const tenantA = tenantIdForSite('communications-plans-a');
  const tenantB = tenantIdForSite('communications-plans-b');

  /** Seeds templates and messages over SITES, with one status per message state, into the transaction's tenant. */
  async function seed(tx: TenantTx): Promise<void> {
    const id = (n: string): string => `lpad((${n})::text, 8, '0') || '-AAAA-BBBB-CCCCDDDDEEEEFFFF'`;
    const site = `($2::text[])[1 + n % cardinality($2::text[])]`;
    const created = `$3::timestamp + (n % 60) * interval '1 minute'`;
    await tx.query(
      `INSERT INTO ${qualified(tx.schema, 'message_template')} (tenant_id, template_id, siteid, name, subject, body_text, body_html, created, lastupdate)` +
        ` SELECT $1::uuid, ${id('n')}, ${site}, 'Welcome', 'Hello', 'Text', '', ${created}, ${created} FROM generate_series(1, $4::integer) AS n`,
      [tx.tenantId, SITES, T0, ROWS_PER_TENANT],
    );
    await tx.query(
      `INSERT INTO ${qualified(tx.schema, 'message')} (tenant_id, message_id, siteid, to_address, from_address, subject, body_text, body_html, state, created, source, row_version)` +
        ` SELECT $1::uuid, ${id('n')}, ${site}, 'to@example.com', 'noreply@opt2.local', 'Hello', 'Text', '', 'delivered', ${created}, 'send', 1` +
        ` FROM generate_series(1, $4::integer) AS n`,
      [tx.tenantId, SITES, T0, ROWS_PER_TENANT],
    );
    await tx.query(
      `INSERT INTO ${qualified(tx.schema, 'delivery_status')} (tenant_id, status_id, message_id, status, recorded_at, source)` +
        ` SELECT $1::uuid, ${id('n * 10 + s')}, ${id('n')}, ($2::text[])[s], $3::timestamp + s * interval '1 second', 'send'` +
        ` FROM generate_series(1, $4::integer) AS n, generate_series(1, cardinality($2::text[])) AS s`,
      [tx.tenantId, [...MESSAGE_STATES], T0, ROWS_PER_TENANT],
    );
    // Every tenth message is login mail still queued; every task is stamped except every twentieth, and every twelfth is adopted.
    await tx.query(
      `UPDATE ${qualified(tx.schema, 'message')} SET source = 'login-mail', state = 'queued' WHERE right(split_part(message_id, '-', 1), 1) = '0'`,
    );
    await tx.query(
      `INSERT INTO ${qualified(tx.schema, 'scheduled_task')} (tenant_id, scheduled_task_id, task_name, queue, queue_task_name, kind, source_type,` +
        ' source_id, reminder_n, schedule_time, status, target_route, schedule_version, origin, enqueued_at, dequeued_at, created_at, updated_at)' +
        ` SELECT $1::uuid, ${id('n')}, 'opt2-survey-S' || n || '-launch', 'surveys-launch', 'opt2-survey-S' || n || '-launch-v1', 'survey-launch',` +
        ` 'survey', ${id('n')}, NULL, ${created}, CASE WHEN n % 7 = 0 THEN 'done' ELSE 'scheduled' END, '/internal/v1/surveys/S' || n || '/launch', 1,` +
        ` CASE WHEN n % 12 = 0 THEN 'adopted' ELSE 'event' END, CASE WHEN n % 20 = 0 THEN NULL ELSE ${created} END, NULL, ${created}, ${created}` +
        ' FROM generate_series(1, $2::integer) AS n',
      [tx.tenantId, ROWS_PER_TENANT, T0],
    );
  }

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'communications',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`),
    );
    for (const tenant of [tenantA, tenantB]) {
      await handle.app.withTenant(tenant, seed);
    }
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each(CASES.map((c) => [c.read, c] as const))('plans the %s on its index', async (_read, c) => {
    const nodes = await handle.app.withTenant(tenantA, async (tx) => {
      const from = `FROM ${qualified(handle.schema, c.table)} `;
      const reads = (await capture(tx, (recording) => c.run(recording, handle.schema))).filter(
        (statement) => statement.text.startsWith('SELECT') && statement.text.includes(from),
      );
      const statement = reads[c.nth];
      expect(statement, `${c.read} sends its statement`).toBeDefined();
      return planOf(tx, statement as Statement);
    });

    const scans = nodes.filter((node) => node['Index Name'] !== undefined);
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((node) => node['Index Cond']?.includes('tenant_id') === true)).toBe(true);
    if (c.index !== null) {
      expect(scans.map((node) => node['Index Name'])).toEqual(scans.map(() => c.index));
    }
    if (c.cond !== undefined) {
      expect(scans.map((node) => node['Index Cond'])).toEqual(scans.map(() => expect.stringContaining(c.cond as string)));
    }
    expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    if (c.ordered) {
      expect(nodes.filter((node) => SORT_NODES.has(node['Node Type'])).map((node) => node['Node Type'])).toEqual([]);
    }
  });
});
