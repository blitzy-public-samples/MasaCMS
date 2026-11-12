/** People repository against a throwaway `people` schema: legacy DAO rules, orderings, gates, changelog rows and the archive and roster guards. */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RepositoryError,
  UnitNotAuthoritativeError,
  closeGates,
  ensureUnitGates,
  openGates,
  type RepositoryRow,
} from '@opt2/platform/migration-kit';
import { cfUuid } from '@opt2/platform/legacy-compat';
import type { TenantTx } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_B, createThrowawaySchema, fixedClock, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  DuplicateArchiveError,
  OWNER,
  RosterOperationOpenError,
  SCHEMA,
  createPeopleRepository,
  lastUpdateInfo,
  type AuditActor,
  type PeopleRepository,
  type PersonInput,
  type PersonQuery,
} from '../../src/repo/repository.js';
import { FAVORITE, PEOPLE_UNITS, type PersonRow } from '../../src/repo/tables.js';

const NOW = new Date(2026, 5, 30, 10, 0, 0, 0);
const LATER = new Date(2026, 5, 30, 11, 0, 0, 0);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

describe('lastUpdateInfo', () => {
  const person = { userid: 'PERSON', fname: 'Pat', lname: 'Lee' };
  const actor: AuditActor = { userId: 'ACTOR', fname: 'Ada', lname: 'Admin', isLoggedIn: true };

  it.each([
    ['a logged-in actor names itself', actor, person, { lastupdateby: 'Ada Admin', lastupdatebyid: 'ACTOR' }],
    ['no actor names the person', null, person, { lastupdateby: 'Pat Lee', lastupdatebyid: 'PERSON' }],
    ['a logged-out actor names the person', { ...actor, isLoggedIn: false }, person, { lastupdateby: 'Pat Lee', lastupdatebyid: 'PERSON' }],
    ['missing names leave the single space', undefined, { userid: 'P' }, { lastupdateby: ' ', lastupdatebyid: 'P' }],
    ['the label is cut at 50 characters', { ...actor, fname: 'x'.repeat(40), lname: 'y'.repeat(20) }, person, {
      lastupdateby: `${'x'.repeat(40)} ${'y'.repeat(9)}`,
      lastupdatebyid: 'ACTOR',
    }],
  ] as const)('%s', (_label, who, subject, expected) => {
    expect(lastUpdateInfo(who, subject)).toEqual(expected);
  });

  it('names the service and schema', () => {
    expect([OWNER, SCHEMA]).toEqual(['people', 'people']);
  });
});

const available = await pgAvailable();

describe.skipIf(!available)('people repository against PostgreSQL', () => {
  let handle: ThrowawaySchema;
  let repo: PeopleRepository;

  beforeAll(async () => {
    handle = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
    await ensureUnitGates(handle.app, PEOPLE_UNITS);
  });

  afterAll(async () => {
    await handle?.drop();
  });

  beforeEach(async () => {
    await setGates('open');
    repo = createPeopleRepository({ clock: fixedClock(NOW), schema: handle.schema });
  });

  async function setGates(state: 'open' | 'legacy'): Promise<void> {
    await closeGates(handle.app, { units: PEOPLE_UNITS, holderId: 'repository-test', allowLegacy: true });
    await openGates(handle.app, { units: PEOPLE_UNITS, holderId: 'repository-test', state });
  }

  function inTenant<T>(fn: (tx: TenantTx) => Promise<T>, tenant = TENANT_A.tenantId): Promise<T> {
    return handle.app.withTenant(tenant, fn);
  }

  function rows<T = RepositoryRow>(sql: string, params: unknown[] = [], tenant = TENANT_A.tenantId): Promise<T[]> {
    return inTenant(async (tx) => (await tx.query(sql.replaceAll('<s>', handle.schema), params)).rows as T[], tenant);
  }

  /** Changelog rows of `table` whose key or row image holds `id`. */
  function changelog(table: string, id: string): Promise<{ op: string; columns: string[]; operation_id: string | null }[]> {
    const sql = 'SELECT op, columns, operation_id FROM <s>.changelog WHERE "table" = $1 AND (key LIKE $2 OR coalesce(after, before) LIKE $2) ORDER BY seq';
    return rows(sql, [table, `%${id}%`]);
  }

  function personInput(overrides: Partial<PersonInput> = {}): PersonInput {
    return {
      userid: cfUuid(),
      groupname: '',
      fname: 'Pat',
      lname: 'Lee',
      email: 'pat@example.com',
      company: '',
      jobtitle: '',
      mobilephone: '',
      website: '',
      subtype: 'Default',
      contactform: '',
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
      siteid: 'tenant-a',
      subscribe: 1,
      notes: '',
      description: '',
      interests: '',
      keepprivate: 0,
      photofileid: '',
      imname: '',
      imservice: '',
      tags: '',
      ...overrides,
    };
  }

  async function addPerson(overrides: Partial<PersonInput> = {}, tenant = TENANT_A.tenantId): Promise<PersonRow> {
    return inTenant((tx) => repo.insertPerson(tx, personInput(overrides)), tenant);
  }

  describe('persons', () => {
    it('inserts with the DAO NULL rule, both timestamps now and row_version 1', async () => {
      const stored = await addPerson({ userid: 'short-id', company: 'Acme' });
      expect(stored).toMatchObject({ userid: 'short-id'.padEnd(35), company: 'Acme', groupname: null, notes: null, ext: null, subscribe: 1 });
      expect([stored.created, stored.lastupdate, stored.row_version]).toEqual([NOW, NOW, '1']);
      expect(await changelog('person', 'short-id')).toEqual([expect.objectContaining({ op: 'insert' })]);
    });

    it.each([
      ['one past its tombstone', '7', '8'],
      ['at 1 without a tombstone', null, '1'],
    ] as const)('inserts a person %s', async (_label, tombstone, expected) => {
      const userid = cfUuid();
      if (tombstone !== null) await inTenant((tx) => repo.recordPersonTombstone(tx, userid, tombstone));
      expect(await inTenant((tx) => repo.personTombstoneVersion(tx, userid))).toBe(tombstone);
      expect(await inTenant((tx) => repo.personTombstoneVersion(tx, userid), TENANT_B.tenantId)).toBeNull();
      expect((await addPerson({ userid })).row_version).toBe(expected);
    });

    it('updates the DAO columns, keeps created and ext, trims siteid and adds 1 to row_version in one changelog row', async () => {
      const stored = await addPerson();
      repo = createPeopleRepository({ clock: fixedClock(LATER), schema: handle.schema });
      const { userid: _userid, ...update } = personInput({ fname: 'Patricia', siteid: '  ', notes: 'n' });
      const updated = await inTenant((tx) => repo.updatePerson(tx, stored.userid, update, { operationId: 'OP-1' }));
      expect(updated).toMatchObject({ fname: 'Patricia', siteid: '', notes: 'n', created: NOW, lastupdate: LATER, row_version: '2', ext: null });
      const log = await changelog('person', stored.userid);
      expect(log).toHaveLength(2);
      expect(log[1]).toMatchObject({ op: 'update', operation_id: 'OP-1' });
      expect(log[1]?.columns).toEqual(expect.arrayContaining(['fname', 'siteid', 'notes', 'lastupdate', 'row_version']));
      expect(await inTenant((tx) => repo.updatePerson(tx, cfUuid(), update))).toBeNull();
    });

    it('finds persons in input order, omitting missing ids and repeats', async () => {
      const [first, second] = [await addPerson(), await addPerson()];
      const found = await inTenant((tx) => repo.findPersons(tx, [second.userid, cfUuid(), first.userid, second.userid]));
      expect(found.map((row) => row.userid)).toEqual([second.userid, first.userid]);
      expect(await inTenant((tx) => repo.findPersons(tx, []))).toEqual([]);
      expect(await inTenant((tx) => repo.findPerson(tx, first.userid))).toMatchObject({ userid: first.userid });
      expect(await inTenant((tx) => repo.findPerson(tx, first.userid), TENANT_B.tenantId)).toBeNull();
    });

    it('lists a site by last then first name, case-insensitively with NULLs first', async () => {
      const siteid = `order-${cfUuid()}`;
      const names: [string, string][] = [['', 'Zed'], ['beta', 'b'], ['Alpha', 'z'], ['alpha', 'A']];
      const ids: string[] = [];
      for (const [lname, fname] of names) ids.push((await addPerson({ siteid, lname, fname })).userid);
      const listed = await inTenant((tx) => repo.listPersonsForSite(tx, siteid));
      expect(listed.map((row) => [row.lname, row.fname])).toEqual([[null, 'Zed'], ['alpha', 'A'], ['Alpha', 'z'], ['beta', 'b']]);
      const only = await inTenant((tx) => repo.listPersonsForSite(tx, siteid, { userIds: [ids[1] as string] }));
      expect(only.map((row) => row.lname)).toEqual(['beta']);
    });

    it('searches the person columns as getSearch does', async () => {
      const siteId = `search-${cfUuid()}`;
      const a = await addPerson({ siteid: siteId, lname: 'Smith', company: 'Back\\Slash' });
      const b = await addPerson({ siteid: siteId, lname: 'Jones', jobtitle: 'Smithy' });
      const c = await addPerson({ siteid: siteId, lname: null, email: 'other@example.com' });
      const search = (term: string, extra: object = {}): Promise<string[]> =>
        inTenant(async (tx) => (await repo.searchPersons(tx, { siteId, term, ...extra })).map((row) => row.userid));
      expect(await search('')).toEqual([]);
      expect(await search('SMITH')).toEqual([b.userid, a.userid]);
      expect(await search('k\\s')).toEqual([a.userid]);
      expect(await search('j_nes')).toEqual([b.userid]);
      expect(await search('nomatch', { orUserIds: [c.userid] })).toEqual([c.userid]);
      expect(await search('smith', { restrictUserIds: [a.userid] })).toEqual([a.userid]);
      expect(await search('example', { limit: 1 })).toEqual([c.userid]);
    });

    describe('queryPersons', () => {
      const siteId = `query-${cfUuid()}`;
      let people: Record<string, PersonRow>;

      beforeAll(async () => {
        repo = createPeopleRepository({ clock: fixedClock(NOW), schema: handle.schema });
        await setGates('open');
        people = {
          ann: await addPerson({ siteid: siteId, fname: 'Ann', lname: 'Able', company: 'Acme', subscribe: 0 }),
          bob: await addPerson({ siteid: siteId, fname: 'Bob', lname: 'baker', company: 'Bolt ', subscribe: 1 }),
          cy: await addPerson({ siteid: siteId, fname: 'Cy', lname: 'Cole', company: '', subscribe: 2 }),
        };
      });

      it.each<[string, PersonQuery, string[]]>([
        ['eq ignores case and trailing spaces', { conditions: [{ column: 'company', op: 'eq', value: 'BOLT' }] }, ['bob']],
        ['neq skips NULL', { conditions: [{ column: 'company', op: 'neq', value: 'acme' }] }, ['bob']],
        ['like', { conditions: [{ column: 'lname', op: 'like', value: 'OL' }] }, ['cy']],
        ['begins', { conditions: [{ column: 'fname', op: 'begins', value: 'b' }] }, ['bob']],
        ['gt on a number', { conditions: [{ column: 'subscribe', op: 'gt', value: 0 }] }, ['bob', 'cy']],
        ['gte on text', { conditions: [{ column: 'lname', op: 'gte', value: 'B' }] }, ['bob', 'cy']],
        ['lt', { conditions: [{ column: 'subscribe', op: 'lt', value: 1 }] }, ['ann']],
        ['lte', { conditions: [{ column: 'subscribe', op: 'lte', value: 1 }] }, ['ann', 'bob']],
        ['in on text', { conditions: [{ column: 'fname', op: 'in', value: ['ANN', 'cy'] }] }, ['ann', 'cy']],
        ['in on a number', { conditions: [{ column: 'subscribe', op: 'in', value: 2 }] }, ['cy']],
        ['null', { conditions: [{ column: 'company', op: 'null' }] }, ['cy']],
        ['notnull', { conditions: [{ column: 'company', op: 'notnull' }] }, ['ann', 'bob']],
        ['or', { combine: 'or', conditions: [{ column: 'fname', op: 'eq', value: 'ann' }, { column: 'fname', op: 'eq', value: 'cy' }] }, ['ann', 'cy']],
        ['order and limit', { orderBy: [{ column: 'subscribe', direction: 'desc' }], limit: 2 }, ['cy', 'bob']],
      ])('%s', async (_label, query, expected) => {
        const found = await inTenant((tx) => repo.queryPersons(tx, { siteIds: [siteId], ...query }));
        const names = Object.fromEntries(Object.entries(people).map(([key, row]) => [row.userid, key]));
        expect(found.map((row) => names[row.userid])).toEqual(expected);
      });

      it('restricts to user ids and rejects an unknown column', async () => {
        const found = await inTenant((tx) => repo.queryPersons(tx, { userIds: [people.bob?.userid as string] }));
        expect(found.map((row) => row.fname)).toEqual(['Bob']);
        const bad = { conditions: [{ column: 'username; --', op: 'eq', value: 'x' }] } as unknown as PersonQuery;
        await expect(inTenant((tx) => repo.queryPersons(tx, bad))).rejects.toBeInstanceOf(RepositoryError);
      });
    });

    it('refuses writes to a legacy-authoritative unit and hides other tenants', async () => {
      const stored = await addPerson({}, TENANT_B.tenantId);
      expect(await inTenant((tx) => repo.listPersonsForSite(tx, 'tenant-a'))).not.toContainEqual(expect.objectContaining({ userid: stored.userid }));
      await setGates('legacy');
      await expect(addPerson()).rejects.toBeInstanceOf(UnitNotAuthoritativeError);
    });
  });

  describe('addresses', () => {
    it('inserts with addressBean defaults, updates without isprimary and lists primary first', async () => {
      const userid = cfUuid();
      const first = await inTenant((tx) => repo.insertAddress(tx, { userid, siteid: '', city: 'Oslo', isprimary: null }));
      expect(first.addressid).toMatch(CF_UUID);
      expect(first).toMatchObject({ siteid: null, city: 'Oslo', zip: null, isprimary: null, longitude: 0, latitude: 0 });
      const second = await inTenant((tx) => repo.insertAddress(tx, { userid, addressid: 'A2', isprimary: 1 }));
      expect(second.isprimary).toBe(1);
      const updated = await inTenant((tx) => repo.updateAddress(tx, first.addressid, { userid, siteid: ' tenant-a ', city: '', zip: '0150' }));
      expect(updated).toMatchObject({ siteid: 'tenant-a', city: null, zip: '0150', isprimary: null, userid });
      expect((await inTenant((tx) => repo.listAddresses(tx, userid))).map((row) => row.addressid)).toEqual([second.addressid, first.addressid]);
      expect(await inTenant((tx) => repo.findAddress(tx, second.addressid))).toMatchObject({ isprimary: 1 });
      expect(await inTenant((tx) => repo.updateAddress(tx, cfUuid(), {}))).toBeNull();
    });

    it('sets the only primary address, updating only rows that change', async () => {
      const userid = cfUuid();
      const ids: string[] = [];
      for (const isprimary of [1, null, 0]) ids.push((await inTenant((tx) => repo.insertAddress(tx, { userid, isprimary }))).addressid);
      const [was, unset, zero] = ids as [string, string, string];
      await inTenant((tx) => repo.setPrimaryAddress(tx, userid, zero));
      const stored = await inTenant((tx) => repo.listAddresses(tx, userid));
      expect(Object.fromEntries(stored.map((row) => [row.addressid, row.isprimary]))).toEqual({ [was]: 0, [unset]: 0, [zero]: 1 });
      expect((await changelog('user_address', zero)).map((row) => row.op)).toEqual(['insert', 'update']);
      await inTenant((tx) => repo.setPrimaryAddress(tx, userid, zero));
      expect(await changelog('user_address', zero)).toHaveLength(2);
    });

    it('deletes the address with its extended data', async () => {
      const address = await inTenant((tx) => repo.insertAddress(tx, { userid: cfUuid() }));
      await inTenant((tx) => repo.replaceExtendData(tx, address.addressid, [{ attributeId: 7, row: extendValues('v') }]));
      expect(await inTenant((tx) => repo.deleteAddress(tx, address.addressid))).toBe(true);
      expect(await inTenant((tx) => repo.listExtendData(tx, [address.addressid]))).toEqual([]);
      expect(await inTenant((tx) => repo.deleteAddress(tx, address.addressid))).toBe(false);
    });
  });

  describe('interests, tags and favorites', () => {
    it('replaces interests, skipping empty, over-long and repeated ids, within the scope', async () => {
      const userid = cfUuid();
      const kept = cfUuid();
      await inTenant((tx) => repo.replaceInterests(tx, userid, [kept, 'OLD']));
      const inserted = await inTenant((tx) =>
        repo.replaceInterests(tx, userid, ['new', '', 'x'.repeat(36), 'NEW', kept.toLowerCase(), 'old'], { scopeCategoryIds: ['OLD'] }),
      );
      expect(inserted.map((row) => row.categoryid.trim())).toEqual(['new', 'old']);
      const stored = await rows<{ categoryid: string }>('SELECT categoryid FROM <s>.user_interest WHERE userid = $1 ORDER BY categoryid', [userid]);
      expect(stored.map((row) => row.categoryid.trim()).sort()).toEqual([kept, 'new', 'old'].sort());
    });

    it('replaces tags with trimmed, non-empty items and new sequence ids', async () => {
      const userId = cfUuid();
      await inTenant((tx) => repo.replaceTags(tx, { userId, siteId: 'tenant-a', tags: 'old' }));
      const created = await inTenant((tx) => repo.replaceTags(tx, { userId, siteId: '', tags: ' red ,, ,blue,red' }));
      expect(created.map((row) => [row.tag, row.siteid])).toEqual([['red', ''], ['blue', ''], ['red', '']]);
      expect(new Set(created.map((row) => row.tagid)).size).toBe(3);
      const stored = await rows<{ tag: string }>('SELECT tag FROM <s>.user_tag WHERE userid = $1', [userId]);
      expect(stored.map((row) => row.tag).sort()).toEqual(['blue', 'red', 'red']);
      expect(await inTenant((tx) => repo.replaceTags(tx, { userId, siteId: '', tags: null }))).toEqual([]);
    });

    it('lists favorites by creation time', async () => {
      const userid = cfUuid();
      for (const [favoriteid, datecreated] of [['F2', LATER], ['F1', NOW]] as const) {
        await inTenant((tx) => repo.insert(tx, FAVORITE.table, { favoriteid, userid, favorite: 'c', type: 'Page', datecreated }));
      }
      expect((await inTenant((tx) => repo.listFavorites(tx, userid))).map((row) => row.favoriteid.trim())).toEqual(['F1', 'F2']);
    });
  });

  describe('extended data and definitions', () => {
    it('replaces values per attribute and deletes a base', async () => {
      const baseId = cfUuid();
      await inTenant((tx) => repo.replaceExtendData(tx, baseId, [{ attributeId: 1, row: extendValues('a') }, { attributeId: 2, row: extendValues('b') }]));
      const inserted = await inTenant((tx) => repo.replaceExtendData(tx, baseId, [{ attributeId: 1, row: extendValues('c') }, { attributeId: 2, row: null }]));
      expect(inserted.map((row) => [row.attributeid, row.stringvalue, row.baseid])).toEqual([[1, 'c', baseId]]);
      expect((await inTenant((tx) => repo.listExtendData(tx, [baseId]))).map((row) => row.stringvalue)).toEqual(['c']);
      expect(await inTenant((tx) => repo.listExtendData(tx, []))).toEqual([]);
      expect(await inTenant((tx) => repo.deleteExtendDataForBase(tx, baseId))).toBe(1);
    });

    it('lists subtypes, sets and attributes in legacy order with their filters', async () => {
      const siteid = `ext-${cfUuid()}`;
      const subtypes = [
        ['S1', 'User', 'Zeta', 'tusers'],
        ['S2', 'Address', 'Default', 'tusersaddresses'],
        ['S3', 'user', 'alpha', 'tusers'],
      ];
      await inTenant(async (tx) => {
        for (const [subtypeid, type, subtype, basetable] of subtypes) await repo.insert(tx, 'extend_subtype', { subtypeid, siteid, type, subtype, basetable });
        for (const [extendsetid, orderno] of [['SET2', 2], ['SET1', 1]] as const) await repo.insert(tx, 'extend_set', { extendsetid, subtypeid: 'S1', siteid, orderno });
        for (const [attributeid, name, orderno] of [[30, 'b', 1], [20, 'a', 1], [10, 'z', 0]] as const) {
          await repo.insert(tx, 'extend_attribute', { attributeid, extendsetid: 'SET1', siteid, name, orderno });
        }
      });
      const ids = (list: readonly object[], key: string): string[] => list.map((row) => String((row as Record<string, unknown>)[key]).trim());
      expect(ids(await inTenant((tx) => repo.listExtendSubtypes(tx, { siteId: siteid })), 'subtypeid')).toEqual(['S2', 'S3', 'S1']);
      expect(ids(await inTenant((tx) => repo.listExtendSubtypes(tx, { siteId: siteid, types: ['USER '] })), 'subtypeid')).toEqual(['S3', 'S1']);
      expect(ids(await inTenant((tx) => repo.listExtendSets(tx, ['S1'])), 'extendsetid')).toEqual(['SET1', 'SET2']);
      expect(await inTenant((tx) => repo.listExtendSets(tx, []))).toEqual([]);
      expect(ids(await inTenant((tx) => repo.listExtendAttributes(tx, { setIds: ['SET1'] })), 'attributeid')).toEqual(['10', '20', '30']);
      const filtered = await inTenant((tx) => repo.listExtendAttributes(tx, { attributeIds: [20, 30], siteId: siteid }));
      expect(ids(filtered, 'attributeid')).toEqual(['20', '30']);
    });
  });

  it('inserts a trash row only when none exists for its object', async () => {
    const row = {
      objectid: cfUuid(),
      parentid: cfUuid(),
      siteid: 'tenant-a',
      objectlabel: 'Pat Lee',
      objectclass: 'userBean',
      objecttype: '2',
      objectsubtype: 'Default',
      objectstring: '<wddxPacket/>',
      deleteddate: NOW,
      deletedby: 'Ada Admin',
      deleteid: cfUuid(),
      orderno: 1,
    };
    expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, row))).toMatchObject({ objectlabel: 'Pat Lee' });
    expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, { ...row, objectlabel: 'again' }))).toBeNull();
  });

  describe('archive', () => {
    const archiveRow = (person_id: string, effective_from: Date) => ({ person_id, siteid: 'tenant-a', effective_from, archived_by_id: null, archived_by: null });

    it('stores one archive per person and rejects any repeat without writing', async () => {
      const personId = cfUuid();
      const stored = await inTenant((tx) => repo.insertPersonArchive(tx, archiveRow(personId, NOW)));
      expect(stored).toMatchObject({ person_id: personId, archived_at: NOW });
      expect(stored.archive_id).toMatch(CF_UUID);
      for (const effectiveFrom of [NOW, LATER]) {
        await expect(inTenant((tx) => repo.insertPersonArchive(tx, archiveRow(personId, effectiveFrom)))).rejects.toBeInstanceOf(DuplicateArchiveError);
      }
      expect(await changelog('person_archive', personId)).toHaveLength(1);
      expect(await inTenant((tx) => repo.findPersonArchive(tx, personId, LATER))).toBeNull();
      expect(await inTenant((tx) => repo.findPersonArchive(tx, personId, NOW))).toMatchObject({ archive_id: stored.archive_id });
      expect(await inTenant((tx) => repo.findPersonArchive(tx, personId))).toMatchObject({ archive_id: stored.archive_id });
    });

    it('turns a concurrent duplicate that reaches the unique key into DuplicateArchiveError', async () => {
      const personId = cfUuid();
      let release: () => void = () => undefined;
      let inserted: () => void = () => undefined;
      const held = new Promise<void>((resolve) => (release = resolve));
      const written = new Promise<void>((resolve) => (inserted = resolve));
      // The writer bypasses the archive guard, as a migration apply does, and keeps its row uncommitted.
      const writer = inTenant(async (tx) => {
        await repo.insert(tx, 'person_archive', { ...archiveRow(personId, NOW), archive_id: cfUuid(), archived_at: NOW });
        inserted();
        await held;
      });
      await written;
      const waiting = async (): Promise<boolean> =>
        (await handle.adminPool.query('SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE NOT l.granted AND a.usename = $1', [handle.roles.app])).rows.length > 0;
      const second = inTenant((tx) => repo.insertPersonArchive(tx, archiveRow(personId, NOW)));
      const outcome = second.catch((err: unknown) => err);
      while (!(await waiting())) await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      await writer;
      expect(await outcome).toBeInstanceOf(DuplicateArchiveError);
    });
  });

  describe('roster operations', () => {
    it('allows one open operation per user and finds open and stale ones', async () => {
      const userId = cfUuid();
      const op = await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
      expect(op).toMatchObject({ state: 'started', user_id: userId, started_at: NOW, updated_at: NOW, before_image: null });
      expect(op.operation_id).toMatch(CF_UUID);
      await expect(inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }))).rejects.toBeInstanceOf(
        RosterOperationOpenError,
      );
      expect(await inTenant((tx) => repo.findOpenRosterOperation(tx, userId))).toMatchObject({ operation_id: op.operation_id });
      expect((await inTenant((tx) => repo.listStaleRosterOperations(tx, LATER))).map((row) => row.operation_id)).toContain(op.operation_id);
      expect((await inTenant((tx) => repo.listStaleRosterOperations(tx, NOW))).map((row) => row.operation_id)).not.toContain(op.operation_id);

      repo = createPeopleRepository({ clock: fixedClock(LATER), schema: handle.schema });
      const committed = await inTenant((tx) =>
        repo.setRosterOperationState(tx, op.operation_id, { state: 'people-committed', beforeImage: '{"a":1}', identityXid: '42' }),
      );
      expect(committed).toMatchObject({ state: 'people-committed', before_image: '{"a":1}', identity_xid: '42', error: null, updated_at: LATER });
      const done = await inTenant((tx) => repo.setRosterOperationState(tx, op.operation_id, { state: 'done', error: null }));
      expect(done).toMatchObject({ state: 'done', before_image: '{"a":1}' });
      expect(await inTenant((tx) => repo.findOpenRosterOperation(tx, userId))).toBeNull();
      expect(await inTenant((tx) => repo.findRosterOperation(tx, op.operation_id))).toMatchObject({ state: 'done' });
      expect(await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }))).toMatchObject({ state: 'started' });
    });

    it('rethrows other insert failures', async () => {
      await expect(
        inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'x', userId: 'x'.repeat(36), payload: '{}' })),
      ).rejects.not.toBeInstanceOf(RosterOperationOpenError);
    });
  });

  it('upserts, lists and deletes group-name projection rows', async () => {
    const groupId = cfUuid();
    const row = { group_id: groupId, site_id: 'tenant-a', group_name: 'Editors', is_public: 0, deleted: false, aggregate_version: 1 };
    await inTenant((tx) => repo.upsertGroupName(tx, row));
    expect(await inTenant((tx) => repo.upsertGroupName(tx, { ...row, group_name: 'Writers', aggregate_version: 2 }))).toMatchObject({
      group_name: 'Writers',
      aggregate_version: '2',
    });
    expect((await inTenant((tx) => repo.listGroupNames(tx, [groupId]))).map((r) => r.group_name)).toEqual(['Writers']);
    expect((await inTenant((tx) => repo.listGroupNames(tx))).length).toBeGreaterThan(0);
    expect(await inTenant((tx) => repo.deleteGroupName(tx, groupId))).toBe(true);
    expect(await inTenant((tx) => repo.deleteGroupName(tx, groupId))).toBe(false);
  });
});

function extendValues(stringvalue: string) {
  return { siteid: 'tenant-a', attributevalue: stringvalue, remoteid: null, datetimevalue: null, numericvalue: null, stringvalue };
}
