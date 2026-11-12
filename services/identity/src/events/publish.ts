/** Identity's outbox producer of its group, membership, permission and login-mail topics; publishing is the platform outbox's flush and sweep. */
import { compileTopicSchema, readTopicSchema, type EventEnvelope, type TopicValidator } from '@opt2/platform/events';
import type { AppliedChange, MigrationHandlerOptions, WriteContext } from '@opt2/platform/migration-kit';
import { writeOutbox, type OutboxOrigin } from '@opt2/platform/outbox';
import { siteForTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { IdentityGroupChangedV1 as GroupChangedPayload } from '../generated/events/identity.group.changed.v1.js';
import type { IdentityLoginMailRequestedV1Payload as LoginMailRequestedPayload } from '../generated/events/identity.login-mail.requested.v1.js';
import type { IdentityMembershipChangedV1Payload as MembershipChangedPayload } from '../generated/events/identity.membership.changed.v1.js';
import type { IdentityPermissionChangedV1Payload as PermissionChangedPayload } from '../generated/events/identity.permission.changed.v1.js';
import type { IdentityRepository } from '../repo/repository.js';
import { GROUP_ACCOUNT, MEMBERSHIP, PERMISSION, type GroupAccountRow, type MembershipRow, type PermissionRow } from '../repo/tables.js';

export type { GroupChangedPayload, LoginMailRequestedPayload, MembershipChangedPayload, PermissionChangedPayload };

/** Full-state topic of one group account. */
export const GROUP_CHANGED_TOPIC = 'identity.group.changed.v1' as const;
/** Full-state topic of the groups one user belongs to. */
export const MEMBERSHIP_CHANGED_TOPIC = 'identity.membership.changed.v1' as const;
/** Full-state topic of one group's permission rows in one site. */
export const PERMISSION_CHANGED_TOPIC = 'identity.permission.changed.v1' as const;
/** Process topic of one login-information mail to send. */
export const LOGIN_MAIL_REQUESTED_TOPIC = 'identity.login-mail.requested.v1' as const;

/** Every topic identity produces. */
export const IDENTITY_TOPICS = [
  GROUP_CHANGED_TOPIC,
  MEMBERSHIP_CHANGED_TOPIC,
  PERMISSION_CHANGED_TOPIC,
  LOGIN_MAIL_REQUESTED_TOPIC,
] as const;

/** One topic identity produces. */
export type IdentityTopic = (typeof IDENTITY_TOPICS)[number];

/** Compiled payload schemas of `contracts/events/`, by topic, for the outbox runtime's write-time check. */
export const identityPayloadValidators: Record<string, TopicValidator> = Object.freeze(
  Object.fromEntries(
    IDENTITY_TOPICS.map((topic) => [
      topic,
      compileTopicSchema(readTopicSchema(new URL(`../../contracts/events/${topic}.json`, import.meta.url))),
    ]),
  ),
);

/** Group columns the group event carries; `ispublic` may arrive as the driver's text form. */
export type GroupPayloadSource = Pick<GroupAccountRow, 'userid' | 'siteid' | 'groupname'> & { ispublic: number | string | null };

/** A group row as read after its write, or its before-image for a delete. */
export type GroupEventRow = GroupPayloadSource & Pick<GroupAccountRow, 'row_version'>;

/** Options of a group event; `operationId` holds the row until the operation is released. */
export interface GroupChangedOptions {
  deleted: boolean;
  operationId?: string;
  origin?: OutboxOrigin;
}

/** The complete membership set of one user. */
export interface MembershipChangedInput {
  userId: string;
  siteId: string;
  groupIds: readonly string[];
}

/** Options of a membership event; `operationId` holds the row until the operation is released. */
export interface MembershipChangedOptions {
  operationId?: string;
  origin?: OutboxOrigin;
}

/** Every stored permission row of one group in one site. */
export interface PermissionChangedInput {
  groupId: string;
  siteId: string;
  rows: readonly Pick<PermissionRow, 'contentid' | 'siteid' | 'type'>[];
}

/** Options of a permission event. */
export interface PermissionChangedOptions {
  origin?: OutboxOrigin;
}

/** Outbox writes of identity's events in the caller's tenant transaction; each returns the stored envelope, or null when the origin suppresses it. */
export interface IdentityEvents {
  /** Writes a group's state at its `row_version`, or at `row_version + 1` from the before-image when `deleted`. */
  publishGroupChanged(tx: TenantTx, group: GroupEventRow, opts: GroupChangedOptions): Promise<EventEnvelope<GroupChangedPayload> | null>;
  /** Writes a user's membership set, de-duplicated and sorted, at the next membership sequence version. */
  publishMembershipChanged(
    tx: TenantTx,
    input: MembershipChangedInput,
    opts?: MembershipChangedOptions,
  ): Promise<EventEnvelope<MembershipChangedPayload> | null>;
  /** Writes a group's permission rows in one site, sorted by content id then type, at the next permission sequence version. */
  publishPermissionChanged(
    tx: TenantTx,
    input: PermissionChangedInput,
    opts?: PermissionChangedOptions,
  ): Promise<EventEnvelope<PermissionChangedPayload> | null>;
  /** Writes one login mail request with exactly the contract's keys. */
  publishLoginMailRequested(tx: TenantTx, payload: LoginMailRequestedPayload): Promise<EventEnvelope<LoginMailRequestedPayload> | null>;
  /** Writes the group, membership or permission state event of one migration-applied change in the apply transaction. */
  emitStateEvents: NonNullable<MigrationHandlerOptions['emitStateEvents']>;
}

/** CFML numeric flag of `isPublic`; values outside 0 and 1 are left for the contract validator to reject. */
function publicFlag(value: number | string | null): 0 | 1 | null {
  return value === null ? null : (Number(value) as 0 | 1);
}

/** The `identity.group.changed.v1` payload of a group row; the pool tenant is the tenant holding the row. */
export function groupChangedPayload(row: GroupPayloadSource, { deleted }: { deleted: boolean }, poolTenantId: string): GroupChangedPayload {
  return {
    groupId: row.userid,
    // A group without a site id has no contract form; '' makes the payload validator reject it.
    siteId: row.siteid ?? '',
    groupName: row.groupname ?? null,
    type: 1,
    isPublic: publicFlag(row.ispublic),
    poolTenantId,
    deleted,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function membershipPayload(input: MembershipChangedInput): MembershipChangedPayload {
  return { userId: input.userId, siteId: input.siteId, groupIds: [...new Set(input.groupIds)].sort(compareText) };
}

function permissionPayload(input: PermissionChangedInput): PermissionChangedPayload {
  const rows = input.rows
    .map((row) => ({ contentId: row.contentid, siteId: row.siteid, type: row.type }))
    .sort((a, b) => compareText(a.contentId, b.contentId) || compareText(a.type, b.type));
  return { groupId: input.groupId, siteId: input.siteId, rows };
}

/** The row image an applied change leaves: the before-image of a delete, the stored row otherwise. */
function appliedImage<R>(change: AppliedChange): R {
  const image = change.op === 'delete' ? change.before : change.after;
  if (image === undefined) {
    throw new Error(`Applied ${change.op} on ${change.unit} carries no row image`);
  }
  return image as R;
}

/** Builds identity's event writers over `repository`, the only path to the `identity.aggregate_version` sequences and group versions. */
export function createIdentityEvents(repository: IdentityRepository): IdentityEvents {
  // Applies call emitStateEvents per row with no end-of-batch hook, so each row re-announces its aggregate's full state;
  // a row that leaves the state last written in its transaction writes no event.
  const emittedStates = new WeakMap<TenantTx, Map<string, string>>();

  function changesEmittedState(tx: TenantTx, aggregateKey: string, payload: unknown): boolean {
    let states = emittedStates.get(tx);
    if (states === undefined) {
      states = new Map();
      emittedStates.set(tx, states);
    }
    const state = JSON.stringify(payload);
    if (states.get(aggregateKey) === state) {
      return false;
    }
    states.set(aggregateKey, state);
    return true;
  }

  function writeGroupChanged(
    tx: TenantTx,
    group: GroupEventRow,
    payload: GroupChangedPayload,
    opts: GroupChangedOptions,
  ): Promise<EventEnvelope<GroupChangedPayload> | null> {
    return writeOutbox(tx, {
      topic: GROUP_CHANGED_TOPIC,
      kind: 'state',
      aggregateType: 'group',
      aggregateId: group.userid,
      aggregateVersion: Number(group.row_version) + (opts.deleted ? 1 : 0),
      payload,
      operationId: opts.operationId,
      origin: opts.origin,
    });
  }

  async function writeMembershipChanged(
    tx: TenantTx,
    payload: MembershipChangedPayload,
    opts: MembershipChangedOptions,
    ctx: WriteContext,
  ): Promise<EventEnvelope<MembershipChangedPayload> | null> {
    return writeOutbox(tx, {
      topic: MEMBERSHIP_CHANGED_TOPIC,
      kind: 'state',
      aggregateType: 'user',
      aggregateId: payload.userId,
      aggregateVersion: await repository.nextAggregateVersion(tx, MEMBERSHIP_CHANGED_TOPIC, payload.userId, ctx),
      payload,
      operationId: opts.operationId,
      origin: opts.origin,
    });
  }

  async function writePermissionChanged(
    tx: TenantTx,
    payload: PermissionChangedPayload,
    opts: PermissionChangedOptions,
    ctx: WriteContext,
  ): Promise<EventEnvelope<PermissionChangedPayload> | null> {
    return writeOutbox(tx, {
      topic: PERMISSION_CHANGED_TOPIC,
      kind: 'state',
      aggregateType: 'group',
      aggregateId: payload.groupId,
      aggregateVersion: await repository.nextAggregateVersion(tx, PERMISSION_CHANGED_TOPIC, payload.groupId, ctx),
      payload,
      origin: opts.origin,
    });
  }

  const publishGroupChanged: IdentityEvents['publishGroupChanged'] = (tx, group, opts) =>
    writeGroupChanged(tx, group, groupChangedPayload(group, { deleted: opts.deleted }, tx.tenantId), opts);

  const publishMembershipChanged: IdentityEvents['publishMembershipChanged'] = (tx, input, opts = {}) =>
    writeMembershipChanged(tx, membershipPayload(input), opts, { operationId: opts.operationId, origin: opts.origin });

  const publishPermissionChanged: IdentityEvents['publishPermissionChanged'] = (tx, input, opts = {}) =>
    writePermissionChanged(tx, permissionPayload(input), opts, { origin: opts.origin });

  const publishLoginMailRequested: IdentityEvents['publishLoginMailRequested'] = async (tx, payload) => {
    const message: LoginMailRequestedPayload = {
      messageId: payload.messageId,
      userId: payload.userId,
      returnId: payload.returnId,
      siteId: payload.siteId,
      to: payload.to,
      from: payload.from,
      subject: payload.subject,
      text: payload.text,
      bcc: payload.bcc,
      kind: payload.kind,
    };
    return writeOutbox(tx, {
      topic: LOGIN_MAIL_REQUESTED_TOPIC,
      kind: 'process',
      aggregateType: 'user',
      aggregateId: payload.userId,
      aggregateVersion: await repository.nextAggregateVersion(tx, LOGIN_MAIL_REQUESTED_TOPIC, payload.userId),
      payload: message,
    });
  };

  async function emitGroup(tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
    const image = appliedImage<GroupEventRow>(change);
    const deleted = change.op === 'delete';
    const payload = groupChangedPayload(image, { deleted }, tx.tenantId);
    if (!changesEmittedState(tx, `group:${image.userid}`, payload)) {
      return;
    }
    if (deleted) {
      await writeGroupChanged(tx, image, payload, { deleted, origin: change.origin });
      return;
    }
    // Applied upserts leave row_version as stored, so it is advanced here; the update also re-reads the row without the
    // window-phase wait a findGroup read would take during a window import.
    const bumped = await repository.update<GroupAccountRow>(
      tx,
      GROUP_ACCOUNT.table,
      { userid: image.userid },
      { row_version: String(BigInt(image.row_version) + 1n) },
      write,
    );
    if (bumped === null) {
      throw new Error(`Applied group ${image.userid} is missing from its apply transaction`);
    }
    await writeGroupChanged(tx, bumped, payload, { deleted, origin: change.origin });
  }

  async function emitMembership(tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
    const { userid: userId } = appliedImage<MembershipRow>(change);
    const groupIds = await repository.membershipGroupIds(tx, userId, write);
    const account = await repository.findAccountById(tx, userId, { includePending: true }, write);
    // A membership migrated without its account is loaded as-is; its tenant's site stands in for the user's.
    const siteId = account?.siteid ?? (await siteForTenant(tx, tx.tenantId));
    if (siteId === null) {
      throw new Error(`Membership user ${userId} has no account and tenant ${tx.tenantId} no registered site`);
    }
    const payload = membershipPayload({ userId, siteId, groupIds });
    if (changesEmittedState(tx, `membership:${userId}`, payload)) {
      await writeMembershipChanged(tx, payload, { origin: change.origin }, write);
    }
  }

  async function emitPermission(tx: TenantTx, change: AppliedChange, write: WriteContext): Promise<void> {
    const { groupid: groupId, siteid: siteId } = appliedImage<PermissionRow>(change);
    const rows = await repository.groupPermissions(tx, groupId, siteId, write);
    const payload = permissionPayload({ groupId, siteId, rows });
    if (changesEmittedState(tx, `permission:${JSON.stringify([groupId, siteId])}`, payload)) {
      await writePermissionChanged(tx, payload, { origin: change.origin }, write);
    }
  }

  const emitters = new Map<string, IdentityEvents['emitStateEvents']>([
    [GROUP_ACCOUNT.unit, emitGroup],
    [MEMBERSHIP.unit, emitMembership],
    [PERMISSION.unit, emitPermission],
  ]);

  const emitStateEvents: IdentityEvents['emitStateEvents'] = async (tx, change, write) => {
    await emitters.get(change.unit)?.(tx, change, write);
  };

  return Object.freeze({
    publishGroupChanged,
    publishMembershipChanged,
    publishPermissionChanged,
    publishLoginMailRequested,
    emitStateEvents,
  });
}
