/** Site custom image sizes: the settingsImageSizeBean ports and the domain operations against a throwaway `programs_sites` schema. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserClaims } from '@opt2/platform/auth';
import { ensureUnitGates } from '@opt2/platform/migration-kit';
import { tenantIdForSite, withMetadata, type TenantDb } from '@opt2/platform/tenancy';
import { createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  applyImageSizeSet,
  beanFromRow,
  createImageSizesDomain,
  formatImageSizeName,
  newImageSizeBean,
  toImageSize,
  type ImageSizeBean,
  type ImageSizesDomain,
} from '../../src/domain/image-sizes.js';
import { createProgramsSitesRepository, type ProgramsSitesRepository } from '../../src/repo/repository.js';
import { UNITS, type ImageSizeRow } from '../../src/repo/tables.js';

const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const SIZE_1 = 'A0000000-0000-0000-0000000000000001';
const SIZE_2 = 'B0000000-0000-0000-0000000000000002';
const SIZE_3 = 'C0000000-0000-0000-0000000000000003';

function claimsFor(site: string, tid = tenantIdForSite(site)): UserClaims {
  return { iss: 'test', aud: 'test', sub: 'U1', sid: 'S1', tid, site, roles: ['s2'], s2: true, epoch: 0, iat: 0, exp: 0 };
}

function bean(overrides: Partial<ImageSizeBean> = {}): ImageSizeBean {
  return { sizeId: SIZE_1, siteId: 'alpha', name: 'thumb', height: '100', width: 'AUTO', isNew: 0, ...overrides };
}

describe('formatImageSizeName', () => {
  it.each([
    ['Hero Banner!', 'hero-banner'],
    ['Größe Ä', 'groesse-ae'],
    ['<b>x</b>', 'x'],
    ['--a--', 'a'],
    ['Crème brûlée', 'creme-brulee'],
    ["Don't \u201Cquote\u201D", 'dont-quote'],
    ['Æsir Øl', 'aesir-ol'],
    ['ßßx', 'ssssx'],
    ['xẞßy', 'x-ssy'],
    ['GROẞ', 'gro'],
    ['Ångström Œuvre ﬁne', 'angstroem-uvre-ne'],
    ['ÜÖÄ üöä', 'ueoeae-ueoeae'],
    ['«a» \u2019b', 'a-b'],
  ])('formats %j as %j as ACF 2023 does', (name, expected) => {
    expect(formatImageSizeName(name)).toBe(expected);
  });

  it.each(['', '!!!', '<br/>'])('answers a new uppercase CF UUID for %j', (name) => {
    const formatted = formatImageSizeName(name);

    expect(formatted).toMatch(CF_UUID);
    expect(formatted).toHaveLength(35);
  });

  it('uses the configured delimiter', () => {
    expect(formatImageSizeName('a b..c', { urlTitleDelim: '.' })).toBe('a.b.c');
    expect(formatImageSizeName('_a  b_', { urlTitleDelim: '_' })).toBe('a_b');
  });

  it.each([
    ['Größe Ä', 'größe-ä'],
    ['日本 語!', '日本-語'],
    ['<i>A</i>-- b', 'a-b'],
    ['tab\there', 'tabhere'],
    ['', ''],
  ])('keeps non-ASCII letters when unicode filenames are allowed: %j as %j', (name, expected) => {
    expect(formatImageSizeName(name, { allowUnicodeInFilenames: true })).toBe(expected);
  });
});

describe('image size bean', () => {
  it('starts from the init() defaults under a fresh CF UUID', () => {
    const fresh = newImageSizeBean();

    expect(fresh).toEqual({ sizeId: expect.stringMatching(CF_UUID), siteId: '', name: '', height: 'AUTO', width: 'AUTO', isNew: 1 });
    expect(newImageSizeBean().sizeId).not.toBe(fresh.sizeId);
  });

  it('loads a stored row through the setters', () => {
    const row: ImageSizeRow = { tenant_id: 't', sizeid: SIZE_1, siteid: 'alpha', name: 'Big Thumb', height: '120', width: 'auto' };

    expect(beanFromRow(row)).toEqual({ sizeId: SIZE_1, siteId: 'alpha', name: 'big-thumb', height: '120', width: 'auto', isNew: 0 });
  });

  it('lists a stored CF UUID name lower-cased, as setName reformats it on load', () => {
    const row: ImageSizeRow = { tenant_id: 't', sizeid: SIZE_1, siteid: 'alpha', name: 'F4100E45-9F67-DAEB-AE4649900BA5352A', height: 'AUTO', width: 'AUTO' };

    expect(beanFromRow(row).name).toBe('f4100e45-9f67-daeb-ae4649900ba5352a');
  });

  it('reads NULL and invalid stored values as legacy does', () => {
    const loaded = beanFromRow({ tenant_id: 't', sizeid: SIZE_1, siteid: null, name: null, height: 'abc', width: null });

    expect(loaded).toMatchObject({ sizeId: SIZE_1, siteId: '', height: 'AUTO', width: 'AUTO', isNew: 0 });
    expect(loaded.name).toMatch(CF_UUID);
  });

  it.each([
    ['200', '200'],
    ['auto', 'auto'],
    ['AUTO', 'AUTO'],
    [' 12 ', ' 12 '],
    [300, '300'],
    ['1e3', '1e3'],
    ['-5', '-5'],
    ['0x10', '100'],
    ['abc', '100'],
    ['', '100'],
  ])('sets height %j as %j', (value, expected) => {
    expect(applyImageSizeSet(bean(), { height: value }).height).toBe(expected);
    expect(applyImageSizeSet(bean({ width: '100' }), { width: value }).width).toBe(expected);
  });

  it('sets the present keys case-insensitively, trims ids and leaves the input bean unchanged', () => {
    const before = bean();
    const after = applyImageSizeSet(before, { SizeID: ` ${SIZE_2} `, SITEID: ' beta ', Name: 'New Name', other: 'x' });

    expect(after).toEqual({ ...before, sizeId: SIZE_2, siteId: 'beta', name: 'new-name' });
    expect(before).toEqual(bean());
  });

  it('skips an empty sizeid and NULL values, and turns an empty name into a CF UUID', () => {
    const after = applyImageSizeSet(bean(), { sizeid: '', siteid: null, height: undefined, name: '' });

    expect(after).toMatchObject({ sizeId: SIZE_1, siteId: 'alpha', height: '100' });
    expect(after.name).toMatch(CF_UUID);
  });

  it('maps to the contract field names', () => {
    expect(toImageSize(bean())).toEqual({ sizeID: SIZE_1, siteID: 'alpha', name: 'thumb', height: '100', width: 'AUTO', isNew: 0 });
  });
});

describe('image sizes domain without a database', () => {
  function untouchedDb(): TenantDb {
    const fail = vi.fn(() => Promise.reject(new Error('database used')));
    return { schema: 'programs_sites', withTenant: fail, withMetadata: fail, end: fail };
  }

  const domain = createImageSizesDomain({ repo: {} as ProgramsSitesRepository });
  const claims = claimsFor('alpha');

  it('denies another site with 403 before any read or write', async () => {
    const db = untouchedDb();

    await expect(domain.listImageSizes(db, claims, 'beta')).rejects.toMatchObject({ statusCode: 403 });
    await expect(domain.saveImageSize(db, claims, { sizeid: SIZE_1, siteid: 'beta', name: 'x' })).rejects.toMatchObject({ statusCode: 403 });
    expect(db.withTenant).not.toHaveBeenCalled();
  });

  it('writes nothing for an empty sizeid and loads a new bean for an empty id', async () => {
    const db = untouchedDb();

    expect(await domain.saveImageSize(db, claims, { sizeid: '', siteid: 'beta', name: 'x' })).toBeNull();
    expect(await domain.saveImageSize(db, claims, { siteid: 'alpha', name: 'x' })).toBeNull();
    expect(await domain.deleteImageSize(db, claims, '')).toBe(false);
    expect(await domain.loadImageSize(db, claims, '')).toMatchObject({ isNew: 1, height: 'AUTO', width: 'AUTO' });
    expect(db.withTenant).not.toHaveBeenCalled();
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('image sizes domain against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: ProgramsSitesRepository;
  let domain: ImageSizesDomain;
  let run = 0;
  let claims: UserClaims;
  let otherClaims: UserClaims;

  beforeAll(async () => {
    handle = await createThrowawaySchema({
      service: 'programs-sites',
      migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)),
    });
    repo = createProgramsSitesRepository({ clock: fixedClock(new Date(2026, 5, 30, 12, 0, 0)), schema: handle.schema });
    domain = createImageSizesDomain({ repo });
    await ensureUnitGates(handle.app, UNITS);
    await withMetadata(handle.app, (tx) => tx.query(`UPDATE ${handle.schema}.unit_gate SET state = 'open', holder_id = NULL, phase = 'quiet'`));
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(() => {
    run += 1;
    claims = claimsFor('alpha', tenantIdForSite(`image-sizes-${run}`));
    otherClaims = claimsFor('alpha', tenantIdForSite(`image-sizes-${run}-other`));
  });

  async function changelog(): Promise<{ op: string }[]> {
    return handle.app.withTenant(claims.tid, async (tx) =>
      (await tx.query<{ op: string }>(`SELECT op FROM ${handle.schema}.changelog WHERE "table" = 'image_size' ORDER BY seq`)).rows,
    );
  }

  it('inserts a new size under the posted sizeid, then updates only its stored columns', async () => {
    const created = await domain.saveImageSize(handle.app, claims, {
      sizeid: SIZE_2,
      siteid: 'alpha',
      name: 'Hero Banner',
      height: '400',
      width: 'abc',
      imageaction: 'save',
    });
    expect(created).toEqual({ sizeId: SIZE_2, siteId: 'alpha', name: 'hero-banner', height: '400', width: 'AUTO', isNew: 0 });

    const updated = await domain.saveImageSize(handle.app, claims, { sizeid: SIZE_2, siteid: 'alpha', name: 'Hero', height: 'x', width: '800' });
    expect(updated).toEqual({ sizeId: SIZE_2, siteId: 'alpha', name: 'hero', height: '400', width: '800', isNew: 0 });

    expect(await domain.loadImageSize(handle.app, claims, SIZE_2)).toEqual(updated);
    expect((await changelog()).map((entry) => entry.op)).toEqual(['insert', 'update']);
  });

  it('loads an unknown id as a new bean under a fresh id', async () => {
    const loaded = await domain.loadImageSize(handle.app, claims, SIZE_3);

    expect(loaded).toMatchObject({ siteId: '', name: '', height: 'AUTO', width: 'AUTO', isNew: 1 });
    expect(loaded.sizeId).toMatch(CF_UUID);
    expect(loaded.sizeId).not.toBe(SIZE_3);
  });

  it('lists the site sizes by sizeid', async () => {
    for (const sizeid of [SIZE_3, SIZE_1, SIZE_2]) {
      await domain.saveImageSize(handle.app, claims, { sizeid, siteid: 'alpha', name: sizeid.slice(0, 1), height: 'AUTO', width: '10' });
    }

    const listed = await domain.listImageSizes(handle.app, claims, 'alpha');
    expect(listed.map((size) => [size.sizeId, size.name])).toEqual([
      [SIZE_1, 'a'],
      [SIZE_2, 'b'],
      [SIZE_3, 'c'],
    ]);
    expect(await changelog()).toHaveLength(3);
  });

  it('deletes a stored size once, and an unknown one not at all', async () => {
    await domain.saveImageSize(handle.app, claims, { sizeid: SIZE_1, siteid: 'alpha', name: 'gone', height: '1', width: '1' });

    expect(await domain.deleteImageSize(handle.app, claims, SIZE_1)).toBe(true);
    expect(await domain.deleteImageSize(handle.app, claims, SIZE_1)).toBe(false);
    expect((await changelog()).map((entry) => entry.op)).toEqual(['insert', 'delete']);
    expect(await domain.listImageSizes(handle.app, claims, 'alpha')).toEqual([]);
  });

  it('never reads or changes the sizes of another tenant', async () => {
    await domain.saveImageSize(handle.app, otherClaims, { sizeid: SIZE_1, siteid: 'alpha', name: 'theirs', height: '5', width: '5' });

    expect(await domain.listImageSizes(handle.app, claims, 'alpha')).toEqual([]);
    expect(await domain.loadImageSize(handle.app, claims, SIZE_1)).toMatchObject({ isNew: 1, name: '' });
    expect(await domain.deleteImageSize(handle.app, claims, SIZE_1)).toBe(false);
    expect(await domain.listImageSizes(handle.app, otherClaims, 'alpha')).toEqual([
      { sizeId: SIZE_1, siteId: 'alpha', name: 'theirs', height: '5', width: '5', isNew: 0 },
    ]);
    expect(await changelog()).toEqual([]);
  });
});
