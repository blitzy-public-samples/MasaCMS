import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isUnstorableTextError } from '../../src/service-kit/index.js';
import { createPool, type TenantDb } from '../../src/tenancy/index.js';
import { pgAvailable, testPgConfig } from '../../src/testing/index.js';

const NUL_TEXT = 'a\u0000b';

describe('isUnstorableTextError against the errors PostgreSQL raises', () => {
  let db: TenantDb | undefined;

  beforeAll(async () => {
    if (!(await pgAvailable())) {
      const { host, port } = testPgConfig();
      throw new Error(`The unstorable-text suite needs a PostgreSQL server at PG_HOST:PG_PORT ${host}:${String(port)}, which is unreachable`);
    }
    const { host, port, user, password, database } = testPgConfig();
    db = await createPool({
      env: { OPT2_DB_AUTH: 'password', PG_HOST: host, PG_PORT: port, PG_DATABASE: database, PG_USER: user, PG_PASSWORD: password },
      schema: 'unstorable_text',
      max: 1,
    });
  });

  afterAll(async () => {
    await db?.end();
  });

  it.each<[string, string, boolean, string, unknown[]]>([
    ['a NUL bound as text', '22021', true, 'SELECT $1::text', [NUL_TEXT]],
    ['a NUL in a jsonb string', '22P05', true, 'SELECT $1::jsonb', [{ title: NUL_TEXT }]],
    ['a NUL in a jsonb key', '22P05', true, 'SELECT $1::jsonb', [{ [NUL_TEXT]: 1 }]],
    ['a NUL read from json as text', '22P05', true, "SELECT ($1::json)->>'title'", [JSON.stringify({ title: NUL_TEXT })]],
    ['a character LATIN1 cannot encode', '22P05', false, "SELECT convert_to($1, 'LATIN1')", ['\u20AC']],
    ['a lone surrogate escape in jsonb', '22P02', false, 'SELECT $1::jsonb', ['{"title":"\\ud800"}']],
    ['a smallint out of range', '22003', false, 'SELECT $1::int2', ['70000']],
  ])('reads %s (%s) as unstorable: %s', async (_label, code, expected, sql, params) => {
    const refused: unknown = await db?.withMetadata((tx) => tx.query(sql, params)).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refused).toMatchObject({ code, severity: 'ERROR' });
    expect(isUnstorableTextError(refused)).toBe(expected);
  });
});
