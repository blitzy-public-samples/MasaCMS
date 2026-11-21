/** Push consumers of strategies-content: the site registry topic and identity's group, permission and membership projections. */
import {
  readTopicSchema,
  subscriptionName,
  type ConsumerDefinition,
  type ConsumerRegistration,
  type DeadLetterReason,
  type EventEnvelope,
} from '@opt2/platform/events';
import { SITE_CHANGED_TOPIC, registryEntryForTenant, tenantRegistryConsumer, type TenantTx } from '@opt2/platform/tenancy';
import type { IdentityGroupChangedV1 as GroupChangedPayload } from '../generated/events/identity.group.changed.v1.js';
import type { IdentityMembershipChangedV1Payload as MembershipChangedPayload } from '../generated/events/identity.membership.changed.v1.js';
import type { IdentityPermissionChangedV1Payload as PermissionChangedPayload } from '../generated/events/identity.permission.changed.v1.js';
import { OWNER, type ContentRepository } from '../repo/repository.js';

export { SITE_CHANGED_TOPIC };
export type { GroupChangedPayload, MembershipChangedPayload, PermissionChangedPayload };

/** Identity's full-state topics consumed into the `content` projections. */
export const GROUP_CHANGED_TOPIC = 'identity.group.changed.v1' as const;
export const PERMISSION_CHANGED_TOPIC = 'identity.permission.changed.v1' as const;
export const MEMBERSHIP_CHANGED_TOPIC = 'identity.membership.changed.v1' as const;

/** Push subscriptions of strategies-content, `strategies-content.<topic>`; each is the suffix of its `/internal/v1/events/` route. */
export const SITE_CHANGED_SUBSCRIPTION = subscriptionName(OWNER, SITE_CHANGED_TOPIC);
export const GROUP_CHANGED_SUBSCRIPTION = subscriptionName(OWNER, GROUP_CHANGED_TOPIC);
export const PERMISSION_CHANGED_SUBSCRIPTION = subscriptionName(OWNER, PERMISSION_CHANGED_TOPIC);
export const MEMBERSHIP_CHANGED_SUBSCRIPTION = subscriptionName(OWNER, MEMBERSHIP_CHANGED_TOPIC);

/** Every push subscription of strategies-content, in registration order. */
export const CONTENT_SUBSCRIPTIONS: readonly string[] = Object.freeze([
  SITE_CHANGED_SUBSCRIPTION,
  GROUP_CHANGED_SUBSCRIPTION,
  PERMISSION_CHANGED_SUBSCRIPTION,
  MEMBERSHIP_CHANGED_SUBSCRIPTION,
]);

/** Payload schemas of the consumed topics, read once from the producers' contracts. */
export const groupChangedSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.group.changed.v1.json', import.meta.url),
);
export const permissionChangedSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.permission.changed.v1.json', import.meta.url),
);
export const membershipChangedSchema = readTopicSchema(
  new URL('../../../identity/contracts/events/identity.membership.changed.v1.json', import.meta.url),
);
export const siteChangedSchema = readTopicSchema(
  new URL('../../../programs-sites/contracts/events/programs-sites.site.changed.v1.json', import.meta.url),
);

/** A site id in SQL Server's case-insensitive equality form: trailing spaces are insignificant, leading ones are not. */
function siteKey(siteId: string): string {
  return siteId.replace(/ +$/, '').toLowerCase();
}

/** Whether the envelope's aggregate is the payload's and each of `siteIds` is the envelope tenant's site; `invalid-tenant` when it is unregistered. */
async function boundToTenant(
  tx: TenantTx,
  envelope: Pick<EventEnvelope, 'aggregateType' | 'aggregateId'>,
  aggregate: { type: string; id: string },
  siteIds: readonly string[],
): Promise<boolean | DeadLetterReason> {
  if (envelope.aggregateType !== aggregate.type || envelope.aggregateId !== aggregate.id) {
    return false;
  }
  const entry = await registryEntryForTenant(tx, tx.tenantId);
  if (entry === null) {
    return 'invalid-tenant';
  }
  return siteIds.every((siteId) => siteKey(siteId) === siteKey(entry.siteId));
}

/** Stores each group state whose aggregate, pool tenant and site are the envelope's in `content.group_projection`; a deleted group stays as a tombstone row. */
export function groupProjectionConsumer(repository: ContentRepository): ConsumerDefinition<GroupChangedPayload> {
  return {
    topic: GROUP_CHANGED_TOPIC,
    kind: 'state',
    async checkTenant(tx, envelope) {
      const { payload } = envelope;
      const bound = await boundToTenant(tx, envelope, { type: 'group', id: payload.groupId }, [payload.siteId]);
      return bound === true ? payload.poolTenantId.toLowerCase() === tx.tenantId : bound;
    },
    async apply(tx, { payload }) {
      await repository.projections.upsertGroupProjection(tx, {
        groupId: payload.groupId,
        siteId: payload.siteId,
        groupName: payload.groupName,
        isPublic: payload.isPublic,
        deleted: payload.deleted,
      });
    },
  };
}

/** Replaces a group's `content.permission_projection` rows on the payload site with the stored grant rows when the group and every site are the envelope's; an empty list clears them. */
export function permissionProjectionConsumer(repository: ContentRepository): ConsumerDefinition<PermissionChangedPayload> {
  return {
    topic: PERMISSION_CHANGED_TOPIC,
    kind: 'state',
    checkTenant(tx, envelope) {
      const { payload } = envelope;
      return boundToTenant(tx, envelope, { type: 'group', id: payload.groupId }, [payload.siteId, ...payload.rows.map((row) => row.siteId)]);
    },
    async apply(tx, { payload }) {
      // Grant types keep their stored case; verdict code compares them case-insensitively, as permission.cfc does.
      const rows = payload.rows.map(({ contentId, siteId, type }) => ({ contentId, siteId, type }));
      await repository.projections.replaceGroupPermissions(tx, payload.groupId, payload.siteId, rows);
    },
  };
}

/** Replaces a user's `content.membership_projection` rows with the payload groups when the user and site are the envelope's; an empty list clears them. */
export function membershipProjectionConsumer(repository: ContentRepository): ConsumerDefinition<MembershipChangedPayload> {
  return {
    topic: MEMBERSHIP_CHANGED_TOPIC,
    kind: 'state',
    checkTenant(tx, envelope) {
      const { payload } = envelope;
      return boundToTenant(tx, envelope, { type: 'user', id: payload.userId }, [payload.siteId]);
    },
    async apply(tx, { payload }) {
      await repository.projections.replaceUserMemberships(tx, payload.userId, payload.siteId, payload.groupIds);
    },
  };
}

/**
 * The `registerConsumers` entries of strategies-content, in `CONTENT_SUBSCRIPTIONS` order.
 * A platform entry is only consumer and schema; `registerConsumers` derives each subscription, which equals its `*_SUBSCRIPTION` constant.
 */
export function contentConsumers(repository: ContentRepository): ConsumerRegistration[] {
  return [
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
    { consumer: groupProjectionConsumer(repository), payloadSchema: groupChangedSchema },
    { consumer: permissionProjectionConsumer(repository), payloadSchema: permissionChangedSchema },
    { consumer: membershipProjectionConsumer(repository), payloadSchema: membershipChangedSchema },
  ];
}
