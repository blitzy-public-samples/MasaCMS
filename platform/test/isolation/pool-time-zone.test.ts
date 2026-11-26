import { beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { localTimestamp } from '../../src/outbox/index.js';
import { createPool } from '../../src/tenancy/index.js';
import { pgAvailable, testPgConfig } from '../../src/testing/index.js';

const SESSION_CLOCK_SQL =
  "SELECT current_setting('TimeZone') AS zone, extract(epoch FROM LOCALTIMESTAMP(3) - $1::timestamp(3))::float8 AS drift";

describe('createPool session time zone against PostgreSQL', () => {
  beforeAll(async () => {
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`The pool time-zone suite needs a PostgreSQL server at PG_HOST:PG_PORT ${host}:${String(port)}, which is unreachable`);
    }
  });

  it.each([
    ['America/New_York', ['America/New_York']],
    ['Asia/Kolkata', ['Asia/Kolkata']],
    // A legacy alias: a cluster whose tzdata lacks it gets ICU's id instead.
    ['US/Eastern', ['US/Eastern', 'America/New_York']],
  ])('evaluates LOCALTIMESTAMP(3) under TZ %s in the session zone %j, as localTimestamp() does', async (tz, zones) => {
    vi.stubEnv('TZ', tz);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const { host, port, user, password, database } = testPgConfig();
    const db = await createPool({
      env: { OPT2_DB_AUTH: 'password', PG_HOST: host, PG_PORT: port, PG_DATABASE: database, PG_USER: user, PG_PASSWORD: password },
      schema: 'pool_time_zone',
      max: 1,
    });
    onTestFinished(() => db.end());

    const row = await db.withMetadata(async (tx) => {
      const { rows } = await tx.query<{ zone: string; drift: number }>(SESSION_CLOCK_SQL, [localTimestamp(new Date())]);
      return rows[0];
    });

    expect(zones).toContain(row?.zone);
    expect(Math.abs(row?.drift ?? Number.POSITIVE_INFINITY)).toBeLessThan(1);
  });
});
