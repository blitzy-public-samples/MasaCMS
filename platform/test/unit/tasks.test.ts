import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY,
  QUEUES,
  RECURRING_RETRY,
  SITEMONITOR_DEADLINE_S,
  SITEMONITOR_INTERVAL_S,
  SITEMONITOR_QUEUE,
  UnknownQueueError,
  UnknownTaskTargetError,
  isQueueName,
  outboxSweepQueue,
  queueDefinition,
  queueTopology,
  queuesCreatedBy,
  recurringQueues,
  retryDelayS,
  targetUrl,
  type QueueTopologyEntry,
  type RetryPolicy,
} from '../../src/tasks/queues.js';

const SURVEY_ID = 'A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6';

const SERVICE_URLS: Readonly<Record<string, string>> = {
  surveys: 'http://127.0.0.1:8117',
  people: 'http://127.0.0.1:8112/',
  reporting: 'https://reporting-abc.a.run.app//',
};

const ONE_OFF_RETRY: RetryPolicy = { maxAttempts: 100, minBackoffS: 1, maxBackoffS: 300, maxDoublings: 5 };

const CHAIN_RETRY: RetryPolicy = { maxAttempts: 5, minBackoffS: 1, maxBackoffS: 60, maxDoublings: 4 };

function sweep(service: string): QueueTopologyEntry {
  return {
    name: `${service}-outbox-sweep`,
    targetService: service,
    targetPath: '/internal/v1/outbox/sweep',
    creators: [service],
    intervalS: 60,
    deadlineS: 60,
    retry: CHAIN_RETRY,
  };
}

const CLOUD_TOPOLOGY: readonly QueueTopologyEntry[] = [
  {
    name: 'surveys-launch',
    targetService: 'surveys',
    targetPath: '/internal/v1/tasks/surveys/{surveyId}/launch',
    creators: ['communications'],
    deadlineS: 60,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'communications-reminders',
    targetService: 'communications',
    targetPath: '/internal/v1/tasks/reminders/{scheduledTaskId}',
    creators: ['communications'],
    deadlineS: 60,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'content-scheduled-publish',
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/publish-scheduled-changesets',
    creators: ['programs-sites', 'strategies-content'],
    deadlineS: 300,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'content-feed-import',
    targetService: 'strategies-content',
    targetPath: '/internal/v1/jobs/feed-auto-import',
    creators: ['programs-sites'],
    deadlineS: 600,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'reporting-export-run',
    targetService: 'reporting',
    targetPath: '/internal/v1/tasks/exports/{exportId}/run',
    creators: ['reporting'],
    deadlineS: 1800,
    retry: ONE_OFF_RETRY,
  },
  {
    name: 'programs-sites-sitemonitor',
    targetService: 'programs-sites',
    targetPath: '/internal/v1/jobs/sitemonitor',
    creators: ['programs-sites'],
    intervalS: 900,
    deadlineS: 600,
    retry: CHAIN_RETRY,
  },
  sweep('identity'),
  sweep('people'),
  sweep('programs-sites'),
  sweep('surveys'),
  sweep('communications'),
];

const DEPLOYED_SWEEPS = [
  'identity-outbox-sweep',
  'people-outbox-sweep',
  'programs-sites-outbox-sweep',
  'surveys-outbox-sweep',
  'communications-outbox-sweep',
];

/** Returns what `fn` throws, failing the test when it returns normally. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('retry policies', () => {
  it.each([
    ['one-off tasks', DEFAULT_RETRY, ONE_OFF_RETRY],
    ['recurring chains', RECURRING_RETRY, CHAIN_RETRY],
  ])('fixes and freezes the retry policy of %s', (_label, policy, expected) => {
    expect(policy).toStrictEqual(expected);
    expect(Object.isFrozen(policy)).toBe(true);
  });
});

describe('outboxSweepQueue', () => {
  it.each(['identity', 'programs-sites', 'stub'])('names the sweep queue of %s', (service) => {
    expect(outboxSweepQueue(service)).toBe(`${service}-outbox-sweep`);
  });
});

describe('QUEUES', () => {
  it('runs the site monitor every 900 s with a 600 s deadline', () => {
    expect([SITEMONITOR_QUEUE, SITEMONITOR_INTERVAL_S, SITEMONITOR_DEADLINE_S]).toStrictEqual([
      'programs-sites-sitemonitor',
      900,
      600,
    ]);
    expect(QUEUES[SITEMONITOR_QUEUE].recurring).toStrictEqual({ intervalS: 900 });
    expect(QUEUES[SITEMONITOR_QUEUE].deadlineS).toBe(600);
  });

  it('keys every definition by its own name', () => {
    for (const [key, def] of Object.entries(QUEUES)) expect(def.name).toBe(key);
  });

  it('marks only the stub sweep local-only', () => {
    const localOnly = Object.values(QUEUES).filter((def) => def.localOnly === true);
    expect(localOnly.map((def) => def.name)).toStrictEqual(['stub-outbox-sweep']);
  });

  it('freezes the registry, its definitions, creators and cadence', () => {
    expect(Object.isFrozen(QUEUES)).toBe(true);
    for (const def of Object.values(QUEUES)) {
      expect(Object.isFrozen(def)).toBe(true);
      expect(Object.isFrozen(def.creators)).toBe(true);
      expect(Object.isFrozen(def.retry)).toBe(true);
      if (def.recurring) expect(Object.isFrozen(def.recurring)).toBe(true);
    }
  });

  it('keeps every dispatch deadline within the 15–1800 s HTTP-target range', () => {
    for (const def of Object.values(QUEUES)) {
      expect(def.deadlineS).toBeGreaterThanOrEqual(15);
      expect(def.deadlineS).toBeLessThanOrEqual(1800);
    }
  });

  it('targets only managed Cloud Tasks routes', () => {
    for (const def of Object.values(QUEUES)) {
      expect(def.targetPath).toMatch(/^\/internal\/v1\/(?:tasks\/|jobs\/|outbox\/sweep$)/);
    }
  });

  it('uses the recurring retry policy exactly on recurring queues', () => {
    for (const def of Object.values(QUEUES)) {
      expect(def.retry).toBe(def.recurring ? RECURRING_RETRY : DEFAULT_RETRY);
    }
  });
});

describe('isQueueName', () => {
  it.each(['surveys-launch', 'programs-sites-sitemonitor', 'communications-outbox-sweep', 'stub-outbox-sweep'])(
    'accepts %s',
    (name) => {
      expect(isQueueName(name)).toBe(true);
    },
  );

  it.each(['', 'SURVEYS-LAUNCH', ' surveys-launch', 'finance-outbox-sweep', 'toString', '__proto__', 'hasOwnProperty'])(
    'rejects %j',
    (name) => {
      expect(isQueueName(name)).toBe(false);
    },
  );
});

describe('queueDefinition', () => {
  it('returns the registry entry', () => {
    expect(queueDefinition('surveys-launch')).toBe(QUEUES['surveys-launch']);
    expect(queueDefinition('surveys-launch').targetPath).toBe('/internal/v1/tasks/surveys/{surveyId}/launch');
  });

  it.each(['unknown-queue', 'toString', ''])('throws UnknownQueueError for %j', (name) => {
    const error = thrownBy(() => queueDefinition(name));
    expect(error).toBeInstanceOf(UnknownQueueError);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'UnknownQueueError', queue: name, message: `Unknown task queue: ${name}` });
  });
});

describe('recurringQueues', () => {
  it.each([
    { label: 'by default', opts: undefined, expected: DEPLOYED_SWEEPS },
    { label: 'with local-only queues', opts: { includeLocalOnly: true }, expected: [...DEPLOYED_SWEEPS, 'stub-outbox-sweep'] },
    { label: 'with the site monitor', opts: { withSiteMonitor: true }, expected: [SITEMONITOR_QUEUE, ...DEPLOYED_SWEEPS] },
    {
      label: 'with both',
      opts: { includeLocalOnly: true, withSiteMonitor: true },
      expected: [SITEMONITOR_QUEUE, ...DEPLOYED_SWEEPS, 'stub-outbox-sweep'],
    },
    {
      label: 'with both options false',
      opts: { includeLocalOnly: false, withSiteMonitor: false },
      expected: DEPLOYED_SWEEPS,
    },
  ])('lists recurring queues in registry order $label', ({ opts, expected }) => {
    expect(recurringQueues(opts).map((def) => def.name)).toStrictEqual(expected);
  });
});

describe('queuesCreatedBy', () => {
  it.each([
    ['communications', ['surveys-launch', 'communications-reminders', 'communications-outbox-sweep']],
    [
      'programs-sites',
      ['content-scheduled-publish', 'content-feed-import', 'programs-sites-sitemonitor', 'programs-sites-outbox-sweep'],
    ],
    ['strategies-content', ['content-scheduled-publish']],
    ['reporting', ['reporting-export-run']],
    ['surveys', ['surveys-outbox-sweep']],
    ['identity', ['identity-outbox-sweep']],
    ['people', ['people-outbox-sweep']],
    ['stub', ['stub-outbox-sweep']],
    ['finance', []],
    ['', []],
  ])('lists the queues %j creates tasks on', (service, expected) => {
    expect(queuesCreatedBy(service).map((def) => def.name)).toStrictEqual(expected);
  });
});

describe('targetUrl', () => {
  it.each([
    [
      'fills the survey launch path parameter',
      'surveys-launch',
      { surveyId: SURVEY_ID },
      `http://127.0.0.1:8117/internal/v1/tasks/surveys/${SURVEY_ID}/launch`,
    ],
    [
      'URI-encodes parameter values',
      'surveys-launch',
      { surveyId: 'a/b c?d#é' },
      'http://127.0.0.1:8117/internal/v1/tasks/surveys/a%2Fb%20c%3Fd%23%C3%A9/launch',
    ],
    [
      'strips one trailing slash from the base URL',
      'people-outbox-sweep',
      {},
      'http://127.0.0.1:8112/internal/v1/outbox/sweep',
    ],
    [
      'strips repeated trailing slashes from the base URL',
      'reporting-export-run',
      { exportId: 'E1' },
      'https://reporting-abc.a.run.app/internal/v1/tasks/exports/E1/run',
    ],
    [
      'ignores parameters the route does not name',
      'people-outbox-sweep',
      { surveyId: SURVEY_ID },
      'http://127.0.0.1:8112/internal/v1/outbox/sweep',
    ],
  ])('%s', (_label, queue, params, expected) => {
    expect(targetUrl(queueDefinition(queue), SERVICE_URLS, params)).toBe(expected);
  });

  it.each([
    ['absent', {}],
    ['empty', { surveys: '' }],
  ])('throws UnknownTaskTargetError when the target base URL is %s', (_label, serviceUrls) => {
    const error = thrownBy(() => targetUrl(QUEUES['surveys-launch'], serviceUrls, { surveyId: SURVEY_ID }));
    expect(error).toBeInstanceOf(UnknownTaskTargetError);
    expect(error).toMatchObject({
      name: 'UnknownTaskTargetError',
      service: 'surveys',
      message: 'No URL configured for task target service: surveys',
    });
  });

  it('throws TypeError for a missing path parameter', () => {
    const error = thrownBy(() => targetUrl(QUEUES['surveys-launch'], SERVICE_URLS));
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({ message: 'Missing path parameter "surveyId" for queue surveys-launch' });
  });
});

describe('retryDelayS', () => {
  it.each([
    [-3, 1],
    [0, 1],
    [1, 1],
    [2, 2],
    [3, 4],
    [6, 32],
    [7, 64],
    [8, 96],
    [14, 288],
    [15, 300],
    [20, 300],
    [100, 300],
  ])('after one-off attempt %i waits %i s', (attempt, delay) => {
    expect(retryDelayS(DEFAULT_RETRY, attempt)).toBe(delay);
  });

  it.each([
    [
      'the Cloud Tasks documentation example',
      { maxAttempts: -1, minBackoffS: 10, maxBackoffS: 300, maxDoublings: 3 },
      [10, 20, 40, 80, 160, 240, 300, 300],
    ],
    ['recurring chains', RECURRING_RETRY, [1, 2, 4, 8, 16, 32, 48, 60, 60]],
    ['no doublings', { maxAttempts: 10, minBackoffS: 5, maxBackoffS: 20, maxDoublings: 0 }, [5, 10, 15, 20, 20]],
  ] as const)('follows the backoff sequence of %s', (_label, policy, expected) => {
    expect(Array.from({ length: expected.length }, (_, i) => retryDelayS(policy, i + 1))).toStrictEqual(expected);
  });
});

describe('queueTopology', () => {
  it.each([
    ['cloud', 'omits the local-only stub sweep', CLOUD_TOPOLOGY],
    ['local', 'ends with the local-only stub sweep', [...CLOUD_TOPOLOGY, sweep('stub')]],
  ] as const)('lists the %s queues in registry order and %s', (target, _label, expected) => {
    expect(queueTopology({ target })).toStrictEqual(expected);
  });

  it('sets intervalS only on recurring queues', () => {
    for (const entry of queueTopology({ target: 'local' })) {
      expect(Object.hasOwn(entry, 'intervalS')).toBe(queueDefinition(entry.name).recurring !== undefined);
    }
  });

  it('round-trips through JSON unchanged', () => {
    const topology = queueTopology({ target: 'local' });
    expect(JSON.parse(JSON.stringify(topology))).toStrictEqual(topology);
  });

  it('returns copies that leave the registry unchanged when mutated', () => {
    for (const entry of queueTopology({ target: 'cloud' })) {
      entry.creators.push('finance');
      entry.retry.maxAttempts = 0;
    }
    expect(queueTopology({ target: 'cloud' })).toStrictEqual(CLOUD_TOPOLOGY);
    expect(DEFAULT_RETRY.maxAttempts).toBe(100);
    expect(RECURRING_RETRY.maxAttempts).toBe(5);
  });
});
