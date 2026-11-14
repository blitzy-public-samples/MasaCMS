/** People's task service and outbox-sweep queue names. */
import { describe, expect, it } from 'vitest';
import { outboxSweepQueue } from '@opt2/platform/tasks';
import { PEOPLE_SERVICE, PEOPLE_SWEEP_QUEUE } from '../../src/tasks/port.js';

describe('people task queues', () => {
  it('registers under the people service and its outbox-sweep queue', () => {
    expect(PEOPLE_SERVICE).toBe('people');
    expect(PEOPLE_SWEEP_QUEUE).toBe('people-outbox-sweep');
    expect(PEOPLE_SWEEP_QUEUE).toBe(outboxSweepQueue('people'));
  });
});
