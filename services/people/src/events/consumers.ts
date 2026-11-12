/** Push consumers of people: the site registry topic, applied by the platform registry consumer, and identity's group topic, kept as the `people.group_name` projection. */
import type { ConsumerDefinition, ConsumerRegistration } from '@opt2/platform/events';
import { tenantRegistryConsumer } from '@opt2/platform/tenancy';
import type { PeopleRepository } from '../repo/repository.js';
import { GROUP_CHANGED_TOPIC, groupChangedSchema, siteChangedSchema, type GroupChangedPayload } from './topics.js';

/** Push subscription of people on the site registry topic; equals `subscriptionName('people', SITE_CHANGED_TOPIC)`. */
export const SITE_CHANGED_SUBSCRIPTION = 'people.programs-sites.site.changed.v1' as const;

/** Push subscription of people on identity's group topic; equals `subscriptionName('people', GROUP_CHANGED_TOPIC)`. */
export const GROUP_NAME_SUBSCRIPTION = 'people.identity.group.changed.v1' as const;

/** Stores or removes the group-name projection row of each applied group state, in the envelope tenant (the group's pool site). */
export function groupNameConsumer(repository: PeopleRepository): ConsumerDefinition<GroupChangedPayload> {
  return {
    topic: GROUP_CHANGED_TOPIC,
    kind: 'state',
    async apply(tx, envelope) {
      const { payload } = envelope;
      if (payload.deleted) {
        await repository.deleteGroupName(tx, payload.groupId);
        return;
      }
      await repository.upsertGroupName(tx, {
        group_id: payload.groupId,
        site_id: payload.siteId,
        group_name: payload.groupName,
        is_public: payload.isPublic,
        deleted: payload.deleted,
        aggregate_version: envelope.aggregateVersion,
      });
    },
  };
}

/**
 * The `registerConsumers` entries of people, site registry first.
 * A platform entry is only consumer and schema; `registerConsumers` derives each subscription, which equals its `*_SUBSCRIPTION` constant.
 */
export function peopleConsumerRegistrations(repository: PeopleRepository): ConsumerRegistration[] {
  return [
    { consumer: tenantRegistryConsumer, payloadSchema: siteChangedSchema },
    { consumer: groupNameConsumer(repository), payloadSchema: groupChangedSchema },
  ];
}
