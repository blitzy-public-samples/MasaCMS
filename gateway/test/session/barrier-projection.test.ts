// The composed gateway's session barrier under v0001: a stub exchange arms nothing, so the session's legacy-bound requests reach legacy.
import { afterEach, describe, expect, it } from 'vitest';
import { startGatewayHarness, type GatewayHarness } from '../helpers/gateway-app.js';

const LEGACY_READS = ['/admin/?muraAction=cDashboard.main', '/'];

let h: GatewayHarness | undefined;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('the composed session barrier under v0001', () => {
  it.each(['POST', 'GET'] as const)(
    "stores nothing for a stub %s, so the session's admin and home pages reach legacy without asking migration",
    async (method) => {
      const gateway = await startGatewayHarness({ activate: ['v0001'] });
      h = gateway;
      const { cookie } = gateway.legacy.openSession();
      gateway.target('stub').setWritePosition('stub=42');
      const body = method === 'POST' ? { headers: { cookie, 'content-type': 'application/json' }, payload: { title: 'qa-e2e' } } : { headers: { cookie } };
      const write = await gateway.app.inject({ method, url: '/opt2/stub/notes', ...body });
      expect(write.statusCode).toBe(200);
      expect(write.headers['x-opt2-write-position']).toBeUndefined();
      expect(gateway.target('stub').requests.map((received) => received.headers.authorization)).toEqual([expect.stringMatching(/^Bearer /)]);
      expect([...gateway.db.tables.barriers.values()]).toEqual([]);

      const pagesBefore = gateway.legacy.pages().length;
      const statuses: number[] = [];
      for (const url of LEGACY_READS) statuses.push((await gateway.app.inject({ method: 'GET', url, headers: { cookie } })).statusCode);
      expect(statuses).toEqual(LEGACY_READS.map(() => 200));
      expect(gateway.legacy.pages().slice(pagesBefore).map((received) => received.url)).toEqual(LEGACY_READS);
      expect(gateway.migration.requests).toEqual([]);
    },
  );
});
