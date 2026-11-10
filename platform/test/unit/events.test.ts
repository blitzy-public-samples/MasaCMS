import { describe, expect, it } from 'vitest';
import {
  InvalidEventNameError,
  PUSH_PATH_PREFIX,
  consumerOfSubscription,
  dlqReplaySubscriptionName,
  dlqTopicName,
  eventTypeOf,
  isTopicName,
  parseTopic,
  pushPath,
  schemaVersionOf,
  subscriptionName,
  topicName,
  topicOfSubscription,
  topicSchemaRelativePath,
} from '../../src/events/naming.js';

const SEGMENT_FORM = 'a name segment matching ^[a-z][a-z0-9-]*$';
const TOPIC_FORM = '<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const SUBSCRIPTION_FORM = '<consumer>.<service>.<entity>.<event>.v<major> (lowercase segments, major >= 1)';
const MAJOR_FORM = 'a positive integer major version';

const TOPIC = 'people.person.archived.v1';
const SUBSCRIPTION = 'timesheets.people.person.archived.v1';

const CATALOGUE_TOPICS = [
  'programs-sites.site.changed.v1',
  'identity.group.changed.v1',
  'identity.permission.changed.v1',
  'identity.membership.changed.v1',
  'identity.login-mail.requested.v1',
  'people.person.changed.v1',
  'people.person.archived.v1',
  'surveys.survey.scheduled.v1',
  'communications.message.delivery-status-changed.v1',
  'stub.note.created.v1',
];

const INVALID_TOPICS: ReadonlyArray<readonly [string, string]> = [
  ['an empty string', ''],
  ['a missing major', 'people.person.archived'],
  ['a major without the v prefix', 'people.person.archived.1'],
  ['major zero', 'people.person.archived.v0'],
  ['a zero-padded major', 'people.person.archived.v01'],
  ['an upper-case segment', 'People.person.archived.v1'],
  ['a segment starting with a digit', 'people.1person.archived.v1'],
  ['a segment starting with a hyphen', 'people.person.-archived.v1'],
  ['an underscore', 'people.person_record.archived.v1'],
  ['an empty segment', 'people..archived.v1'],
  ['an extra segment', 'people.person.record.archived.v1'],
  ['a dead-letter suffix', `${TOPIC}.dlq`],
  ['surrounding whitespace', ` ${TOPIC} `],
  ['a trailing newline', `${TOPIC}\n`],
];

const INVALID_SUBSCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['an empty string', ''],
  ['a name without a dot', 'timesheets'],
  ['a bare topic', TOPIC],
  ['an empty consumer', `.${TOPIC}`],
  ['an upper-case consumer', `Timesheets.${TOPIC}`],
  ['a consumer starting with a digit', `1timesheets.${TOPIC}`],
  ['a topic without a major', 'timesheets.people.person.archived'],
  ['a topic with major zero', 'timesheets.people.person.archived.v0'],
  ['a dead-letter topic', `${SUBSCRIPTION}.dlq`],
  ['a push path', `${PUSH_PATH_PREFIX}${SUBSCRIPTION}`],
  ['a trailing space', `${SUBSCRIPTION} `],
];

const TOPIC_HELPERS: ReadonlyArray<readonly [string, (topic: string) => unknown]> = [
  ['parseTopic', parseTopic],
  ['eventTypeOf', eventTypeOf],
  ['schemaVersionOf', schemaVersionOf],
  ['topicSchemaRelativePath', topicSchemaRelativePath],
  ['subscriptionName', (topic) => subscriptionName('timesheets', topic)],
];

const SUBSCRIPTION_HELPERS: ReadonlyArray<readonly [string, (subscription: string) => string]> = [
  ['consumerOfSubscription', consumerOfSubscription],
  ['topicOfSubscription', topicOfSubscription],
  ['pushPath', pushPath],
  ['dlqTopicName', dlqTopicName],
  ['dlqReplaySubscriptionName', dlqReplaySubscriptionName],
];

/** Asserts that `fn` throws an InvalidEventNameError quoting `value` and naming the `expected` form. */
function expectNameError(fn: () => unknown, value: string, expected: string): void {
  expect(fn).toThrow(InvalidEventNameError);
  expect(fn).toThrow(`Invalid event name "${value}": expected ${expected}`);
}

describe('InvalidEventNameError', () => {
  it('is a named Error quoting the value and the expected form', () => {
    const error = new InvalidEventNameError('Bad.Name', 'a form');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidEventNameError');
    expect(error.message).toBe('Invalid event name "Bad.Name": expected a form');
  });
});

describe('topicName', () => {
  it('defaults the major version to 1', () => {
    expect(topicName('people', 'person', 'archived')).toBe(TOPIC);
  });

  it('appends an explicit major version', () => {
    expect(topicName('surveys', 'survey', 'scheduled', 2)).toBe('surveys.survey.scheduled.v2');
  });

  it.each([
    { service: 'People', entity: 'person', event: 'archived', bad: 'People' },
    { service: '', entity: 'person', event: 'archived', bad: '' },
    { service: 'people', entity: 'person_record', event: 'archived', bad: 'person_record' },
    { service: 'people', entity: '1person', event: 'archived', bad: '1person' },
    { service: 'people', entity: 'person', event: 'archived.v1', bad: 'archived.v1' },
    { service: 'people', entity: 'person', event: '-archived', bad: '-archived' },
  ])('rejects segment "$bad"', ({ service, entity, event, bad }) => {
    expectNameError(() => topicName(service, entity, event), bad, SEGMENT_FORM);
  });

  it('rejects a non-string segment', () => {
    expectNameError(() => topicName('people', null as unknown as string, 'archived'), 'null', SEGMENT_FORM);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects major %s',
    (major) => {
      expectNameError(() => topicName('people', 'person', 'archived', major), String(major), MAJOR_FORM);
    },
  );
});

describe('parseTopic', () => {
  it('splits a topic into its segments and numeric major', () => {
    expect(parseTopic('communications.message.delivery-status-changed.v12')).toEqual({
      service: 'communications',
      entity: 'message',
      event: 'delivery-status-changed',
      major: 12,
    });
  });

  it.each(CATALOGUE_TOPICS)('round-trips %s through topicName', (topic) => {
    const { service, entity, event, major } = parseTopic(topic);
    expect(topicName(service, entity, event, major)).toBe(topic);
  });
});

describe.each(TOPIC_HELPERS)('%s', (_helperName, helper) => {
  it.each(INVALID_TOPICS)('rejects %s', (_label, topic) => {
    expectNameError(() => helper(topic), topic, TOPIC_FORM);
  });
});

describe('isTopicName', () => {
  it.each(CATALOGUE_TOPICS)('accepts %s', (topic) => {
    expect(isTopicName(topic)).toBe(true);
  });

  it.each<readonly [string, unknown]>([
    ...INVALID_TOPICS,
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['an object', {}],
    ['an array holding a topic', [TOPIC]],
  ])('rejects %s', (_label, value) => {
    expect(isTopicName(value)).toBe(false);
  });
});

describe('topic-derived names', () => {
  it.each([
    [
      'people.person.archived.v1',
      'people.person.archived',
      '1.0.0',
      'services/people/contracts/events/people.person.archived.v1.json',
    ],
    [
      'programs-sites.site.changed.v1',
      'programs-sites.site.changed',
      '1.0.0',
      'services/programs-sites/contracts/events/programs-sites.site.changed.v1.json',
    ],
    [
      'communications.message.delivery-status-changed.v1',
      'communications.message.delivery-status-changed',
      '1.0.0',
      'services/communications/contracts/events/communications.message.delivery-status-changed.v1.json',
    ],
    [
      'surveys.survey.scheduled.v12',
      'surveys.survey.scheduled',
      '12.0.0',
      'services/surveys/contracts/events/surveys.survey.scheduled.v12.json',
    ],
  ])('derives the event type, schema version and schema path of %s', (topic, eventType, schemaVersion, schemaPath) => {
    expect(eventTypeOf(topic)).toBe(eventType);
    expect(schemaVersionOf(topic)).toBe(schemaVersion);
    expect(topicSchemaRelativePath(topic)).toBe(schemaPath);
  });
});

describe('subscriptionName', () => {
  it('prefixes the topic with the consumer service', () => {
    expect(subscriptionName('timesheets', TOPIC)).toBe(SUBSCRIPTION);
  });

  it.each(['Timesheets', '', '1timesheets', 'time_sheets', 'timesheets.people'])('rejects consumer "%s"', (consumer) => {
    expectNameError(() => subscriptionName(consumer, TOPIC), consumer, SEGMENT_FORM);
  });
});

describe('subscription parts', () => {
  it.each([
    ['timesheets', 'people.person.archived.v1'],
    ['strategies-content', 'identity.group.changed.v1'],
    ['communications', 'surveys.survey.scheduled.v2'],
  ])('splits the %s subscription to %s at its first dot', (consumer, topic) => {
    const subscription = subscriptionName(consumer, topic);
    expect(consumerOfSubscription(subscription)).toBe(consumer);
    expect(topicOfSubscription(subscription)).toBe(topic);
  });
});

describe('delivery and dead-letter names', () => {
  it('mounts the push route under /internal/v1/events/', () => {
    expect(PUSH_PATH_PREFIX).toBe('/internal/v1/events/');
    expect(pushPath(SUBSCRIPTION)).toBe('/internal/v1/events/timesheets.people.person.archived.v1');
  });

  it('names the dead-letter topic <subscription>.dlq', () => {
    expect(dlqTopicName(SUBSCRIPTION)).toBe('timesheets.people.person.archived.v1.dlq');
  });

  it('names the replay pull subscription <subscription>.dlq.replay', () => {
    expect(dlqReplaySubscriptionName(SUBSCRIPTION)).toBe('timesheets.people.person.archived.v1.dlq.replay');
  });
});

describe.each(SUBSCRIPTION_HELPERS)('%s', (_helperName, helper) => {
  it.each(INVALID_SUBSCRIPTIONS)('rejects %s', (_label, subscription) => {
    expectNameError(() => helper(subscription), subscription, SUBSCRIPTION_FORM);
  });
});
