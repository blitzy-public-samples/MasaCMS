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
  LegacyStorageError,
  OWNER,
  RosterOperationOpenError,
  SCHEMA,
  createPeopleRepository,
  lastUpdateInfo,
  legacyStorable,
  type AddressInput,
  type AuditActor,
  type ExtendAttributeFilter,
  type ExtendDataValues,
  type LegacyLimitedTable,
  type PeopleRepository,
  type PersonArchiveInput,
  type PersonCursor,
  type PersonInput,
  type PersonQuery,
  type PersonUpdate,
  type RosterOperationCursor,
  type TrashInput,
} from '../../src/repo/repository.js';
import { FAVORITE, PEOPLE_UNITS, PERSON, type PersonRow } from '../../src/repo/tables.js';

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
    ['missing names give the empty label', undefined, { userid: 'P' }, { lastupdateby: '', lastupdatebyid: 'P' }],
    ['a missing surname leaves no trailing space', null, { userid: 'P', fname: 'Alice', lname: null }, { lastupdateby: 'Alice', lastupdatebyid: 'P' }],
    ['a missing first name leaves no leading space', null, { userid: 'P', lname: 'Lee' }, { lastupdateby: 'Lee', lastupdatebyid: 'P' }],
    ['outer whitespace and control characters are trimmed', { ...actor, fname: '\t Ada', lname: 'Admin \n' }, person, {
      lastupdateby: 'Ada Admin',
      lastupdatebyid: 'ACTOR',
    }],
    ['the label is cut at 50 characters', { ...actor, fname: 'x'.repeat(40), lname: 'y'.repeat(20) }, person, {
      lastupdateby: `${'x'.repeat(40)} ${'y'.repeat(9)}`,
      lastupdatebyid: 'ACTOR',
    }],
    ['a space at character 50 is trimmed after the cut', null, { userid: 'P', fname: 'x'.repeat(49), lname: 'y' }, {
      lastupdateby: 'x'.repeat(49),
      lastupdatebyid: 'P',
    }],
    ['leading spaces are trimmed after the cut', null, { userid: 'P', fname: `  ${'x'.repeat(47)}`, lname: 'yz' }, {
      lastupdateby: 'x'.repeat(47),
      lastupdatebyid: 'P',
    }],
  ] as const)('%s', (_label, who, subject, expected) => {
    expect(lastUpdateInfo(who, subject)).toEqual(expected);
  });

  it('names the service and schema', () => {
    expect([OWNER, SCHEMA]).toEqual(['people', 'people']);
  });
});

describe('legacyStorable', () => {
  const smile = '\u{1F600}';

  it.each<[string, LegacyLimitedTable, RepositoryRow, RepositoryRow]>([
    ['a value at the width', 'user_tag', { tag: 'x'.repeat(100), siteid: 's'.repeat(25) }, { tag: 'x'.repeat(100), siteid: 's'.repeat(25) }],
    ['only trailing spaces beyond the width, cut', 'person', { fname: `${'x'.repeat(50)}   `, notes: ' n ' }, { fname: 'x'.repeat(50), notes: ' n ' }],
    ['NULL, absent and unlimited columns', 'person', { fname: null, tags: 'x'.repeat(300) }, { fname: null, tags: 'x'.repeat(300) }],
    ['surrogate pairs within the width', 'person', { fname: smile.repeat(25) }, { fname: smile.repeat(25) }],
    ['the tinyint bounds', 'user_address', { isprimary: 0 }, { isprimary: 0 }],
    ['the tinyint top', 'person', { keepprivate: 255 }, { keepprivate: 255 }],
    ['a finite float', 'extend_data_user_activity', { numericvalue: -1.5e300 }, { numericvalue: -1.5e300 }],
    ['the last 1752 time, which rounds into 1753', 'trash', { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 999) }, { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 999) }],
    ['the datetime floor', 'extend_data_user_activity', { datetimevalue: new Date(1753, 0, 1, 0, 0, 0, 0) }, { datetimevalue: new Date(1753, 0, 1, 0, 0, 0, 0) }],
    ['the last datetime', 'extend_data_user_activity', { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 998) }, { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 998) }],
    ['datetime text', 'trash', { deleteddate: '2026-06-30 10:00:00' }, { deleteddate: '2026-06-30 10:00:00' }],
  ])('stores %s', (_label, table, row, expected) => {
    expect(legacyStorable(table, row)).toEqual(expected);
  });

  it.each<[string, LegacyLimitedTable, RepositoryRow, string, 'width' | 'range']>([
    ['text beyond the width', 'user_tag', { tag: 'x'.repeat(101) }, 'tag', 'width'],
    ['a space then text beyond the width', 'person', { fname: `${'x'.repeat(50)} y` }, 'fname', 'width'],
    ['surrogate pairs beyond the width', 'person', { fname: smile.repeat(26) }, 'fname', 'width'],
    ['a varchar(25) site id of 26', 'trash', { siteid: 's'.repeat(26) }, 'siteid', 'width'],
    ['a tinyint below 0', 'person', { keepprivate: -1 }, 'keepprivate', 'range'],
    ['a tinyint above 255', 'user_address', { isprimary: 256 }, 'isprimary', 'range'],
    ['a NaN float', 'user_address', { longitude: Number.NaN }, 'longitude', 'range'],
    ['an infinite float', 'extend_data_user_activity', { numericvalue: Number.NEGATIVE_INFINITY }, 'numericvalue', 'range'],
    ['a datetime that rounds below 1753', 'trash', { deleteddate: new Date(1752, 11, 31, 23, 59, 59, 998) }, 'deleteddate', 'range'],
    ['a datetime that rounds past 9999', 'extend_data_user_activity', { datetimevalue: new Date(9999, 11, 31, 23, 59, 59, 999) }, 'datetimevalue', 'range'],
    ['an invalid Date', 'extend_data_user_activity', { datetimevalue: new Date(Number.NaN) }, 'datetimevalue', 'range'],
    ['datetime text that does not parse', 'trash', { deleteddate: 'not a date' }, 'deleteddate', 'range'],
  ])('rejects %s', (_label, table, row, column, violation) => {
    let thrown: unknown;
    try {
      legacyStorable(table, row);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LegacyStorageError);
    expect(thrown).toBeInstanceOf(RepositoryError);
    expect(thrown).toMatchObject({ table, column, violation });
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

  /** Rows of the transaction tenant (`$1`) that make a tenant-only index condition unselective, so plans pick the most specific index. */
  const FILLERS: Readonly<Record<string, string>> = {
    person: "INSERT INTO <s>.person (tenant_id, userid) SELECT $1, 'FILL-' || g FROM generate_series(1, 3000) AS g",
    user_address: "INSERT INTO <s>.user_address (tenant_id, addressid, userid) SELECT $1, 'FILL-' || g, 'FILL-' || g FROM generate_series(1, 3000) AS g",
    user_tag: "INSERT INTO <s>.user_tag (tenant_id, tagid, userid) SELECT $1, 1000000000 + g, 'FILL-' || g FROM generate_series(1, 3000) AS g",
    user_favorite:
      "INSERT INTO <s>.user_favorite (tenant_id, favoriteid, userid, favorite, type, datecreated) SELECT $1, 'FILL-' || g, 'FILL-' || g, 'c', 'Page', now()" +
      ' FROM generate_series(1, 3000) AS g',
    extend_data_user_activity:
      "INSERT INTO <s>.extend_data_user_activity (tenant_id, dataid, baseid, attributeid) SELECT $1, 1000000000 + g, 'FILL-' || g, g FROM generate_series(1, 3000) AS g",
    extend_set: "INSERT INTO <s>.extend_set (tenant_id, extendsetid, subtypeid) SELECT $1, 'FILL-' || g, 'FILL-' || g FROM generate_series(1, 3000) AS g",
    extend_attribute: "INSERT INTO <s>.extend_attribute (tenant_id, attributeid, extendsetid) SELECT $1, 1000000000 + g, 'FILL-' || g FROM generate_series(1, 3000) AS g",
    trash:
      'INSERT INTO <s>.trash (tenant_id, objectid, parentid, siteid, objectlabel, objectclass, objecttype, objectsubtype, deletedby)' +
      " SELECT $1, 'FILL-' || g, 'P', 's', 'l', 'c', 't', 's', 'd' FROM generate_series(1, 3000) AS g",
    person_archive:
      'INSERT INTO <s>.person_archive (tenant_id, archive_id, person_id, siteid, effective_from, archived_at)' +
      " SELECT $1, 'FILL-' || g, 'FILL-' || g, 's', now(), now() FROM generate_series(1, 3000) AS g",
    group_name: "INSERT INTO <s>.group_name (tenant_id, group_id, aggregate_version) SELECT $1, 'FILL-' || g, 1 FROM generate_series(1, 3000) AS g",
    person_tombstone: "INSERT INTO <s>.person_tombstone (tenant_id, userid, row_version) SELECT $1, 'FILL-' || g, 1 FROM generate_series(1, 3000) AS g",
  };

  /** Every node of an `EXPLAIN (FORMAT JSON)` result as `planOf` returns it. */
  function planNodes(plan: string): Record<string, unknown>[] {
    const walk = (node: Record<string, unknown>): Record<string, unknown>[] => [node, ...((node.Plans ?? []) as Record<string, unknown>[]).flatMap(walk)];
    return (JSON.parse(plan) as { 'QUERY PLAN': { Plan: Record<string, unknown> }[] }[]).flatMap((row) => row['QUERY PLAN'].flatMap((entry) => walk(entry.Plan)));
  }

  /** Runs `call` on `tx` and returns the statements it issued, with their parameters. */
  async function issuedBy(tx: TenantTx, call: (tx: TenantTx) => Promise<unknown>): Promise<[string, unknown[]][]> {
    const issued: [string, unknown[]][] = [];
    const recording: TenantTx = {
      ...tx,
      query(text, values) {
        issued.push([text as string, values ?? []]);
        return tx.query(text, values);
      },
    };
    await call(recording);
    return issued;
  }

  /** The JSON plan of the first statement on `table` that `call` issues, planned over filler rows with sequential scans off; nothing persists. */
  function planOf(call: (tx: TenantTx) => Promise<unknown>, table: string): Promise<string> {
    return inTenant(async (tx) => {
      const statement = (await issuedBy(tx, call)).find(([sql]) => sql.includes(`"${handle.schema}"."${table}"`));
      if (statement === undefined) throw new Error(`no statement reads ${table}`);
      await tx.query('SAVEPOINT plan');
      await tx.query((FILLERS[table] ?? '').replaceAll('<s>', handle.schema), [tx.tenantId]);
      await tx.query('SET LOCAL enable_seqscan = off');
      const plan = JSON.stringify((await tx.query(`EXPLAIN (FORMAT JSON) ${statement[0]}`, statement[1])).rows);
      await tx.query('ROLLBACK TO SAVEPOINT plan');
      return plan;
    });
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

  /** `tx` with the text of every statement it runs appended to `statements`. */
  function recorded(tx: TenantTx, statements: string[]): TenantTx {
    const query = (...args: Parameters<TenantTx['query']>): ReturnType<TenantTx['query']> => {
      statements.push(typeof args[0] === 'string' ? args[0] : args[0].text);
      return tx.query(...args);
    };
    return { ...tx, query: query as TenantTx['query'] };
  }

  /** Runs `write` in a transaction that commits past its error, expecting the LegacyStorageError of `table`.`column`. */
  async function rejectsStorage(write: (tx: TenantTx) => Promise<unknown>, table: string, column: string, violation: 'width' | 'range'): Promise<void> {
    const outcome = await inTenant((tx) => write(tx).then(() => undefined, (err: unknown) => err));
    expect(outcome).toBeInstanceOf(LegacyStorageError);
    expect(outcome).toMatchObject({ table, column, violation });
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

    it.each<[string, Partial<PersonInput>, string, 'width' | 'range']>([
      ['fname of 51 characters', { fname: 'x'.repeat(51) }, 'fname', 'width'],
      ['keepprivate -1', { keepprivate: -1 }, 'keepprivate', 'range'],
      ['keepprivate 256', { keepprivate: 256 }, 'keepprivate', 'range'],
    ])('rejects %s on insert and update, writing nothing', async (_label, values, column, violation) => {
      const userid = cfUuid();
      await rejectsStorage((tx) => repo.insertPerson(tx, personInput({ userid, ...values })), 'person', column, violation);
      expect(await inTenant((tx) => repo.findPerson(tx, userid))).toBeNull();
      const stored = await addPerson();
      const update: PersonUpdate = personInput(values);
      await rejectsStorage((tx) => repo.updatePerson(tx, stored.userid, update), 'person', column, violation);
      await rejectsStorage((tx) => repo.updatePerson(tx, cfUuid(), update), 'person', column, violation);
      expect(await inTenant((tx) => repo.findPerson(tx, stored.userid))).toEqual(stored);
      expect(await changelog('person', stored.userid)).toHaveLength(1);
    });

    it.each([0, 255])('stores keepprivate %i', async (keepprivate) => {
      expect((await addPerson({ keepprivate })).keepprivate).toBe(keepprivate);
    });

    it('stores a value beyond its width by trailing spaces only cut to the width', async () => {
      const stored = await addPerson({ company: `${'c'.repeat(50)}   `, email: `${'e'.repeat(255)} ` });
      expect([stored.company, stored.email]).toEqual(['c'.repeat(50), 'e'.repeat(255)]);
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

    describe('planned over analyzed statistics', () => {
      // Its own schema, so the statistics hold only these 3000 persons of one site, stored in two spellings.
      const site = 'PLAN-site ';
      let planned: ThrowawaySchema;
      let planRepo: PeopleRepository;

      beforeAll(async () => {
        planned = await createThrowawaySchema({ service: 'people', migrationsDir: fileURLToPath(new URL('../../db/migrations', import.meta.url)) });
        await ensureUnitGates(planned.app, PEOPLE_UNITS);
        planRepo = createPeopleRepository({ clock: fixedClock(NOW), schema: planned.schema });
        await planned.app.withTenant(TENANT_A.tenantId, (tx) =>
          tx.query(
            `INSERT INTO "${planned.schema}".person (tenant_id, userid, siteid, lname, fname)` +
              " SELECT $1::uuid, upper(left(md5(g::text), 32)), CASE WHEN g % 10 = 0 THEN 'Plan-Site  ' ELSE 'plan-site' END," +
              " CASE WHEN g % 50 = 0 THEN NULL ELSE 'Name ' || (g % 37) END, 'f' || (g % 5) FROM generate_series(1, 3000) AS g",
            [TENANT_A.tenantId],
          ),
        );
        // Only the table owner may ANALYZE.
        const client = await planned.migratorPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL ROLE "${planned.roles.owner}"`);
          await client.query(`ANALYZE "${planned.schema}".person`);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      });

      afterAll(async () => {
        await planned?.drop();
      });

      /** The JSON plan of the last statement on person that `call` issues, with every planner method enabled. */
      function analyzedPlan(call: (tx: TenantTx) => Promise<unknown>): Promise<string> {
        return planned.app.withTenant(TENANT_A.tenantId, async (tx) => {
          const statement = (await issuedBy(tx, call)).findLast(([sql]) => sql.includes(`"${planned.schema}"."person"`));
          if (statement === undefined) throw new Error('no statement reads person');
          return JSON.stringify((await tx.query(`EXPLAIN (FORMAT JSON) ${statement[0]}`, statement[1])).rows);
        });
      }

      it.each<[string, (tx: TenantTx) => Promise<unknown>]>([
        ['the first page of a site', (tx) => planRepo.pagePersonsForSite(tx, site)],
        ['the next page of a site', async (tx) => planRepo.pagePersonsForSite(tx, site, { after: (await planRepo.pagePersonsForSite(tx, site)).next })],
        ['a page of a site list', (tx) => planRepo.pageQueryPersons(tx, { siteIds: ['other-site', site] })],
      ])('reads %s in the order of person_tenant_name_order_idx without sorting', async (_label, call) => {
        const nodes = planNodes(await analyzedPlan(call));
        expect(nodes.find((node) => node['Index Name'] === 'person_tenant_name_order_idx')).toMatchObject({
          'Node Type': 'Index Scan',
          'Index Cond': expect.stringContaining('tenant_id = '),
          Filter: expect.stringContaining('(siteid)::bpchar = '),
        });
        expect(nodes.filter((node) => String(node['Node Type']).includes('Sort'))).toEqual([]);
      });

      it('lists every person of the site under another spelling', async () => {
        expect(await planned.app.withTenant(TENANT_A.tenantId, (tx) => planRepo.listPersonsForSite(tx, site))).toHaveLength(3000);
      });
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

    it('stores the empty lastUpdateInfo label of a nameless person as NULL', async () => {
      const userid = cfUuid();
      const stored = await addPerson({ userid, fname: '', lname: '', ...lastUpdateInfo(undefined, { userid, fname: '', lname: '' }) });
      expect(stored).toMatchObject({ fname: null, lname: null, lastupdateby: null, lastupdatebyid: userid });
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

    it.each<[string, AddressInput, string, 'width' | 'range']>([
      ['city of 51 characters', { userid: '', city: 'c'.repeat(51) }, 'city', 'width'],
      ['isprimary -1', { userid: '', isprimary: -1 }, 'isprimary', 'range'],
      ['isprimary 256', { userid: '', isprimary: 256 }, 'isprimary', 'range'],
      ['longitude NaN', { userid: '', longitude: Number.NaN }, 'longitude', 'range'],
    ])('rejects an address with %s, writing nothing', async (_label, values, column, violation) => {
      const userid = cfUuid();
      await rejectsStorage((tx) => repo.insertAddress(tx, { ...values, userid }), 'user_address', column, violation);
      expect(await inTenant((tx) => repo.listAddresses(tx, userid))).toEqual([]);
    });

    it('rejects an over-width update, keeping the stored address', async () => {
      const stored = await inTenant((tx) => repo.insertAddress(tx, { userid: cfUuid(), city: 'Oslo' }));
      const update = { userid: stored.userid ?? '', city: 'c'.repeat(51) };
      await rejectsStorage((tx) => repo.updateAddress(tx, stored.addressid, update), 'user_address', 'city', 'width');
      await rejectsStorage((tx) => repo.updateAddress(tx, cfUuid(), update), 'user_address', 'city', 'width');
      expect(await inTenant((tx) => repo.findAddress(tx, stored.addressid))).toEqual(stored);
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

    it.each([['one tag', 'a'], ['four tags', 'a,b,c,d']])('allocates the ids of %s in one statement, ascending in list order', async (_label, tags) => {
      const userId = cfUuid();
      const statements: string[] = [];
      const created = await inTenant((tx) => repo.replaceTags(recorded(tx, statements), { userId, siteId: 'tenant-a', tags }));
      expect(statements.filter((sql) => sql.includes('nextval'))).toHaveLength(1);
      expect(created.map((row) => row.tag)).toEqual(tags.split(','));
      const ids = created.map((row) => row.tagid);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      const cleared: string[] = [];
      expect(await inTenant((tx) => repo.replaceTags(recorded(tx, cleared), { userId, siteId: 'tenant-a', tags: ' , ' }))).toEqual([]);
      expect(cleared.filter((sql) => sql.includes('nextval'))).toEqual([]);
    });

    it('stores tags of exactly 100 characters, trailing spaces trimmed first', async () => {
      const userId = cfUuid();
      const tag = 't'.repeat(100);
      const created = await inTenant((tx) => repo.replaceTags(tx, { userId, siteId: 's'.repeat(25), tags: `${tag},${tag}   ` }));
      expect(created.map((row) => [row.tag, row.siteid])).toEqual([[tag, 's'.repeat(25)], [tag, 's'.repeat(25)]]);
    });

    it.each([
      ['a tag of 101 characters', 'tenant-a', `ok,${'x'.repeat(101)}`, 'tag'],
      ['a site id of 26 characters', 's'.repeat(26), 'ok', 'siteid'],
    ])('rejects %s, deleting and inserting nothing', async (_label, siteId, tags, column) => {
      const userId = cfUuid();
      await inTenant((tx) => repo.replaceTags(tx, { userId, siteId: 'tenant-a', tags: 'old' }));
      await rejectsStorage((tx) => repo.replaceTags(tx, { userId, siteId, tags }), 'user_tag', column, 'width');
      const stored = await rows<{ tag: string }>('SELECT tag FROM <s>.user_tag WHERE userid = $1', [userId]);
      expect(stored.map((row) => row.tag)).toEqual(['old']);
      expect((await changelog('user_tag', userId)).map((row) => row.op)).toEqual(['insert']);
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

    it.each([[[2]], [[3, 1, 4, 2]]])('locks and allocates for attributes %j in one statement each, in entry order', async (attributeIds) => {
      const baseId = cfUuid();
      await inTenant(async (tx) => {
        await repo.replaceExtendData(tx, baseId, [1, 2, 3].map((attributeId) => ({ attributeId, row: extendValues(`old${attributeId}`) })));
        // A second stored row of attribute 2, as legacy can leave beside an empty value.
        await repo.insert(tx, 'extend_data_user_activity', { ...extendValues('extra'), dataid: 2_000_000_000, baseid: baseId, attributeid: 2 });
      });
      const statements: string[] = [];
      const entries = attributeIds.map((attributeId) => ({ attributeId, row: extendValues(`new${attributeId}`) }));
      const inserted = await inTenant((tx) => repo.replaceExtendData(recorded(tx, statements), baseId, entries));
      expect(statements.filter((sql) => sql.includes('extend_data_user_activity') && sql.includes('FOR UPDATE'))).toHaveLength(1);
      expect(statements.filter((sql) => sql.includes('nextval'))).toHaveLength(1);
      expect(inserted.map((row) => [row.attributeid, row.stringvalue])).toEqual(attributeIds.map((id) => [id, `new${id}`]));
      const ids = inserted.map((row) => row.dataid);
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
      const kept = [1, 3].filter((id) => !attributeIds.includes(id)).map((id) => `old${id}`);
      const stored = await inTenant((tx) => repo.listExtendData(tx, [baseId]));
      expect(stored.map((row) => row.stringvalue).sort()).toEqual([...kept, ...attributeIds.map((id) => `new${id}`)].sort());
      const replaced = entries.flatMap(({ attributeId }) => [...(attributeId === 2 ? ['delete', 'delete'] : attributeId === 4 ? [] : ['delete']), 'insert']);
      expect((await changelog('extend_data_user_activity', baseId)).map((row) => row.op).slice(4)).toEqual(replaced);
    });

    it('replaces a repeated attribute in entry order, keeping only its last row', async () => {
      const baseId = cfUuid();
      await inTenant((tx) => repo.replaceExtendData(tx, baseId, [{ attributeId: 5, row: extendValues('old') }]));
      const entries = [{ attributeId: 5, row: extendValues('first') }, { attributeId: 6, row: null }, { attributeId: 5, row: extendValues('last') }];
      const inserted = await inTenant((tx) => repo.replaceExtendData(tx, baseId, entries));
      expect(inserted.map((row) => row.stringvalue)).toEqual(['first', 'last']);
      expect((await inTenant((tx) => repo.listExtendData(tx, [baseId]))).map((row) => row.stringvalue)).toEqual(['last']);
      expect((await changelog('extend_data_user_activity', baseId)).map((row) => row.op)).toEqual(['insert', 'delete', 'insert', 'delete', 'insert']);
    });

    it.each<[string, ExtendDataValues, string, 'width' | 'range']>([
      ['a stringvalue of 256 characters', extendValues('x'.repeat(256)), 'stringvalue', 'width'],
      ['a datetimevalue in 1700', { ...extendValues('d'), datetimevalue: new Date(1700, 0, 1) }, 'datetimevalue', 'range'],
    ])('rejects %s before deleting any attribute', async (_label, invalid, column, violation) => {
      const baseId = cfUuid();
      await inTenant((tx) => repo.replaceExtendData(tx, baseId, [{ attributeId: 1, row: extendValues('a') }]));
      const entries = [{ attributeId: 1, row: extendValues('b') }, { attributeId: 2, row: invalid }];
      await rejectsStorage((tx) => repo.replaceExtendData(tx, baseId, entries), 'extend_data_user_activity', column, violation);
      expect((await inTenant((tx) => repo.listExtendData(tx, [baseId]))).map((row) => row.stringvalue)).toEqual(['a']);
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

    describe('attribute filters, as SQL Server compares set and site ids', () => {
      const site = `Ci-${cfUuid()}`;
      let seeded: Promise<void> | undefined;
      // Seeded on first use, after beforeEach has opened the gates.
      const seed = (): Promise<void> =>
        (seeded ??= inTenant(async (tx) => {
          const attributes = [
            [101, 'CI-SET', site],
            [102, 'ci-set', site.toUpperCase()],
            [103, null, site],
            [104, 'CI-SET', null],
            [105, 'CI-OTHER', `${site}  `],
          ] as const;
          for (const [attributeid, extendsetid, siteid] of attributes) {
            await repo.insert(tx, 'extend_attribute', { attributeid, extendsetid, siteid, name: `a${attributeid}`, orderno: 0 });
          }
        }));

      it.each<[string, ExtendAttributeFilter, number[]]>([
        ['set ids in another case', { setIds: ['ci-SET'] }, [101, 102, 104]],
        ['set ids with trailing spaces', { setIds: ['CI-SET   '] }, [101, 102, 104]],
        ['a site id in another case', { setIds: ['CI-SET', 'ci-other'], siteId: site.toLowerCase() }, [101, 102, 105]],
        ['a site id with trailing spaces', { attributeIds: [101, 102, 103, 104, 105], siteId: `${site}   ` }, [101, 102, 103, 105]],
        ['no NULL set id, even for an empty id', { attributeIds: [103, 104], setIds: [''] }, []],
        ['no NULL site id, even for an empty id', { attributeIds: [103, 104], siteId: '' }, []],
      ])('match %s', async (_label, filter, expected) => {
        await seed();
        expect((await inTenant((tx) => repo.listExtendAttributes(tx, filter))).map((row) => row.attributeid)).toEqual(expected);
      });
    });
  });

  function trashRow(overrides: Partial<TrashInput> = {}): TrashInput {
    return {
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
      ...overrides,
    };
  }

  it('inserts a trash row only when none exists for its object', async () => {
    const row = trashRow();
    expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, row))).toMatchObject({ objectlabel: 'Pat Lee' });
    expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, { ...row, objectlabel: 'again' }))).toBeNull();
    // trashManager inserts only after finding no row, so an existing row is never checked against the limits.
    expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, { ...row, objectlabel: 'x'.repeat(256) }))).toBeNull();
  });

  it.each<[string, Partial<TrashInput>]>([
    ['objectlabel', { objectlabel: 'x'.repeat(256) }],
    ['siteid', { siteid: 's'.repeat(26) }],
  ])('rejects a trash %s beyond its width, writing nothing', async (column, overrides) => {
    const row = trashRow(overrides);
    await rejectsStorage((tx) => repo.insertTrashIfAbsent(tx, row), 'trash', column, 'width');
    expect(await inTenant((tx) => repo.findByKey(tx, 'trash', { objectid: row.objectid }))).toBeNull();
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

    it.each<[string, Partial<PersonArchiveInput>, string, 'width' | 'range']>([
      ['archived_by of 51 characters', { archived_by: 'x'.repeat(51) }, 'archived_by', 'width'],
      ['siteid of 51 characters', { siteid: 's'.repeat(51) }, 'siteid', 'width'],
      ['effective_from before 1753', { effective_from: new Date(1700, 0, 1) }, 'effective_from', 'range'],
    ])('rejects %s, writing nothing', async (_label, values, column, violation) => {
      const personId = cfUuid();
      await rejectsStorage((tx) => repo.insertPersonArchive(tx, { ...archiveRow(personId, NOW), ...values }), 'person_archive', column, violation);
      expect(await inTenant((tx) => repo.findPersonArchive(tx, personId))).toBeNull();
    });

    it.each([
      ['the same spelling', (id: string) => id],
      ['a lower-case spelling', (id: string) => id.toLowerCase()],
    ])('turns a concurrent duplicate under %s that reaches a unique key into DuplicateArchiveError', async (_label, spell) => {
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
      const second = inTenant((tx) => repo.insertPersonArchive(tx, archiveRow(spell(personId), NOW)));
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

  describe('keyset pages', () => {
    /** Every page of a listing, following `next` until it is null. */
    async function pages<R, C>(fetch: (after: C | null) => Promise<{ rows: R[]; next: C | null }>): Promise<R[][]> {
      const all: R[][] = [];
      let after: C | null = null;
      do {
        const page = await fetch(after);
        all.push(page.rows);
        after = page.next;
      } while (after !== null);
      return all;
    }

    const ids = (found: readonly { userid: string }[]): string[] => found.map((row) => row.userid);

    describe('of persons', () => {
      const siteId = `pages-${cfUuid()}`;
      const bulkSite = `bulk-${cfUuid()}`;

      beforeAll(async () => {
        repo = createPeopleRepository({ clock: fixedClock(NOW), schema: handle.schema });
        await setGates('open');
        const people: [string | null, string | null, string | null, number | null][] = [
          [null, 'a', null, null],
          [null, 'b', 'Acme', 1],
          [null, null, 'acme', 0],
          ['Same', 'X', null, 2],
          ['Same', 'X', 'Bolt', null],
          ['Same', 'X', 'Bolt', 1],
          ['same', 'X', 'zeta', 1],
          ['Zed', 'q', null, 2],
          ['alpha', 'r', 'Acme', 0],
        ];
        for (const [lname, fname, company, subscribe] of people) await addPerson({ siteid: siteId, lname, fname, company, subscribe });
        // Seven repeated last names across 2101 persons, so ties straddle every page boundary.
        await rows(
          "INSERT INTO <s>.person (tenant_id, userid, siteid, lname, fname) SELECT $1::uuid, upper(left(md5($2::text || g), 32)), $2::text, 'Bulk ' || (g % 7), 'f' || g" +
            ' FROM generate_series(1, 2101) AS g',
          [TENANT_A.tenantId, bulkSite],
        );
      });

      /** The site's userids in `order`, read in one statement. */
      async function ordered(site: string, order: string): Promise<string[]> {
        return ids(await rows<{ userid: string }>(`SELECT userid FROM <s>.person WHERE siteid = $1 ORDER BY ${order}`, [site]));
      }

      it.each<[string, PersonQuery['orderBy'], string]>([
        ['the default order', undefined, 'lower(lname) ASC NULLS FIRST, lower(fname) ASC NULLS FIRST, userid'],
        [
          'a descending text key with NULLs last',
          [{ column: 'company', direction: 'desc' }, { column: 'lname', direction: 'asc' }],
          'lower(company) DESC NULLS LAST, lower(lname) ASC NULLS FIRST, userid',
        ],
        ['a descending number key with NULLs last', [{ column: 'subscribe', direction: 'desc' }], 'subscribe DESC NULLS LAST, userid'],
        ['a timestamp key every person shares', [{ column: 'created', direction: 'asc' }], 'created ASC NULLS FIRST, userid'],
      ])('splits %s into pages that join to the unpaged order', async (_label, orderBy, order) => {
        const query: PersonQuery = { siteIds: [siteId], ...(orderBy === undefined ? {} : { orderBy }) };
        const paged = await pages((after: PersonCursor | null) => inTenant((tx) => repo.pageQueryPersons(tx, query, { after, limit: 2 })));
        expect(paged.map((page) => page.length)).toEqual([2, 2, 2, 2, 1]);
        expect(paged.flat().map((row) => Object.keys(row))).toEqual(paged.flat().map(() => PERSON.columns.map((column) => column.name)));
        expect(ids(paged.flat())).toEqual(await ordered(siteId, order));
        expect(ids(await inTenant((tx) => repo.queryPersons(tx, query)))).toEqual(await ordered(siteId, order));
      });

      it('pages a site, optionally only some users, and rejects a cursor of another ordering', async () => {
        const all = await inTenant((tx) => repo.listPersonsForSite(tx, siteId));
        const paged = await pages((after: PersonCursor | null) => inTenant((tx) => repo.pagePersonsForSite(tx, siteId, { after, limit: 4 })));
        expect(paged.map((page) => page.length)).toEqual([4, 4, 1]);
        expect(ids(paged.flat())).toEqual(ids(all));
        const only = [all[5]?.userid as string, all[1]?.userid as string];
        expect(ids((await inTenant((tx) => repo.pagePersonsForSite(tx, siteId, { userIds: only }))).rows)).toEqual([only[1], only[0]]);
        const next = (await inTenant((tx) => repo.pagePersonsForSite(tx, siteId, { limit: 1 }))).next;
        expect(next).toEqual({ userid: all[0]?.userid, keys: [null, null] });
        await expect(inTenant((tx) => repo.pageQueryPersons(tx, { siteIds: [siteId], orderBy: [{ column: 'subscribe', direction: 'asc' }] }, { after: next }))).rejects.toBeInstanceOf(
          RangeError,
        );
      });

      it('caps pages at 1000 rows, iterates every page for full results and caps queries at their limit', async () => {
        const all = await inTenant((tx) => repo.listPersonsForSite(tx, bulkSite));
        expect(ids(all)).toEqual(await ordered(bulkSite, 'lower(lname) ASC NULLS FIRST, lower(fname) ASC NULLS FIRST, userid'));
        expect(new Set(ids(all)).size).toBe(2101);
        const clamped = await inTenant((tx) => repo.pagePersonsForSite(tx, bulkSite, { limit: 5000 }));
        expect([clamped.rows.length, clamped.next?.userid]).toEqual([1000, all[999]?.userid]);
        expect((await inTenant((tx) => repo.pagePersonsForSite(tx, bulkSite))).rows).toHaveLength(500);
        expect(ids(await inTenant((tx) => repo.queryPersons(tx, { siteIds: [bulkSite], limit: 1500 })))).toEqual(ids(all).slice(0, 1500));
      });

      it('bounds a search without a limit at getSearch maxrows', async () => {
        expect(await inTenant((tx) => repo.searchPersons(tx, { siteId: bulkSite, term: 'bulk' }))).toHaveLength(2100);
        expect(await inTenant((tx) => repo.searchPersons(tx, { siteId: bulkSite, term: 'bulk', limit: 2101 }))).toHaveLength(2101);
      });
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects the limit %s', async (limit) => {
      const calls: ((tx: TenantTx) => Promise<unknown>)[] = [
        (tx) => repo.pagePersonsForSite(tx, 'tenant-a', { limit }),
        (tx) => repo.pageQueryPersons(tx, {}, { limit }),
        (tx) => repo.pageStaleRosterOperations(tx, NOW, { limit }),
        (tx) => repo.pageGroupNames(tx, { limit }),
        (tx) => repo.queryPersons(tx, { limit }),
        (tx) => repo.searchPersons(tx, { siteId: 'tenant-a', term: 'x', limit }),
      ];
      for (const call of calls) await expect(inTenant(call)).rejects.toBeInstanceOf(RangeError);
    });

    it('pages stale roster operations oldest first, ties by operation id', async () => {
      const [first, second, olderThan] = [new Date(2001, 0, 1, 10), new Date(2001, 0, 1, 11), new Date(2001, 0, 2)];
      const ops: string[] = [];
      for (const at of [first, second, first]) {
        repo = createPeopleRepository({ clock: fixedClock(at), schema: handle.schema });
        ops.push((await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId: cfUuid(), payload: '{}' }))).operation_id);
      }
      const opIds = (found: readonly { operation_id: string }[]): string[] => found.map((row) => row.operation_id);
      const expected = [...[ops[0] as string, ops[2] as string].sort(), ops[1] as string];
      const paged = await pages((after: RosterOperationCursor | null) => inTenant((tx) => repo.pageStaleRosterOperations(tx, olderThan, { after, limit: 2 })));
      expect(paged.map(opIds)).toEqual([expected.slice(0, 2), expected.slice(2)]);
      expect(opIds(await inTenant((tx) => repo.listStaleRosterOperations(tx, olderThan)))).toEqual(expected);
    });

    it('pages group-name projection rows by group id', async () => {
      const groupIds = [cfUuid(), cfUuid(), cfUuid()];
      for (const group_id of groupIds) {
        await inTenant((tx) => repo.upsertGroupName(tx, { group_id, site_id: 'tenant-a', group_name: 'G', is_public: 0, deleted: false, aggregate_version: 1 }));
      }
      const paged = await pages((after: string | null) => inTenant((tx) => repo.pageGroupNames(tx, { groupIds, after, limit: 2 })));
      expect(paged.map((page) => page.map((row) => row.group_id))).toEqual([[...groupIds].sort().slice(0, 2), [...groupIds].sort().slice(2)]);
      const all = await pages((after: string | null) => inTenant((tx) => repo.pageGroupNames(tx, { after, limit: 1 })));
      expect(all.flat().map((row) => row.group_id)).toEqual((await inTenant((tx) => repo.listGroupNames(tx))).map((row) => row.group_id));
    });
  });

  describe('ids and sites compared as the SQL Server collation does', () => {
    const spellings: [string, (id: string) => string][] = [
      ['lower-case', (id) => id.toLowerCase()],
      ['trailing-space', (id) => `${id}  `],
    ];
    const archiveOf = (person_id: string) => ({ person_id, siteid: 'tenant-a', effective_from: NOW, archived_by_id: null, archived_by: null });
    const groupOf = (group_id: string) => ({ group_id, site_id: 'tenant-a', group_name: 'Editors', is_public: 0, deleted: false, aggregate_version: 1 });

    it.each(spellings)('reads persons and their child rows under a %s spelling, in their stored spelling', async (_label, spell) => {
      const [stored, other] = [await addPerson(), await addPerson()];
      const userid = stored.userid;
      const address = await inTenant((tx) => repo.insertAddress(tx, { userid }));
      await inTenant((tx) => repo.insert(tx, FAVORITE.table, { favoriteid: cfUuid(), userid, favorite: 'c', type: 'Page', datecreated: NOW }));
      await inTenant((tx) => repo.replaceExtendData(tx, userid, [{ attributeId: 3, row: extendValues('x') }]));
      expect(await inTenant((tx) => repo.findPerson(tx, spell(userid)))).toMatchObject({ userid });
      const found = await inTenant((tx) => repo.findPersons(tx, [spell(other.userid), spell(userid), userid, other.userid]));
      expect(found.map((row) => row.userid)).toEqual([other.userid, userid]);
      expect((await inTenant((tx) => repo.listAddresses(tx, spell(userid)))).map((row) => row.addressid)).toEqual([address.addressid]);
      expect(await inTenant((tx) => repo.findAddress(tx, spell(address.addressid)))).toMatchObject({ addressid: address.addressid, userid });
      expect((await inTenant((tx) => repo.listFavorites(tx, spell(userid)))).map((row) => row.userid)).toEqual([userid]);
      expect((await inTenant((tx) => repo.listExtendData(tx, [spell(userid)]))).map((row) => row.baseid)).toEqual([userid]);
    });

    it.each(spellings)('writes persons, addresses and interests under a %s spelling through their stored keys', async (_label, spell) => {
      const { userid } = await addPerson();
      expect(await inTenant((tx) => repo.updatePerson(tx, spell(userid), personInput({ fname: 'Spelled' })))).toMatchObject({ userid, fname: 'Spelled' });
      const first = await inTenant((tx) => repo.insertAddress(tx, { userid, isprimary: 1 }));
      const second = await inTenant((tx) => repo.insertAddress(tx, { userid, isprimary: null }));
      expect(await inTenant((tx) => repo.updateAddress(tx, spell(second.addressid), { userid, city: 'Bergen' }))).toMatchObject({
        addressid: second.addressid,
        city: 'Bergen',
      });
      await inTenant((tx) => repo.setPrimaryAddress(tx, spell(userid), spell(second.addressid)));
      const primaries = (await inTenant((tx) => repo.listAddresses(tx, userid))).map((row) => [row.addressid, row.isprimary]);
      expect(Object.fromEntries(primaries)).toEqual({ [first.addressid]: 0, [second.addressid]: 1 });
      // The target address is not also taken for another primary, so it is written once.
      expect((await changelog('user_address', second.addressid)).map((row) => row.op)).toEqual(['insert', 'update', 'update']);
      await inTenant((tx) => repo.replaceExtendData(tx, second.addressid, [{ attributeId: 4, row: extendValues('v') }]));
      expect(await inTenant((tx) => repo.deleteAddress(tx, spell(second.addressid)))).toBe(true);
      expect(await inTenant((tx) => repo.findAddress(tx, second.addressid))).toBeNull();
      expect(await inTenant((tx) => repo.listExtendData(tx, [second.addressid]))).toEqual([]);

      const category = cfUuid();
      await inTenant((tx) => repo.replaceInterests(tx, userid, [category, 'KEEP']));
      expect(await inTenant((tx) => repo.replaceInterests(tx, spell(userid), [spell('KEEP')], { scopeCategoryIds: [spell(category)] }))).toEqual([]);
      const held = await rows<{ categoryid: string }>('SELECT categoryid FROM <s>.user_interest WHERE userid = $1', [userid]);
      expect(held.map((row) => row.categoryid.trim())).toEqual(['KEEP']);
    });

    it('matches site ids ignoring case and trailing spaces', async () => {
      const siteid = `Mixed-${cfUuid()}  `;
      const variant = `${siteid.trimEnd().toLowerCase()} `;
      const { userid } = await addPerson({ siteid, lname: 'Sitewise' });
      const subtypeid = cfUuid();
      await inTenant(async (tx) => {
        await repo.insert(tx, 'extend_subtype', { subtypeid, siteid, type: 'User', subtype: 'Default', basetable: 'tusers' });
        await repo.insert(tx, 'extend_attribute', { attributeid: 9001, extendsetid: cfUuid(), siteid, name: 'a', orderno: 1 });
      });
      const ids = (found: readonly { userid: string }[]): string[] => found.map((row) => row.userid);
      expect(ids(await inTenant((tx) => repo.listPersonsForSite(tx, variant)))).toEqual([userid]);
      expect(ids(await inTenant((tx) => repo.searchPersons(tx, { siteId: variant, term: 'sitewise' })))).toEqual([userid]);
      expect(ids(await inTenant((tx) => repo.queryPersons(tx, { siteIds: [variant] })))).toEqual([userid]);
      expect((await inTenant((tx) => repo.listExtendSubtypes(tx, { siteId: variant }))).map((row) => row.subtypeid)).toEqual([subtypeid]);
      expect((await inTenant((tx) => repo.listExtendAttributes(tx, { siteId: variant, attributeIds: [9001] }))).map((row) => row.attributeid)).toEqual([9001]);
    });

    it.each(spellings)('finds archives, open roster operations and group names under a %s spelling', async (_label, spell) => {
      const personId = cfUuid();
      const archived = await inTenant((tx) => repo.insertPersonArchive(tx, archiveOf(personId)));
      expect(await inTenant((tx) => repo.findPersonArchive(tx, spell(personId)))).toMatchObject({ archive_id: archived.archive_id, person_id: personId });
      const userId = cfUuid();
      const op = await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
      expect(await inTenant((tx) => repo.findOpenRosterOperation(tx, spell(userId)))).toMatchObject({ operation_id: op.operation_id, user_id: userId });
      const groupId = cfUuid();
      await inTenant((tx) => repo.upsertGroupName(tx, groupOf(groupId)));
      const renamed = await inTenant((tx) => repo.upsertGroupName(tx, { ...groupOf(spell(groupId)), group_name: 'Writers', aggregate_version: 2 }));
      expect(renamed).toMatchObject({ group_id: groupId, group_name: 'Writers' });
      expect((await inTenant((tx) => repo.listGroupNames(tx, [spell(groupId)]))).map((row) => [row.group_id, row.group_name])).toEqual([[groupId, 'Writers']]);
      expect(await inTenant((tx) => repo.deleteGroupName(tx, spell(groupId)))).toBe(true);
      expect(await inTenant((tx) => repo.listGroupNames(tx, [groupId]))).toEqual([]);
    });

    it.each(spellings)('continues a tombstone recorded under another spelling, keeping one row, under a %s spelling', async (_label, spell) => {
      const userid = cfUuid();
      await inTenant((tx) => repo.recordPersonTombstone(tx, userid, '4'));
      expect(await inTenant((tx) => repo.personTombstoneVersion(tx, spell(userid)))).toBe('4');
      await inTenant((tx) => repo.recordPersonTombstone(tx, spell(userid), '6'));
      const stored = await rows('SELECT userid, row_version FROM <s>.person_tombstone WHERE userid COLLATE <s>.legacy_char_ci = $1::bpchar', [userid]);
      expect(stored).toEqual([{ userid, row_version: '6' }]);
      expect((await addPerson({ userid: spell(userid) })).row_version).toBe('7');
    });

    it('rejects a second key that differs from a stored one only in case', async () => {
      const { userid } = await addPerson();
      await expect(addPerson({ userid: userid.toLowerCase() })).rejects.toMatchObject({ code: '23505', constraint: 'person_tenant_ci_userid_uidx' });
      const { addressid } = await inTenant((tx) => repo.insertAddress(tx, { userid }));
      await expect(inTenant((tx) => repo.insertAddress(tx, { userid, addressid: addressid.toLowerCase() }))).rejects.toMatchObject({
        code: '23505',
        constraint: 'user_address_tenant_ci_addressid_uidx',
      });
      const userId = cfUuid();
      await inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId, payload: '{}' }));
      await expect(inTenant((tx) => repo.insertRosterOperation(tx, { kind: 'admin-update', userId: userId.toLowerCase(), payload: '{}' }))).rejects.toBeInstanceOf(
        RosterOperationOpenError,
      );
      const personId = cfUuid();
      await inTenant((tx) => repo.insertPersonArchive(tx, archiveOf(personId)));
      await expect(inTenant((tx) => repo.insertPersonArchive(tx, archiveOf(personId.toLowerCase())))).rejects.toBeInstanceOf(DuplicateArchiveError);
      const trash = { ...trashRow(), objectid: cfUuid() };
      await inTenant((tx) => repo.insertTrashIfAbsent(tx, trash));
      expect(await inTenant((tx) => repo.insertTrashIfAbsent(tx, { ...trash, objectid: trash.objectid.toLowerCase() }))).toBeNull();
    });

    it.each<[string, (tx: TenantTx) => Promise<unknown>, string, string, string]>([
      ['findPerson', (tx) => repo.findPerson(tx, cfUuid()), 'person', 'person_tenant_ci_userid_uidx', 'userid'],
      ['findPersons', (tx) => repo.findPersons(tx, [cfUuid()]), 'person', 'person_tenant_ci_userid_uidx', 'userid'],
      ['findAddress', (tx) => repo.findAddress(tx, cfUuid()), 'user_address', 'user_address_tenant_ci_addressid_uidx', 'addressid'],
      ['listAddresses', (tx) => repo.listAddresses(tx, cfUuid()), 'user_address', 'user_address_tenant_ci_userid_idx', 'userid'],
      ['replaceTags', (tx) => repo.replaceTags(tx, { userId: cfUuid(), siteId: 'tenant-a', tags: null }), 'user_tag', 'user_tag_tenant_ci_userid_idx', 'userid'],
      ['listFavorites', (tx) => repo.listFavorites(tx, cfUuid()), 'user_favorite', 'user_favorite_tenant_ci_userid_idx', 'userid'],
      ['listExtendData', (tx) => repo.listExtendData(tx, [cfUuid()]), 'extend_data_user_activity', 'extend_data_user_activity_tenant_ci_baseid_idx', 'baseid'],
      ['listExtendSets', (tx) => repo.listExtendSets(tx, [cfUuid()]), 'extend_set', 'extend_set_tenant_ci_subtypeid_idx', 'subtypeid'],
      ['listExtendAttributes', (tx) => repo.listExtendAttributes(tx, { setIds: [cfUuid()] }), 'extend_attribute', 'extend_attribute_tenant_extendsetid_ci_idx', 'extendsetid'],
      ['insertTrashIfAbsent', (tx) => repo.insertTrashIfAbsent(tx, { ...trashRow(), objectid: cfUuid() }), 'trash', 'trash_tenant_ci_objectid_uidx', 'objectid'],
      ['findPersonArchive', (tx) => repo.findPersonArchive(tx, cfUuid()), 'person_archive', 'person_archive_tenant_ci_person_effective_uidx', 'person_id'],
      ['listGroupNames', (tx) => repo.listGroupNames(tx, [cfUuid()]), 'group_name', 'group_name_tenant_ci_group_id_uidx', 'group_id'],
      ['personTombstoneVersion', (tx) => repo.personTombstoneVersion(tx, cfUuid()), 'person_tombstone', 'person_tombstone_tenant_ci_userid_uidx', 'userid'],
    ])('looks %s up through its case-insensitive index', async (_label, call, table, index, column) => {
      const scan = planNodes(await planOf(call, table)).find((node) => node['Index Name'] === index);
      expect(scan?.['Index Cond']).toMatch(new RegExp(`\\b${column}\\b`));
    });
  });
});

function extendValues(stringvalue: string) {
  return { siteid: 'tenant-a', attributevalue: stringvalue, remoteid: null, datetimevalue: null, numericvalue: null, stringvalue };
}
