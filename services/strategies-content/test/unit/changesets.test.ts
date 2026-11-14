/** domain/changesets over a throwaway `content` schema: the cchangesets list, save, delete, assignments and removeItem, publish and rollback. */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { pgAvailable } from '@opt2/platform/testing';
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
  removeItem,
  rollback,
  saveChangeset,
  setChangesetValues,
  type ChangesetBean,
} from '../../src/domain/changesets.js';
import { saveContent, saveDraft, type ContentInput } from '../../src/domain/content.js';
import { deleteMarkers } from '../../src/domain/trash.js';
import { wddx2cfml, type WddxStruct } from '../../src/domain/wddx.js';
import { ADMIN, END, HOME, NOW, SITE, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

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

describe.skipIf(!(await pgAvailable()))('domain/changesets', () => {
  let fx: ContentFixture;
  const CS1 = cfId('S', 1);
  const CS2 = cfId('S', 2);
  const CS3 = cfId('S', 3);
  let aboutId = '';
  let aboutV1 = '';
  let aboutDraft = '';
  let launchId = '';
  let launchDraft = '';
  const save = (input: ContentInput) => saveContent(fx.deps, ADMIN, SITE, { siteid: SITE_ID, ...input });
  const content = (where: string, params: unknown[] = []) => fx.rows('content', where, params);
  const changeset = async (id: string) => (await fx.rows('changeset', 'changesetid = $1', [id]))[0];

  beforeAll(async () => {
    fx = await createContentFixture('changesets-test');
    await save({ contentid: HOME, parentid: END, type: 'Page', title: 'Home', approved: 1 });
    const about = await save({ parentid: HOME, type: 'Page', title: 'About', approved: 1 });
    aboutId = about.bean.contentId();
    aboutV1 = about.bean.contentHistId();
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('saves a new change set with its tags and redirects; a nameless one returns legacy errors', async () => {
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
    aboutDraft = (await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About v2', changesetid: CS1 })).bean.contentHistId();
    const launch = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, parentid: HOME, type: 'Page', title: 'Launch', changesetid: CS1 });
    launchId = launch.bean.contentId();
    launchDraft = launch.bean.contentHistId();
    const listed = await assignments(fx.deps, ADMIN, { changesetId: CS1 });
    expect(listed.site.map((row) => row.title)).toEqual(['About v2', 'Launch']);
    expect([listed.component, listed.form, listed.variation]).toEqual([[], [], undefined]);
    expect(listed.changeset.name).toBe('Summer');
    expect((await assignments({ ...fx.deps, config: { ...fx.deps.config, variations: true } }, ADMIN, { changesetId: CS1, keywords: 'launch' })).variation).toEqual([]);
    expect((await assignments(fx.deps, ADMIN, { changesetId: CS1, keywords: 'launch' })).site.map((row) => row.title)).toEqual(['Launch']);
  });

  it('skips a publish while an assigned version awaits approval', async () => {
    await fx.inTenant((tx) => fx.repo.approvals.insertRequest(tx, { requestid: cfId('R', 1), contenthistid: aboutDraft, siteid: SITE_ID, chainid: cfId('H', 1), groupid: cfId('G', 1), status: 'Pending' }));
    expect(await publish(fx.deps, ADMIN, SITE, CS1)).toEqual({ published: false, changeset: null, notices: [] });
    expect(await changeset(CS1)).toMatchObject({ published: 0 });
  });

  it('publishes every assigned version, records what it replaced and stamps the change set published now', async () => {
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

  it('filters the list by name, dates and tags, 20 per page, with the stop-date-only quirk', async () => {
    await saveChangeset(fx.deps, ADMIN, { changesetid: CS2, siteid: SITE_ID, name: 'Winter', publishdate: '2026-08-15 09:00:00' });
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

  it('rolls back the replaced versions and resets the change set unpublished', async () => {
    const result = await rollback(fx.deps, ADMIN, SITE, CS1);
    expect((await content('contentid = $1 AND active = 1', [aboutId]))[0]).toMatchObject({ title: 'About', approved: 1 });
    expect(result.changeset).toMatchObject({ published: 0, publishdate: null });
    expect(await changeset(CS1)).toMatchObject({ published: 0, publishdate: null });
  });

  it('hides an item the change set published first when the version it replaced does not exist', async () => {
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
    const draft = await saveDraft(fx.deps, ADMIN, SITE, { siteid: SITE_ID, contentid: aboutId, parentid: HOME, type: 'Page', title: 'About v3', changesetid: CS2 });
    const changed = await removeItem(fx.deps, ADMIN, CS2, draft.bean.contentHistId());
    expect(changed).toHaveLength(1);
    expect((await content('contenthistid = $1', [draft.bean.contentHistId()]))[0]).toMatchObject({ changesetid: null, title: 'About v3' });
  });

  it('throws the change set in, then deletes it with its assignments', async () => {
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
});
