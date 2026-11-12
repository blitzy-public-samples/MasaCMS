/** Identity's outbox producer: payload builders, per-topic version sequences, held operation rows and the state events of migration applies. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Roles } from '@opt2/platform/auth';
import {
  ensureUnitGates,
  requestMigrationAuthority,
  type AppliedChange,
  type GatePhase,
  type GateState,
  type WriteContext,
} from '@opt2/platform/migration-kit';
import { createOutbox, discardOperation, releaseOperation } from '@opt2/platform/outbox';
import { tenantIdForSite, withMetadata, type TenantTx } from '@opt2/platform/tenancy';
import { createLogger } from '@opt2/platform/logging';
import { newRequestContext, runWithRequestContext } from '@opt2/platform/service-kit';
import { createCapturingPublisher, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  GROUP_CHANGED_TOPIC,
  IDENTITY_TOPICS,
  LOGIN_MAIL_REQUESTED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  createIdentityEvents,
  groupChangedPayload,
  identityPayloadValidators,
  type IdentityEvents,
  type LoginMailRequestedPayload,
} from '../../src/events/publish.js';
import { createIdentityRepository, type GroupInput, type IdentityRepository } from '../../src/repo/repository.js';
import { GROUP_ACCOUNT, GROUP_TAG, IDENTITY_UNITS, MEMBERSHIP, PERMISSION } from '../../src/repo/tables.js';

interface StoredEvent {
  topic: string;
  kind: string;
  held: boolean;
  envelope: { aggregateVersion: number; aggregateId: string; payload: Record<string, unknown> };
}

const CLOCK = fixedClock(new Date(2026, 5, 30, 12, 0, 0));
const TENANT = '7b0e2f9e-5d0f-4c0e-9d7a-1a2b3c4d5e6f';

/** A 35-character CF UUID numbered `n` under the hex digit `prefix`. */
function id(n: number, prefix = 'A'): string {
  return `${prefix}0000000-0000-0000-${String(n).padStart(16, '0')}`;
}

/** Whether `payload` satisfies the compiled contract of `topic`. */
function conforms(topic: string, payload: unknown): boolean | undefined {
  return identityPayloadValidators[topic]?.validatePayload(payload).ok;
}

const MAIL: LoginMailRequestedPayload = {
  messageId: id(90, 'C'),
  userId: id(1),
  returnId: id(91, 'D'),
  siteId: 'default',
  to: 'a@example.com',
  from: 'Site',
  subject: 'Site Account Information',
  text: 'Dear A,\n',
  bcc: '',
  kind: 'forgot-password',
};

describe('publish module surface', () => {
  it('names the four topics and compiles their schemas', () => {
    expect(IDENTITY_TOPICS).toEqual([GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC, LOGIN_MAIL_REQUESTED_TOPIC]);
    expect(Object.keys(identityPayloadValidators)).toEqual([...IDENTITY_TOPICS]);
    expect(IDENTITY_TOPICS.map((t) => identityPayloadValidators[t]?.meta.kind)).toEqual(['state', 'state', 'state', 'process']);
    expect(Object.isFrozen(identityPayloadValidators)).toBe(true);
  });

  it.each([
    ['numeric flag', { userid: id(5, 'B'), siteid: 'default', groupname: 'Editors', ispublic: 1 }, 1, 'Editors'],
    ['null name and flag', { userid: id(5, 'B'), siteid: 'default', groupname: null, ispublic: null }, null, null],
    ['text flag', { userid: id(5, 'B'), siteid: 'default', groupname: 'X', ispublic: '0' }, 0, 'X'],
  ] as const)('builds a valid group payload with %s', (_l, row, isPublic, groupName) => {
    const payload = groupChangedPayload(row, { deleted: false }, TENANT);
    expect(payload).toEqual({ groupId: row.userid, siteId: 'default', groupName, type: 1, isPublic, poolTenantId: TENANT, deleted: false });
    expect(Object.keys(payload)).toEqual(['groupId', 'siteId', 'groupName', 'type', 'isPublic', 'poolTenantId', 'deleted']);
    expect(conforms(GROUP_CHANGED_TOPIC, payload)).toBe(true);
  });

  it('leaves a group without site id to the validator', () => {
    const payload = groupChangedPayload({ userid: id(5, 'B'), siteid: null, groupname: 'X', ispublic: 1 }, { deleted: true }, TENANT);
    expect(payload.siteId).toBe('');
    expect(conforms(GROUP_CHANGED_TOPIC, payload)).toBe(false);
  });

  it('rejects login mail payloads with extra keys', () => {
    expect(conforms(LOGIN_MAIL_REQUESTED_TOPIC, MAIL)).toBe(true);
    expect(conforms(LOGIN_MAIL_REQUESTED_TOPIC, { ...MAIL, password: 'x' })).toBe(false);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('identity events against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: IdentityRepository;
  let events: IdentityEvents;
  const capture = createCapturingPublisher();
  let tenants = 0;
  let tenantId: string;
  let siteId: string;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    repo = createIdentityRepository({ clock: CLOCK, schema: handle.schema });
    await ensureUnitGates(handle.app, IDENTITY_UNITS);
    const logger = createLogger({ service: 'identity', version: '1.0.0', env: 'local', destination: { write: () => undefined } });
    createOutbox({ service: 'identity', db: handle.app, publisher: capture, logger, clock: CLOCK, payloadValidators: identityPayloadValidators });
    events = createIdentityEvents(repo);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open', 'quiet');
    tenants += 1;
    siteId = `pub-site-${tenants}`;
    tenantId = tenantIdForSite(siteId);
    capture.clear();
  });

  async function setGates(state: GateState, phase: GatePhase): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`UPDATE ${handle.schema}.unit_gate SET state = $1, holder_id = $2, phase = $3`, [state, state === 'closed' ? 'w1' : null, phase]),
    );
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return handle.app.withTenant(tenantId, fn);
  }

  /** The write context a migration apply of `origin` passes, with its migration authority. */
  function migrationWrite(origin: WriteContext['origin'], batch: string): WriteContext {
    const store = { ...newRequestContext(), service: { name: 'migration', roles: [Roles.platformMigration] } };
    const authority = runWithRequestContext(store, () => requestMigrationAuthority());
    expect(authority).toBeDefined();
    return { origin, authority, requestId: batch };
  }

  function groupInput(overrides: Partial<GroupInput> = {}): GroupInput {
    return {
      groupname: 'Editors', fname: '', lname: '', username: '', password: '', email: '', company: '', jobtitle: '', mobilephone: '',
      website: '', type: 1, subtype: 'Default', contactform: '', s2: 0, perm: 0, inactive: 0, ispublic: 1, siteid: siteId,
      subscribe: 1, notes: '', description: '', interests: '', keepprivate: 0, photofileid: '', imname: '', imservice: '',
      remoteid: '', tags: '', tablist: '', ...overrides,
    };
  }

  /** Registers the current site and tenant in the schema's tenant registry. */
  async function registerSite(): Promise<void> {
    await withMetadata(handle.app, (tx) =>
      tx.query(`INSERT INTO ${handle.schema}.tenant_registry (site_id, tenant_id, aggregate_version, updated_at) VALUES ($1, $2, 1, now())`, [siteId, tenantId]),
    );
  }

  /** The tenant's committed outbox rows in write order. */
  async function outboxRows(): Promise<StoredEvent[]> {
    return inTenant(async (tx) => (await tx.query<StoredEvent>(`SELECT topic, kind, held, envelope FROM ${handle.schema}.outbox ORDER BY seq`)).rows);
  }

  /** One applied change of the current tenant; a delete carries `image` as its before-image. */
  function change(unit: string, table: string, op: AppliedChange['op'], image: Record<string, unknown>, origin: AppliedChange['origin'] = 'backfill'): AppliedChange {
    return { unit, table, op, ...(op === 'delete' ? { before: image } : { after: image }), origin, tenantId };
  }

  it('writes group saves at row_version and deletes one past it, publishing after commit', async () => {
    const group = await inTenant(async (tx) => {
      const created = await repo.insertGroup(tx, groupInput(), null);
      const envelope = await events.publishGroupChanged(tx, created, { deleted: false });
      expect(envelope?.aggregateVersion).toBe(1);
      expect(envelope?.tenantId).toBe(tenantId);
      expect(envelope?.payload).toEqual(groupChangedPayload(created, { deleted: false }, tenantId));
      return created;
    });
    expect(capture.published.map((p) => p.topic)).toEqual([GROUP_CHANGED_TOPIC]);
    const removed = await inTenant(async (tx) => {
      const before = await repo.deleteGroupRow(tx, group.userid);
      return events.publishGroupChanged(tx, before!, { deleted: true, origin: 'target' });
    });
    expect(removed?.aggregateVersion).toBe(2);
    expect(removed?.payload.deleted).toBe(true);
  });

  it('holds membership rows with an operation id until released, with per-topic sequences', async () => {
    const user = id(10);
    await inTenant(async (tx) => {
      const first = await events.publishMembershipChanged(tx, { userId: user, siteId, groupIds: [id(3, 'B'), id(1, 'B'), id(3, 'B')] }, { operationId: 'op-1' });
      expect(first?.payload.groupIds).toEqual([id(1, 'B'), id(3, 'B')]);
      expect(first?.aggregateVersion).toBe(1);
      const mail = await events.publishLoginMailRequested(tx, { ...MAIL, userId: id(11), password: 'secret' } as LoginMailRequestedPayload);
      expect(mail?.aggregateVersion).toBe(1);
      expect(Object.keys(mail?.payload ?? {})).toEqual(['messageId', 'userId', 'returnId', 'siteId', 'to', 'from', 'subject', 'text', 'bcc', 'kind']);
      const perm = await events.publishPermissionChanged(tx, { groupId: id(12, 'B'), siteId, rows: [] });
      expect(perm?.aggregateVersion).toBe(1);
      expect(perm?.payload.rows).toEqual([]);
    });
    expect(capture.published.map((p) => p.topic)).toEqual([LOGIN_MAIL_REQUESTED_TOPIC, PERMISSION_CHANGED_TOPIC]);
    expect((await outboxRows()).filter((r) => r.held).map((r) => r.topic)).toEqual([MEMBERSHIP_CHANGED_TOPIC]);
    await inTenant(async (tx) => {
      const second = await events.publishMembershipChanged(tx, { userId: user, siteId, groupIds: [] });
      expect(second?.aggregateVersion).toBe(2);
      expect(await releaseOperation(tx, 'op-1')).toBe(1);
    });
    expect(capture.published.map((p) => p.topic)).toEqual([LOGIN_MAIL_REQUESTED_TOPIC, PERMISSION_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC]);
    await inTenant(async (tx) => {
      await events.publishMembershipChanged(tx, { userId: user, siteId, groupIds: [id(1, 'B')] }, { operationId: 'op-2' });
      expect(await discardOperation(tx, 'op-2')).toBe(1);
    });
  });

  it('sorts permission rows by content id then type and validates them', async () => {
    const envelope = await inTenant((tx) =>
      events.publishPermissionChanged(tx, {
        groupId: id(4, 'B'),
        siteId,
        rows: [
          { contentid: '00000000000000000000000000000000008', siteid: siteId, type: 'module' },
          { contentid: '00000000000000000000000000000000001', siteid: siteId, type: 'Read' },
          { contentid: '00000000000000000000000000000000001', siteid: siteId, type: 'Editor' },
        ],
      }, { origin: 'legacy-window' }),
    );
    expect(envelope?.payload.rows.map((r) => `${r.contentId}:${r.type}`)).toEqual([
      '00000000000000000000000000000000001:Editor',
      '00000000000000000000000000000000001:Read',
      '00000000000000000000000000000000008:module',
    ]);
  });

  it('emits group, membership and permission state from backfill applies, never login mail, with rising group versions', async () => {
    const write = migrationWrite('backfill', 'batch-1');
    const groupId = id(20, 'B');
    const userId = id(21);
    async function applyBatch(): Promise<void> {
      await inTenant(async (tx) => {
        const group = await repo.upsert(tx, GROUP_ACCOUNT.table, { userid: groupId, groupname: 'Staff', type: 1, ispublic: 0, siteid: siteId }, write);
        await events.emitStateEvents(tx, change(GROUP_ACCOUNT.unit, GROUP_ACCOUNT.table, 'insert', group), write);
        await events.emitStateEvents(tx, change(GROUP_ACCOUNT.unit, GROUP_ACCOUNT.table, 'update', group), write);
        await repo.upsert(tx, 'user_account', { userid: userId, username: 'u', type: 2, siteid: siteId, opt2_state: 'active' }, write);
        const m1 = await repo.upsert(tx, MEMBERSHIP.table, { userid: userId, groupid: groupId }, write);
        await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m1), write);
        const m2 = await repo.upsert(tx, MEMBERSHIP.table, { userid: userId, groupid: id(22, 'B') }, write);
        await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m2), write);
        const p1 = await repo.upsert(tx, PERMISSION.table, { contentid: '00000000000000000000000000000000001', groupid: groupId, siteid: siteId, type: 'Editor' }, write);
        await events.emitStateEvents(tx, change(PERMISSION.unit, PERMISSION.table, 'insert', p1), write);
        await events.emitStateEvents(tx, change(GROUP_TAG.unit, GROUP_TAG.table, 'insert', { tagid: 1 }), write);
      });
    }
    await applyBatch();
    let rows = await outboxRows();
    expect(rows.map((r) => r.topic)).toEqual([GROUP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC]);
    expect(rows.some((r) => r.topic === LOGIN_MAIL_REQUESTED_TOPIC)).toBe(false);
    expect(rows[2]?.envelope.payload).toEqual({ userId, siteId, groupIds: [groupId, id(22, 'B')] });
    expect(rows[3]?.envelope.payload).toEqual({ groupId, siteId, rows: [{ contentId: '00000000000000000000000000000000001', siteId, type: 'Editor' }] });
    expect(rows[0]?.envelope.aggregateVersion).toBe(1);
    await applyBatch();
    rows = await outboxRows();
    const groupVersions = rows.filter((r) => r.topic === GROUP_CHANGED_TOPIC).map((r) => r.envelope.aggregateVersion);
    expect(groupVersions).toEqual([1, 2]);
    await inTenant(async (tx) => {
      const before = await repo.delete(tx, GROUP_ACCOUNT.table, { userid: groupId }, write);
      await events.emitStateEvents(tx, change(GROUP_ACCOUNT.unit, GROUP_ACCOUNT.table, 'delete', before!), write);
    });
    const last = (await outboxRows()).at(-1);
    expect(last?.envelope.aggregateVersion).toBe(3);
    expect(last?.envelope.payload.deleted).toBe(true);
  });

  it('reads applied state without waiting out a window import phase', async () => {
    const write = migrationWrite('legacy-window', 'window-batch');
    const userId = id(30);
    await inTenant((tx) => repo.upsert(tx, 'user_account', { userid: userId, username: 'w', type: 2, siteid: siteId, opt2_state: 'active' }, write));
    await setGates('closed', 'importing');
    const started = Date.now();
    await inTenant(async (tx) => {
      const m = await repo.upsert(tx, MEMBERSHIP.table, { userid: userId, groupid: id(31, 'B') }, write);
      await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m, 'legacy-window'), write);
      const p = await repo.upsert(tx, PERMISSION.table, { contentid: '00000000000000000000000000000000001', groupid: id(31, 'B'), siteid: siteId, type: 'Read' }, write);
      await events.emitStateEvents(tx, change(PERMISSION.unit, PERMISSION.table, 'insert', p, 'legacy-window'), write);
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await outboxRows()).map((r) => r.topic)).toEqual([MEMBERSHIP_CHANGED_TOPIC, PERMISSION_CHANGED_TOPIC]);
  });

  it('falls back to the registry site for orphan memberships and fails without one', async () => {
    const write = migrationWrite('backfill', 'orphan-batch');
    const orphan = id(40);
    await expect(
      inTenant(async (tx) => {
        const m = await repo.upsert(tx, MEMBERSHIP.table, { userid: orphan, groupid: id(41, 'B') }, write);
        await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m), write);
      }),
    ).rejects.toThrow(/has no account/);
    await registerSite();
    await inTenant(async (tx) => {
      const m = await repo.upsert(tx, MEMBERSHIP.table, { userid: orphan, groupid: id(41, 'B') }, write);
      await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m), write);
    });
    expect((await outboxRows()).map((r) => r.envelope.payload)).toEqual([{ userId: orphan, siteId, groupIds: [id(41, 'B')] }]);
  });

  it('writes one event per aggregate state within an apply transaction', async () => {
    const write = migrationWrite('migration-feed', 'feed-batch');
    const groupId = id(60, 'B');
    await registerSite();
    await inTenant(async (tx) => {
      const p = await repo.upsert(tx, PERMISSION.table, { contentid: '00000000000000000000000000000000001', groupid: groupId, siteid: siteId, type: 'Author' }, write);
      await events.emitStateEvents(tx, change(PERMISSION.unit, PERMISSION.table, 'insert', p, 'migration-feed'), write);
      await events.emitStateEvents(tx, change(PERMISSION.unit, PERMISSION.table, 'update', p, 'migration-feed'), write);
      const m = await repo.upsert(tx, MEMBERSHIP.table, { userid: id(61), groupid: groupId }, write);
      await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'insert', m, 'migration-feed'), write);
      await repo.delete(tx, MEMBERSHIP.table, { userid: id(61), groupid: groupId }, write);
      await events.emitStateEvents(tx, change(MEMBERSHIP.unit, MEMBERSHIP.table, 'delete', m, 'migration-feed'), write);
    });
    const rows = await outboxRows();
    expect(rows.map((r) => [r.topic, r.envelope.aggregateVersion])).toEqual([
      [PERMISSION_CHANGED_TOPIC, 1],
      [MEMBERSHIP_CHANGED_TOPIC, 1],
      [MEMBERSHIP_CHANGED_TOPIC, 2],
    ]);
    expect(rows.at(-1)?.envelope.payload.groupIds).toEqual([]);
  });

  it('throws for an applied group missing from its transaction and for a change without an image', async () => {
    const write = migrationWrite('backfill', 'bad-batch');
    const ghost = { userid: id(50, 'B'), groupname: 'G', siteid: siteId, ispublic: 1, row_version: '0' };
    await expect(inTenant((tx) => events.emitStateEvents(tx, change(GROUP_ACCOUNT.unit, GROUP_ACCOUNT.table, 'update', ghost), write))).rejects.toThrow(
      /missing from its apply transaction/,
    );
    await expect(
      inTenant((tx) => events.emitStateEvents(tx, { unit: GROUP_ACCOUNT.unit, table: GROUP_ACCOUNT.table, op: 'insert', origin: 'backfill', tenantId }, write)),
    ).rejects.toThrow(/carries no row image/);
  });
});
