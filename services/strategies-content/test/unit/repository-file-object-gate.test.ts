/** Object-manifest writes (`files.upsertFileObject`, `files.deleteFileObject`) under the `content.file` write gate, with an issued, a non-issued or no migration authority. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GateClosedError,
  UnitNotAuthoritativeError,
  closeGates,
  ensureUnitGates,
  openGates,
  requestMigrationAuthority,
  withGatedTenant,
  type MigrationAuthority,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { Roles } from '@opt2/platform/auth';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { withTenant, type TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { createContentRepository, type ContentRepository } from '../../src/repo/repository.js';
import { CONTENT_UNITS } from '../../src/repo/tables.js';

const FILE_UNIT = 'content.file';
const HOLDER = 'file-object-gate-test';
const BUDGET_MS = 200;
const NOW = new Date(2026, 5, 30, 10, 15, 42, 123);

let handle: ThrowawaySchema;
let repo: ContentRepository;
let migration: WriteContext = {};
let keySeq = 0;

type GateSetting = 'open' | 'legacy' | 'closed';

/** One object-manifest write: whether its object exists beforehand, the changelog op it writes, and the call. */
interface ObjectWrite {
  name: string;
  existing: boolean;
  op: 'insert' | 'delete';
  run: (tx: TenantTx, objectKey: string, ctx?: WriteContext) => Promise<unknown>;
}

const WRITES: readonly ObjectWrite[] = [
  {
    name: 'upsertFileObject',
    existing: false,
    op: 'insert',
    run: (tx, objectKey, ctx) => repo.files.upsertFileObject(tx, objectRow(objectKey), ctx),
  },
  {
    name: 'deleteFileObject',
    existing: true,
    op: 'delete',
    run: (tx, objectKey, ctx) => repo.files.deleteFileObject(tx, { objectKey }, ctx),
  },
];

/** A manifest row of a PDF original stored under `objectKey`. */
function objectRow(objectKey: string) {
  return { file_id: 'F0000001-AAAA-BBBB-CCCCDDDDEEEEFFFF', variant: '', ext: 'pdf', object_key: objectKey, size: 12, sha256: 'a'.repeat(64), content_type: 'application/pdf' };
}

/** Runs `fn` in tenant A under the short gate budget. */
function gated<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return withGatedTenant(handle.app, TENANT_A.tenantId, fn, { budgetMs: BUDGET_MS });
}

/** Sets the `content.file` gate to `state` under this test's holder. */
async function setFileGate(state: GateSetting): Promise<void> {
  await closeGates(handle.app, { units: [FILE_UNIT], holderId: HOLDER, allowLegacy: true });
  if (state !== 'closed') {
    await openGates(handle.app, { units: [FILE_UNIT], holderId: HOLDER, state });
  }
}

/** How many manifest rows carry `objectKey`, and the `file_object` changelog ops so far. */
async function observe(objectKey: string): Promise<{ rows: number; ops: string[] }> {
  return withTenant(handle.app, TENANT_A.tenantId, async (tx) => ({
    rows: (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${handle.schema}.file_object WHERE object_key = $1`, [objectKey])).rows[0]?.n ?? 0,
    ops: (await tx.query<{ op: string }>(`SELECT op FROM ${handle.schema}.changelog WHERE "table" = 'file_object' ORDER BY seq`)).rows.map((row) => row.op),
  }));
}

/** A fresh object key, with its manifest row stored through an open gate when `write` deletes an existing object. */
async function prepare(write: ObjectWrite): Promise<string> {
  keySeq += 1;
  const objectKey = `${TENANT_A.tenantId}/F${keySeq}-${write.name}.pdf`;
  if (write.existing) {
    await gated((tx) => repo.files.upsertFileObject(tx, objectRow(objectKey)));
  }
  return objectKey;
}

describe.skipIf(!(await pgAvailable()))('repo/repository file_object write gate', () => {
  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'strategies-content',
      schemaName: 'content',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    await ensureUnitGates(handle.app, CONTENT_UNITS);
    await setFileGate('open');
    repo = createContentRepository({ clock: fixedClock(NOW), schema: handle.schema });
    const authority = runWithRequestContext({ ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } }, () =>
      requestMigrationAuthority(),
    );
    if (authority === undefined) {
      throw new Error('a platform.migration caller got no migration authority');
    }
    migration = { authority };
  });

  afterAll(async () => {
    await handle?.drop();
  });

  it.each(
    WRITES.flatMap((write) =>
      (['no', 'non-issued'] as const).flatMap((authority) => [
        { ...write, authority, state: 'legacy' as const, error: UnitNotAuthoritativeError, waitMs: 0 },
        { ...write, authority, state: 'closed' as const, error: GateClosedError, waitMs: BUDGET_MS },
      ]),
    ),
  )('$name with content.file $state and $authority authority fails and writes neither the row nor a changelog row', async (write) => {
    const objectKey = await prepare(write);
    const before = await observe(objectKey);
    const ctx: WriteContext | undefined = write.authority === 'non-issued' ? { authority: { ...migration.authority } as MigrationAuthority } : undefined;
    await setFileGate(write.state);
    try {
      const started = Date.now();
      const outcome = gated((tx) => write.run(tx, objectKey, ctx));
      await expect(outcome).rejects.toBeInstanceOf(write.error);
      await expect(outcome).rejects.toMatchObject({ units: [FILE_UNIT] });
      expect(Date.now() - started).toBeGreaterThanOrEqual(write.waitMs);
    } finally {
      await setFileGate('open');
    }
    expect(await observe(objectKey)).toEqual(before);
  });

  it.each(
    WRITES.flatMap((write) => [
      { ...write, state: 'open' as const, migration: false },
      { ...write, state: 'legacy' as const, migration: true },
      { ...write, state: 'closed' as const, migration: true },
    ]),
  )('$name with content.file $state and migration authority $migration writes with one changelog row', async (write) => {
    const objectKey = await prepare(write);
    const before = await observe(objectKey);
    await setFileGate(write.state);
    try {
      await gated((tx) => write.run(tx, objectKey, write.migration ? migration : undefined));
    } finally {
      await setFileGate('open');
    }
    expect(await observe(objectKey)).toEqual({ rows: write.existing ? 0 : 1, ops: [...before.ops, write.op] });
  });
});
