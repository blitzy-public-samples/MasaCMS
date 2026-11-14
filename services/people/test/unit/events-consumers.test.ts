/** People's push consumers: subscription names and registrations. */
import { describe, expect, it } from 'vitest';
import { compileTopicSchema, subscriptionName } from '@opt2/platform/events';
import { tenantRegistryConsumer } from '@opt2/platform/tenancy';
import { GROUP_NAME_SUBSCRIPTION, SITE_CHANGED_SUBSCRIPTION, groupNameConsumer, peopleConsumerRegistrations } from '../../src/events/consumers.js';
import { GROUP_CHANGED_TOPIC, SITE_CHANGED_TOPIC, groupChangedSchema, siteChangedSchema } from '../../src/events/topics.js';
import { createPeopleRepository } from '../../src/repo/repository.js';

describe('people consumer registrations', () => {
  it('names each push subscription as the platform derives it', () => {
    expect(SITE_CHANGED_SUBSCRIPTION).toBe(subscriptionName('people', SITE_CHANGED_TOPIC));
    expect(GROUP_NAME_SUBSCRIPTION).toBe(subscriptionName('people', GROUP_CHANGED_TOPIC));
  });

  it('registers the site registry consumer first, then the group-name projection, each with its producer schema and kind', () => {
    const repository = createPeopleRepository();

    const registrations = peopleConsumerRegistrations(repository);

    expect(registrations.map(({ consumer, payloadSchema }) => [consumer.topic, payloadSchema])).toStrictEqual([
      [SITE_CHANGED_TOPIC, siteChangedSchema],
      [GROUP_CHANGED_TOPIC, groupChangedSchema],
    ]);
    expect(registrations[0]?.consumer).toBe(tenantRegistryConsumer);
    for (const { consumer, payloadSchema } of registrations) {
      expect(consumer.kind).toBe(compileTopicSchema(payloadSchema).meta.kind);
      expect(consumer.fanout).toBeUndefined();
    }
  });

  it('declares the group topic as full state without a fan-out, with a tenant re-check of its own', () => {
    const consumer = groupNameConsumer(createPeopleRepository());

    expect(consumer).toMatchObject({ topic: GROUP_CHANGED_TOPIC, kind: 'state' });
    expect(consumer.fanout).toBeUndefined();
    expect(consumer.checkTenant).toBeTypeOf('function');
  });
});
