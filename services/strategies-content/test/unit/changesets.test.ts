/** domain/changesets: bean values, write order over the recording pool, and the cchangesets operations, publish and rollback over throwaway `content` schemas. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { TENANT_A, pgAvailable } from '@opt2/platform/testing';
import {
  CHANGESET_LIST_NEXT_N,
  CHANGESET_LIST_UNBUILT,
  PUBLISH_EVENTS_UNBUILT,
  assignments,
  changesetStruct,
  deleteChangeset,
  listChangesets,
  newChangesetBean,
  publish,
  readChangeset,
  readChangesetInTx,
  removeItem,
  rollback,
  saveChangeset,
  saveChangesetInTx,
  setChangesetValues,
  type ChangesetBean,
} from '../../src/domain/changesets.js';
import { saveContent, saveDraft, type ContentInput } from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type DomainDeps } from '../../src/domain/context.js';
import { deleteMarkers } from '../../src/domain/trash.js';
import { wddx2cfml, type WddxStruct } from '../../src/domain/wddx.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createRecordingDb, type RecordedStatement, type RecordingDb } from '../helpers/app.js';
import { ADMIN, END, HOME, NOW, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { IDS, at, changesetRow } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId } from '../helpers/tokens.js';

const CHANGESET_TRASH = readFileSync(new URL('../fixtures/legacy-trash/changeset-trash.wddx', import.meta.url), 'utf8');
const NOW_MINUTE = new Date(2026, 5, 30, 10, 15, 0, 0);

describe('change-set beans', () => {
  it('sets request values through the bean setters and ignores keys the bean does not persist', () => {
    const bean = setChangesetValues(newChangesetBean(ADMIN, { now: () => NOW }), {
      changesetID: ' CS-1 ',
      Name: '  Summer  ',
      publishDate: '2026-07-01T10:30:45',
      closedate: 'not a date',
      published: 'abc',
      lastUpdateBy: 'x'.repeat(60),
      tags: ['promo', 'sale'],
      muraAction: 'cChangesets.save',
    });
    expect(bean).toMatchObject({ changesetid: 'CS-1', name: 'Summer', publishdate: new Date(2026, 6, 1, 10, 30, 45), closedate: null, published: 0, tags: 'promo,sale' });
    expect(bean.lastupdateby).toHaveLength(50);
    expect(setChangesetValues(bean, { published: '1' }).published).toBe(1);
  });

  it('serializes a stored change set in the key order of the captured legacy trash packet', () => {
    const captured = wddx2cfml(CHANGESET_TRASH) as WddxStruct;
    const stored: ChangesetBean = { ...newChangesetBean(ADMIN, { now: () => NOW }), isnew: 0, siteid: 'default', name: 'n' };
    const values = changesetStruct(stored, deleteMarkers(NOW, { deleteId: 'D' }));
    expect(values.entries.map(([key]) => key)).toEqual(captured.entries.map(([key]) => key));
    expect(Object.fromEntries(values.entries)).toMatchObject({ ISNEW: '0', NAME: 'n', CHANGESETID: stored.changesetid, muraDeleteID: 'D' });
  });

  it('serializes a new bean as init leaves it: numeric isNew, no id yet and the lastUpdate text', () => {
    const values = Object.fromEntries(changesetStruct(newChangesetBean(ADMIN, { now: () => NOW }), deleteMarkers(NOW)).entries);
    expect(values.CHANGESETID).toBe('');
    expect(values.LASTUPDATE).toBe("{ts '2026-06-30 10:15:42'}");
    expect(values.ISNEW).toMatchObject({ text: '1.0' });
  });

  it('names the legacy behaviour it does not run', () => {
    expect(CHANGESET_LIST_NEXT_N).toBe(20);
    expect(CHANGESET_LIST_UNBUILT).toEqual(['contentRenderer.setDynamicContent']);
    expect(PUBLISH_EVENTS_UNBUILT).toHaveLength(3);
  });
});

describe('change-set writes over the recording pool', () => {
  const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
  const S2 = actorFromClaims(
    { iss: 'opt2-local-identity', aud: 'opt2-local', sub: SUBJECT_USER_IDS.s2, sid: subjectSessionId('s2'), epoch: 0, iat: 0, exp: 0, ...SUBJECT_CLAIMS.s2, roles: [...SUBJECT_CLAIMS.s2.roles] },
    'Admin User',
  );
  const DUE = IDS.changesets.scheduledDue;
  const STORED = changesetRow({ changesetid: DUE, name: 'Due Release', publishdate: at('2026-06-30T08:00:00') });
  const SECONDS = new Date(2026, 6, 1, 12, 34, 56, 789);
  const MINUTE = new Date(2026, 6, 1, 12, 34, 0, 0);
  const CHANGESET_SELECT = /^SELECT \* FROM "content"\."changeset" WHERE /;
  const TRACKED_WRITE = /^(INSERT INTO|UPDATE|DELETE FROM) "content"\."(changeset|changeset_category_assign|changeset_tag_assign|trash)" /;
  const locked = (table: string): RegExp => new RegExp(`^SELECT \\* FROM "content"\\."${table}" WHERE .* FOR UPDATE$`);
  const assignment = (n: number, values: { categoryid: string } | { tag: string }) => ({
    tenant_id: TENANT_A.tenantId,
    assignmentid: cfId('K', n),
    changesetid: DUE,
    siteid: TENANT_A.siteId,
    ...values,
  });

  const deps = (db: RecordingDb): DomainDeps => ({
    db,
    repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }),
    clock: TEST_CLOCK,
    config: CONTENT_CONFIG_DEFAULTS,
  });

  /** `<verb> <table>` of each change-set, assignment and trash write, in statement order. */
  const trackedWrites = (db: RecordingDb): string[] =>
    db.writes().flatMap(({ sql }) => {
      const match = TRACKED_WRITE.exec(sql);
      return match === null ? [] : [`${match[1]} ${match[2]}`];
    });

  /** The values the first write starting with `prefix` binds: an INSERT's columns, or an UPDATE's SET list. */
  function boundValues(db: RecordingDb, prefix: string): Record<string, unknown> {
    const statement: RecordedStatement | undefined = db.writes().find(({ sql }) => sql.startsWith(prefix));
    if (statement === undefined) throw new Error(`no write starts with ${prefix}`);
    const insert = /^INSERT INTO \S+ \((.+?)\) VALUES \((.+?)\)/.exec(statement.sql);
    const pairs =
      insert === null
        ? (/ SET (.+?) WHERE /.exec(statement.sql)?.[1] ?? '').split(', ').map((pair) => pair.split(' = '))
        : (insert[1] ?? '').split(', ').map((column, i) => [column, (insert[2] ?? '').split(', ')[i] ?? '']);
    return Object.fromEntries(pairs.map(([column = '', placeholder = '']) => [column.replace(/"/g, ''), statement.params[Number(placeholder.slice(1)) - 1]]));
  }

  it('inserts a bean saved without an id under a new CF UUID, its dates to the minute and created and lastupdate at the clock’s now', async () => {
    const db = createRecordingDb();
    const bean: ChangesetBean = {
      ...newChangesetBean(S2, TEST_CLOCK, {
        siteid: S2.siteId,
        name: 'Autumn',
        publishdate: SECONDS,
        remotepubdate: new Date(2026, 6, 2, 8, 0, 59, 999),
        closedate: new Date(2026, 6, 3, 23, 59, 1, 0),
        categoryid: `${cfId('C', 1)},${cfId('C', 2)}`,
        tags: 'promo,sale',
      }),
      changesetid: '',
    };
    const saved = await withGatedTenant(db, S2.tenantId, (tx) => saveChangesetInTx(tx, deps(db).repository, bean, S2));
    expect(saved).toMatchObject({ errors: {}, lastupdateby: 'Admin User', lastupdatebyid: SUBJECT_USER_IDS.s2 });
    expect(saved.changesetid).toMatch(CF_UUID);
    expect(trackedWrites(db)).toEqual([
      'INSERT INTO changeset',
      'INSERT INTO changeset_category_assign',
      'INSERT INTO changeset_category_assign',
      'INSERT INTO changeset_tag_assign',
      'INSERT INTO changeset_tag_assign',
    ]);
    expect(boundValues(db, 'INSERT INTO "content"."changeset" ')).toMatchObject({
      tenant_id: TENANT_A.tenantId,
      changesetid: saved.changesetid,
      name: 'Autumn',
      publishdate: MINUTE,
      remotepubdate: new Date(2026, 6, 2, 8, 0, 0, 0),
      closedate: new Date(2026, 6, 3, 23, 59, 0, 0),
      created: TEST_CLOCK.now(),
      lastupdate: TEST_CLOCK.now(),
      lastupdateby: 'Admin User',
    });
    expect(db.writes().every((statement) => statement.tenantId === TENANT_A.tenantId)).toBe(true);
  });

  it('updates a stored change set, then deletes each assignment table’s rows before inserting its new ones', async () => {
    const db = createRecordingDb();
    db.respond(CHANGESET_SELECT, [STORED]);
    db.respond(/^UPDATE "content"\."changeset" SET /, [STORED]);
    db.respond(locked('changeset_category_assign'), [assignment(1, { categoryid: cfId('C', 1) }), assignment(2, { categoryid: cfId('C', 2) })]);
    db.respond(locked('changeset_tag_assign'), [assignment(3, { tag: 'old' })]);
    const repository = deps(db).repository;
    const saved = await withGatedTenant(db, S2.tenantId, async (tx) => {
      const read = await readChangesetInTx(tx, repository, { changesetId: DUE }, S2, TEST_CLOCK);
      return saveChangesetInTx(tx, repository, { ...read, name: 'Due Release v2', publishdate: SECONDS, categoryid: cfId('C', 3), tags: 'fresh,new' }, S2);
    });
    expect(saved).toMatchObject({ changesetid: DUE, isnew: 0, errors: {} });
    expect(trackedWrites(db)).toEqual([
      'UPDATE changeset',
      'DELETE FROM changeset_category_assign',
      'DELETE FROM changeset_category_assign',
      'INSERT INTO changeset_category_assign',
      'DELETE FROM changeset_tag_assign',
      'INSERT INTO changeset_tag_assign',
      'INSERT INTO changeset_tag_assign',
    ]);
    const set = boundValues(db, 'UPDATE "content"."changeset" ');
    expect(set).toMatchObject({ name: 'Due Release v2', publishdate: MINUTE, lastupdate: TEST_CLOCK.now(), lastupdatebyid: SUBJECT_USER_IDS.s2 });
    expect(set).not.toHaveProperty('created');
    expect(boundValues(db, 'INSERT INTO "content"."changeset_category_assign" ')).toMatchObject({ changesetid: DUE, categoryid: cfId('C', 3) });
  });

  it('throws a deleted change set in as object class changeset before deleting its row and assignments', async () => {
    const db = createRecordingDb();
    db.respond(CHANGESET_SELECT, [STORED]);
    db.respond(/^DELETE FROM "content"\."changeset" /, [STORED]);
    db.respond(locked('changeset_category_assign'), [assignment(1, { categoryid: cfId('C', 1) })]);
    db.respond(locked('changeset_tag_assign'), [assignment(2, { tag: 'old' })]);
    const deleted = await deleteChangeset(deps(db), S2, DUE);
    expect(trackedWrites(db)).toEqual(['INSERT INTO trash', 'DELETE FROM changeset', 'DELETE FROM changeset_category_assign', 'DELETE FROM changeset_tag_assign']);
    expect(deleted.trash).toMatchObject({ objectid: DUE, objectclass: 'changeset', objectlabel: 'Due Release', siteid: TENANT_A.siteId, deletedby: 'Admin User' });
    expect(deleted.deleted).toMatchObject({ changesetid: DUE });
  });

  it('binds the keyword, the date range ending the day after the stop date and page 2 as LIMIT 20 OFFSET 20', async () => {
    const db = createRecordingDb();
    db.respond(/^SELECT count\(\*\)::integer AS total FROM \(SELECT \* FROM "content"\."changeset" WHERE /, [{ total: 25 }]);
    db.respond(/^SELECT \* FROM "content"\."changeset" WHERE .* LIMIT \$\d+ OFFSET \$\d+$/, [STORED]);
    const listed = await listChangesets(deps(db), S2, { siteid: S2.siteId, keywords: 'Due', startdate: '06/01/2026', stopdate: '06/30/2026', page: '2' });
    expect(listed).toMatchObject({ recordCount: 25, pageIndex: 2, nextN: 20, stopdate: new Date(2026, 6, 1) });
    expect(listed.changesets).toEqual([expect.objectContaining({ changesetid: DUE, name: 'Due Release', isnew: 1 })]);
    const page = db.statements.find(({ sql }) => / LIMIT \$\d+ OFFSET \$\d+$/.test(sql));
    expect(page?.params).toEqual([TENANT_A.tenantId, TENANT_A.siteId, new Date(2026, 5, 1), new Date(2026, 6, 1), expect.stringContaining('Due'), 20, 20]);
  });
});


describe.skipIf(!(await pgAvailable()))('domain/changesets', () => {
  let fx: ContentFixture;
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const changeset = async (id: string) => (await fx.rows('changeset', 'changesetid = $1', [id]))[0];

  /** Saves change set 'Summer' `cfId('S', n)`, an approved 'About' page, and that change set's 'About v2' and new 'Launch' drafts. */
  async function arrangeAssigned(n: number) {
    const changesetId = cfId('S', n);
    await saveChangeset(fx.deps, ADMIN, { changesetid: changesetId, siteid: SITE_ID, name: 'Summer', description: 'd', publishdate: '', tags: 'promo,Sale' });
    const about = await save({ parentid: HOME, type: 'Page', title: 'About', approved: 1 });
    const aboutId = about.bean.contentId();
    const aboutDraft = (await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About v2', changesetid: changesetId })).bean.contentHistId();
    const launch = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Launch', changesetid: changesetId });
    return { changesetId, aboutId, aboutV1: about.bean.contentHistId(), aboutDraft, launchId: launch.bean.contentId(), launchDraft: launch.bean.contentHistId() };
  }

  beforeAll(async () => {
    fx = await createContentFixture('changesets-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('saves a new change set with its tags and redirects; a nameless one returns legacy errors', async () => {
    const CS1 = cfId('S', 1);
    const saved = await saveChangeset(fx.deps, ADMIN, { changesetid: CS1, siteid: SITE_ID, name: 'Summer', description: 'd', publishdate: '', tags: 'promo,Sale' });
    expect(saved).toMatchObject({ redirect: true, errors: {} });
    expect(await changeset(CS1)).toMatchObject({ name: 'Summer', published: 0, publishdate: null, lastupdateby: 'Admin User' });
    expect((await fx.rows('changeset_tag_assign', 'changesetid = $1', [CS1], 'lower(tag)')).map((row) => row.tag)).toEqual(['promo', 'Sale']);
    const invalid = await saveChangeset(fx.deps, ADMIN, { changesetid: cfId('S', 9), siteid: SITE_ID, name: '' });
    expect(invalid).toMatchObject({ redirect: false, errors: { name: "The property named 'name' is not valid" } });
    expect(await changeset(cfId('S', 9))).toBeUndefined();
    await expect(saveChangeset(fx.deps, ADMIN, { name: 'x' })).rejects.toThrow('CHANGESETID');
  });

  it('lists the assigned versions per module, with variations only when configured', async () => {
    const { changesetId: CS1 } = await arrangeAssigned(10);
    const listed = await assignments(fx.deps, ADMIN, { changesetId: CS1 });
    expect(listed.site.map((row) => row.title)).toEqual(['About v2', 'Launch']);
    expect([listed.component, listed.form, listed.variation]).toEqual([[], [], undefined]);
    expect(listed.changeset.name).toBe('Summer');
    expect((await assignments({ ...fx.deps, config: { ...fx.deps.config, variations: true } }, ADMIN, { changesetId: CS1, keywords: 'launch' })).variation).toEqual([]);
    expect((await assignments(fx.deps, ADMIN, { changesetId: CS1, keywords: 'launch' })).site.map((row) => row.title)).toEqual(['Launch']);
  });

  it('skips a publish while an assigned version awaits approval', async () => {
    const { changesetId: CS1, aboutDraft } = await arrangeAssigned(11);
    await fx.inTenant((tx) => fx.repo.approvals.insertRequest(tx, { requestid: cfId('R', 2), contenthistid: aboutDraft, siteid: SITE_ID, chainid: cfId('H', 1), groupid: cfId('G', 1), status: 'Pending' }));
    expect(await publish(fx.deps, ADMIN, SITE, CS1)).toEqual({ published: false, changeset: null, notices: [] });
    expect(await changeset(CS1)).toMatchObject({ published: 0 });
  });

  it('publishes every assigned version, records what it replaced and stamps the change set published now', async () => {
    const { changesetId: CS1, aboutId, aboutV1, aboutDraft, launchId, launchDraft } = await arrangeAssigned(12);
    await fx.inTenant((tx) => fx.repo.approvals.insertRequest(tx, { requestid: cfId('R', 1), contenthistid: aboutDraft, siteid: SITE_ID, chainid: cfId('H', 1), groupid: cfId('G', 1), status: 'Pending' }));
    await fx.inTenant((tx) => fx.repo.approvals.updateRequest(tx, cfId('R', 1), { status: 'Approved' }));
    const result = await publish(fx.deps, ADMIN, SITE, CS1);
    expect(result.published).toBe(true);
    expect((await content('contentid = $1 AND active = 1', [aboutId]))[0]).toMatchObject({ title: 'About v2', approved: 1 });
    expect((await content('contentid = $1 AND active = 1', [launchId]))[0]).toMatchObject({ title: 'Launch', approved: 1 });
    // The iterator's version id is re-saved on the request, then that source version is deleted.
    expect(await content('contenthistid = $1', [aboutDraft])).toEqual([]);
    expect((await fx.rows('approval_request', 'requestid = $1', [cfId('R', 1)]))[0]).toMatchObject({ contenthistid: aboutDraft, status: 'Approved' });
    const rollbacks = await fx.rows('changeset_rollback', 'changesetid = $1', [CS1], 'changesethistid');
    expect(rollbacks.map((row) => [row.changesethistid, row.previoushistid, row.siteid]).sort()).toEqual(
      [[aboutDraft, aboutV1, SITE_ID], [launchDraft, launchDraft, SITE_ID]].sort(),
    );
    expect(await changeset(CS1)).toMatchObject({ published: 1, publishdate: NOW_MINUTE, lastupdateby: 'Admin User' });
    expect(result.changeset).toMatchObject({ published: 1 });
  });

  it('rolls back the replaced versions and resets the change set unpublished', async () => {
    const { changesetId: CS1, aboutId } = await arrangeAssigned(13);
    expect((await publish(fx.deps, ADMIN, SITE, CS1)).published).toBe(true);
    const result = await rollback(fx.deps, ADMIN, SITE, CS1);
    expect((await content('contentid = $1 AND active = 1', [aboutId]))[0]).toMatchObject({ title: 'About', approved: 1 });
    expect(result.changeset).toMatchObject({ published: 0, publishdate: null });
    expect(await changeset(CS1)).toMatchObject({ published: 0, publishdate: null });
  });

  it('hides an item the change set published first when the version it replaced does not exist', async () => {
    const CS3 = cfId('S', 3);
    const launchId = (await save({ parentid: HOME, type: 'Page', title: 'Launch', approved: 1 })).bean.contentId();
    const [active] = await content('contentid = $1 AND active = 1', [launchId]);
    await saveChangeset(fx.deps, ADMIN, { changesetid: CS3, siteid: SITE_ID, name: 'First', published: '1' });
    await withGatedTenant(fx.deps.db, ADMIN.tenantId, (tx) =>
      fx.repo.changesets.insertRollback(tx, { changesetid: CS3, changesethistid: String(active?.contenthistid), previoushistid: cfId('X', 1), siteid: SITE_ID }),
    );
    await rollback(fx.deps, ADMIN, SITE, CS3);
    expect((await content('contentid = $1 AND active = 1', [launchId]))[0]).toMatchObject({ title: 'Launch', approved: 1, display: 0 });
    expect(await changeset(CS3)).toMatchObject({ published: 0 });
  });

  it('removes one version from its change set only', async () => {
    const CS5 = cfId('S', 5);
    await saveChangeset(fx.deps, ADMIN, { changesetid: CS5, siteid: SITE_ID, name: 'Winter', publishdate: '2026-08-15 09:00:00' });
    const aboutId = (await save({ parentid: HOME, type: 'Page', title: 'About', approved: 1 })).bean.contentId();
    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About v3', changesetid: CS5 });
    const changed = await removeItem(fx.deps, ADMIN, CS5, draft.bean.contentHistId());
    expect(changed).toHaveLength(1);
    expect((await content('contenthistid = $1', [draft.bean.contentHistId()]))[0]).toMatchObject({ changesetid: null, title: 'About v3' });
  });

  it('throws the change set in, then deletes it with its assignments', async () => {
    const CS2 = cfId('S', 2);
    await saveChangeset(fx.deps, ADMIN, { changesetid: CS2, siteid: SITE_ID, name: 'Winter', publishdate: '2026-08-15 09:00:00' });
    const deleted = await deleteChangeset(fx.deps, ADMIN, CS2);
    expect(deleted.trash).toMatchObject({ objectid: CS2, objectclass: 'changeset', objecttype: 'changeset', objectsubtype: 'Default', objectlabel: 'Winter', siteid: SITE_ID });
    expect(deleted.trash?.parentid?.trim()).toBe('NA');
    expect(deleted.trash?.objectstring).toContain("<var name='NAME'><string>Winter</string></var>");
    expect(await changeset(CS2)).toBeUndefined();
    expect(await readChangeset(fx.deps, ADMIN, CS2)).toMatchObject({ isnew: 1 });
    const missing = await deleteChangeset(fx.deps, ADMIN, cfId('S', 8));
    expect(missing.deleted).toBeNull();
    expect(missing.trash).toMatchObject({ objectclass: 'changeset', siteid: ADMIN.siteId });
    expect(missing.trash?.objectid).not.toBe(cfId('S', 8));
  });

  it('publishes a Link version without leaving a row Masa’s start-up URL conversion would rewrite', async () => {
    const CS4 = cfId('S', 4);
    await saveChangeset(fx.deps, ADMIN, { changesetid: CS4, siteid: SITE_ID, name: 'Links' });
    const link = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, type: 'Link', title: 'Docs', body: 'https://example.org/docs', changesetid: CS4 });
    expect((await publish(fx.deps, ADMIN, SITE, CS4)).published).toBe(true);
    const [active] = await content('contentid = $1 AND active = 1', [link.bean.contentId()]);
    expect(active).toMatchObject({ type: 'Link', approved: 1, body: 'https://example.org/docs', filename: 'docs' });
    // onApplicationStart_include.cfm:896-899 under SQL Server's case-insensitive, trailing-space-blind comparison.
    expect(await content("lower(rtrim(type)) IN ('file', 'link') AND active = 1 AND body IS NULL AND filename IS NOT NULL")).toEqual([]);
  });
});

describe.skipIf(!(await pgAvailable()))('domain/changesets list', () => {
  let fx: ContentFixture;

  beforeAll(async () => {
    fx = await createContentFixture('changesets-list-test');
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('filters the list by name, dates and tags, 20 per page, with the stop-date-only quirk', async () => {
    await saveChangeset(fx.deps, ADMIN, { changesetid: cfId('S', 1), siteid: SITE_ID, name: 'Summer', description: 'd', publishdate: '2026-06-30 10:15:00', published: '1', tags: 'promo,Sale' });
    await saveChangeset(fx.deps, ADMIN, { changesetid: cfId('S', 2), siteid: SITE_ID, name: 'Winter', publishdate: '2026-08-15 09:00:00' });
    const names = async (rc: Record<string, unknown>) => (await listChangesets(fx.deps, ADMIN, { siteid: SITE_ID, ...rc })).changesets.map((bean) => bean.name);
    // The feed has no ORDER BY, so rows come in id order.
    expect(await names({})).toEqual(['Summer', 'Winter']);
    expect(await names({ keywords: 'UMM' })).toEqual(['Summer']);
    expect(await names({ keywords: 'null' })).toEqual([]);
    expect(await names({ startdate: '08/01/2026' })).toEqual(['Winter']);
    expect(await names({ startdate: '06/01/2026', stopdate: '06/30/2026' })).toEqual(['Summer']);
    expect(await names({ stopdate: '12/31/2026' })).toEqual([]);
    expect(await names({ tags: 'PROMO' })).toEqual(['Summer']);
    expect(await names({ tags: 'nomatch' })).toEqual([]);
    expect(await names({ categoryid: cfId('C', 1) })).toEqual([]);
    const listed = await listChangesets(fx.deps, ADMIN, { siteid: SITE_ID, stopdate: '06/30/2026', page: '5' });
    expect(listed).toMatchObject({ recordCount: 0, pageIndex: 1, nextN: 20, stopdate: new Date(2026, 6, 1) });
    const paged = await listChangesets(fx.deps, ADMIN, { siteid: SITE_ID, page: 3 });
    expect(paged).toMatchObject({ recordCount: 2, pageIndex: 1 });
    expect(paged.changesets[0]).toMatchObject({ isnew: 1, categoryid: '', tags: '' });
    await expect(listChangesets(fx.deps, ADMIN, { siteid: SITE_ID, page: 'x' })).rejects.toThrow(TypeError);
    await expect(listChangesets(fx.deps, ADMIN, { siteid: SITE_ID, page: 0 })).rejects.toThrow(RangeError);
  });
});
