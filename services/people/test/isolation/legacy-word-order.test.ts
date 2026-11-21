/** The 0012_person_word_order.sql keys and person paging against text-order.ts and the SQL Server-captured fixture. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeGates, ensureUnitGates, openGates } from '@opt2/platform/migration-kit';
import { TENANT_A, createThrowawaySchema, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import { legacyWordSpecial, legacyWordText } from '../../src/domain/text-order.js';
import {
  LEGACY_WORD_SPECIAL_FUNCTION,
  LEGACY_WORD_TEXT_FUNCTION,
  PERSON_LAST_NAME_ORDER,
  PERSON_NAME_ORDER,
  createPeopleRepository,
  type PersonCursor,
  type PersonSortKey,
} from '../../src/repo/repository.js';
import { PEOPLE_UNITS } from '../../src/repo/tables.js';
import { FIXTURE, codes, nameRank, rank } from '../helpers/legacy-word-order.js';

const available = await pgAvailable();

describe.skipIf(!available)('0012_person_word_order.sql against text-order.ts', () => {
  let handle: ThrowawaySchema;
  const site = 'word-order';
  const namesSite = 'word-names';

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'legacy-word-order-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'legacy-word-order-test', state: 'open' });
    const userid = (prefix: string, index: number): string => `${prefix}${String(index).padStart(7, '0')}-0000-0000-0000000000000000`;
    await handle.app.withTenant(TENANT_A.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO "${handle.schema}".person (tenant_id, userid, siteid, lname) SELECT $1::uuid, u.userid, $2, u.lname FROM unnest($3::text[], $4::text[]) AS u(userid, lname)`,
        [TENANT_A.tenantId, site, FIXTURE.corpus.map((_, index) => userid('W', index)), FIXTURE.corpus],
      );
      await tx.query(
        `INSERT INTO "${handle.schema}".person (tenant_id, userid, siteid, lname, fname)` +
          ' SELECT $1::uuid, u.userid, $2, u.lname, u.fname FROM unnest($3::text[], $4::text[], $5::text[]) AS u(userid, lname, fname)',
        [TENANT_A.tenantId, namesSite, FIXTURE.names.map((_, index) => userid('N', index)), FIXTURE.names.map(([lname]) => lname), FIXTURE.names.map(([, fname]) => fname)],
      );
    });
  });

  afterAll(async () => {
    await handle?.drop();
  });

  /** Every BMP code point but U+0000 and the surrogates, and supplementary ones with a compatibility decomposition or on a stride, before a hyphen and a trailing space. */
  function codePointSamples(): string[] {
    const samples: string[] = [];
    for (let codePoint = 1; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const char = String.fromCodePoint(codePoint);
      if (codePoint > 0xffff && codePoint % 0x101 !== 0 && char.normalize('NFKD') === char) continue;
      samples.push(`a${char}-b`, `${char} `);
    }
    return samples;
  }

  it('computes both keys of every corpus value and code point sample exactly as text-order.ts does', async () => {
    const values = [...FIXTURE.corpus, ...codePointSamples()];
    const { rows } = await handle.appPool.query<{ text: string; special: string }>(
      `SELECT "${handle.schema}".${LEGACY_WORD_TEXT_FUNCTION}(v) AS text, "${handle.schema}".${LEGACY_WORD_SPECIAL_FUNCTION}(v) AS special` +
        ' FROM unnest($1::text[]) WITH ORDINALITY AS u(v, n) ORDER BY n',
      [values],
    );
    const wrong = values.filter((value, index) => rows[index]?.text !== legacyWordText(value) || rows[index]?.special !== legacyWordSpecial(value));
    expect(wrong.map(codes)).toEqual([]);
    expect(rows).toHaveLength(values.length);
  });

  it.each<[string, readonly PersonSortKey[], 1 | -1]>([
    ['ascending', PERSON_LAST_NAME_ORDER, 1],
    ['descending', [{ column: 'lname', descending: true }], -1],
  ])('pages persons by last name %s in SQL Server order', async (_label, orderBy, direction) => {
    const repo = createPeopleRepository({ schema: handle.schema });
    const ranks: number[] = [];
    let after: PersonCursor | null = null;
    do {
      const page = await handle.app.withTenant(TENANT_A.tenantId, (tx) => repo.pagePersonsInOrder(tx, { siteIds: [site] }, { orderBy, after, limit: 97 }));
      ranks.push(...page.rows.map((row) => rank(row.lname ?? '')));
      after = page.next;
    } while (after !== null);
    expect(ranks).toHaveLength(FIXTURE.corpus.length);
    expect(ranks.filter((value, index) => index > 0 && (value - (ranks[index - 1] as number)) * direction < 0)).toEqual([]);
  });

  it('pages persons by last then first name in SQL Server order', async () => {
    const repo = createPeopleRepository({ schema: handle.schema });
    const ranks: number[] = [];
    let after: PersonCursor | null = null;
    do {
      const page = await handle.app.withTenant(TENANT_A.tenantId, (tx) =>
        repo.pagePersonsInOrder(tx, { siteIds: [namesSite] }, { orderBy: PERSON_NAME_ORDER, after, limit: 13 }),
      );
      ranks.push(...page.rows.map((row) => nameRank([row.lname, row.fname])));
      after = page.next;
    } while (after !== null);
    expect(ranks).toHaveLength(FIXTURE.names.length);
    expect(ranks.filter((value, index) => index > 0 && value < (ranks[index - 1] as number))).toEqual([]);
  });
});
