// The liveness route: segment config and its unauthenticated `{ status: 'ok' }` answer.
import { describe, expect, it } from 'vitest';
import * as healthz from '../../app/healthz/route';

describe('healthz route', () => {
  it('renders dynamically on the Node.js runtime', () => {
    expect(healthz.dynamic).toBe('force-dynamic');
    expect(healthz.runtime).toBe('nodejs');
  });

  it('GET answers 200 with a JSON { status: ok } body', async () => {
    const response = healthz.GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json\b/);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
