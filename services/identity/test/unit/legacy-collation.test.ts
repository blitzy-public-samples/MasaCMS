/** The legacy_ci and legacy_char_ci collations of the identity migrations against the SQL Server SQL_Latin1_General_CP1_CI_AS equality recorded in the fixture. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';

interface LegacyEquality {
  classes: string[][];
  expansions: [string, string][];
  ignorables: string[];
}

interface LegacyCollationFixture {
  domain: number[];
  expansionCandidates: [string, string][];
  legacy_ci: LegacyEquality;
  legacy_char_ci: LegacyEquality;
}

const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/legacy-collation.json', import.meta.url), 'utf8')) as LegacyCollationFixture;
const DOMAIN = FIXTURE.domain.map((cp) => String.fromCodePoint(cp));
const ALNUM = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'];
const ALNUM_PAIRS = ALNUM.flatMap((a) => ALNUM.map((b) => a + b));
const COLLATIONS = ['legacy_ci', 'legacy_char_ci'] as const;

/** The code points of `s`, so a failure names invisible characters. */
function codes(s: string): string {
  return [...s].map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');
}

function pairKey(a: string, b: string): string {
  return `${codes(a)} = ${codes(b)}`;
}

const available = await pgAvailable();

describe.skipIf(!available)('identity legacy collations against SQL Server equality', () => {
  let handle: ThrowawaySchema;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'identity', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  async function equalPairs(sql: string, params: unknown[]): Promise<string[]> {
    return (await handle.appPool.query<{ a: string; b: string }>(sql, params)).rows.map((row) => pairKey(row.a, row.b)).sort();
  }

  it.each(COLLATIONS)('%s equates two domain characters exactly when SQL Server puts them in one class', async (collation) => {
    const expected = FIXTURE[collation].classes.flatMap((members) => members.flatMap((a, i) => members.slice(i + 1).map((b) => pairKey(a, b))));
    const actual = await equalPairs(
      `SELECT x.c AS a, y.c AS b FROM unnest($1::text[]) WITH ORDINALITY x(c, i) JOIN unnest($1::text[]) WITH ORDINALITY y(c, j)` +
        ` ON x.i < y.j AND (x.c::bpchar COLLATE ${handle.schema}.${collation}) = y.c::bpchar`,
      [DOMAIN],
    );
    expect(actual).toEqual(expected.sort());
  });

  it.each(COLLATIONS)('%s ignores exactly the domain characters SQL Server ignores', async (collation) => {
    const { rows } = await handle.appPool.query<{ c: string }>(
      `SELECT c FROM unnest($1::text[]) c WHERE (('a' || c || 'b')::bpchar COLLATE ${handle.schema}.${collation}) = 'ab'::bpchar`,
      [DOMAIN],
    );
    expect(rows.map((row) => codes(row.c)).sort()).toEqual(FIXTURE[collation].ignorables.map(codes).sort());
  });

  it.each(COLLATIONS)('%s expands a domain character into a candidate string exactly where SQL Server does', async (collation) => {
    const actual = await equalPairs(
      `SELECT c AS a, s AS b FROM unnest($1::text[]) c CROSS JOIN unnest($2::text[]) s WHERE (c::bpchar COLLATE ${handle.schema}.${collation}) = s::bpchar` +
        ` UNION ALL SELECT c, s FROM unnest($3::text[], $4::text[]) p(c, s) WHERE (c::bpchar COLLATE ${handle.schema}.${collation}) = s::bpchar`,
      [DOMAIN, ALNUM_PAIRS, FIXTURE.expansionCandidates.map(([c]) => c), FIXTURE.expansionCandidates.map(([, s]) => s)],
    );
    expect(actual).toEqual(FIXTURE[collation].expansions.map(([c, s]) => pairKey(c, s)).sort());
  });
});
