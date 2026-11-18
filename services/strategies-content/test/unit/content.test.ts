/** Content version writes over the seeded tenant-a tree (GS-CO-01…04, GS-CO-08): saves, drafts, approvals, version deletes, deleteAll, uploads, quick edit and the JSON API delete. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { withGatedTenant } from '@opt2/platform/migration-kit';
import { withTenant } from '@opt2/platform/tenancy';
import { TENANT_A, TENANT_UMBRELLA, pgAvailable, type ThrowawaySchema } from '@opt2/platform/testing';
import {
  approveVersion,
  deleteAll,
  deleteContentEntity,
  deleteHistAll,
  deleteVersion,
  publish,
  saveContent,
  saveDraft,
  saveQuickEdit,
  type ContentDeps,
  type ContentInput,
  type ContentSaveSite,
} from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type ContentConfig } from '../../src/domain/context.js';
import { ImageUploadHaltedError, type UploadedFile } from '../../src/domain/files.js';
import { formatFilename, shouldArchiveFilename, uniqueFilename } from '../../src/legacy/content-urls.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, createMemoryStorage, createRecordingDb, withPgSchema } from '../helpers/app.js';
import { IDS, seedAll, seedMemoryStorage, seedRecordingDb } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, subjectSessionId, type TokenSubject } from '../helpers/tokens.js';
import { uploadedFile } from '../helpers/uploads.js';

type Row = Record<string, unknown>;
type Claims = NonNullable<Parameters<typeof actorFromClaims>[0]>;

const SITE_ID = TENANT_A.siteId;
const { root: ROOT, section: SECTION, pageOne: PAGE_ONE, pageTwo: PAGE_TWO, restricted: RESTRICTED, fileNode: FILE_NODE, linkNode: LINK_NODE } = IDS.content;
const FILENAME_RULES = { urlTitleDelim: '-', allowUnicodeInFilenames: false } as const;

/** tenant-a's site settings: file and category pools in the umbrella site, no site id in URLs. */
const SITE: ContentSaveSite = {
  siteId: SITE_ID,
  site: 'Tenant A',
  locking: 'None',
  contentApprovalScript: '',
  contentRejectionScript: '',
  contentPendingScript: '',
  contentCanceledScript: '',
  contactEmail: '',
  urls: {
    siteId: SITE_ID,
    scheme: 'http',
    domain: 'localhost',
    requestDomain: 'localhost',
    previewDomain: '',
    serverPort: '',
    context: '',
    siteIdInUrls: false,
    indexFileInUrls: false,
    hashUrls: false,
    useSSL: false,
    filePoolId: TENANT_UMBRELLA.siteId,
    configFileAssetPath: '',
    assetPath: '/sites',
    siteAssetPath: '/sites',
    fileStore: 'fileDir',
    legacyIndexFileLocation: false,
    ...FILENAME_RULES,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

/** The actor of a token subject's verified claims, under `fullName`; `userId` overrides the subject's fixed id. */
function actorOf(subject: TokenSubject, fullName: string, userId: string = SUBJECT_USER_IDS[subject]): Actor {
  const { site, tid, roles, s2 } = SUBJECT_CLAIMS[subject];
  const claims: Claims = { iss: 'opt2-local-identity', aud: 'opt2-local', sub: userId, sid: subjectSessionId(subject), tid, site, roles: [...roles], s2, epoch: 1, iat: 0, exp: 0 };
  return actorFromClaims(claims, fullName);
}

const S2 = actorOf('s2', 'Super User');
const EDITOR = actorOf('editor', 'Eda Editor');
const SITE_ADMIN = actorOf('site-admin', 'Sita Admin');
const APPROVER = actorOf('approver', 'Appro Ver');
const SYSTEM_USER = actorOf('system-user', 'Sys User');

const textPart = (fileName: string, contentType = 'text/plain'): UploadedFile =>
  uploadedFile({ fieldName: 'newfile', fileName, contentType }, Buffer.from(`opt2 ${fileName}\n`));

describe('JSON API content delete without the Site Manager module (recording database)', () => {
  it('refuses the delete of a stored item before any write', async () => {
    const db = createRecordingDb();
    seedRecordingDb(db);
    const deps: ContentDeps = { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
    await expect(deleteContentEntity(deps, SYSTEM_USER, SITE, { event: { siteid: SITE_ID, id: SECTION }, validateCsrf: () => true })).rejects.toMatchObject({ type: 'authorization' });
    expect(db.writes()).toEqual([]);
  });
});

/** A throwaway `content` schema holding the seeded datasets, with the deps of the writes under test. */
interface SeededTree {
  handle: ThrowawaySchema;
  deps: ContentDeps;
  /** `deps` with `config` over the configBean defaults. */
  withConfig(config: Partial<ContentConfig>): ContentDeps;
  /** Rows of `content.<table>` matching `where` in `tenantId` (tenant-a by default); `content` rows in insertion order. */
  rows(table: string, where: string, params?: readonly unknown[], tenantId?: string): Promise<Row[]>;
  /** Every stored version of `contentId`, in insertion order. */
  versions(contentId: string): Promise<Row[]>;
}

async function seededTree(): Promise<SeededTree> {
  const handle = await withPgSchema();
  await seedAll(handle);
  const storage = createMemoryStorage();
  seedMemoryStorage(storage);
  const repository = createContentRepository({ clock: TEST_CLOCK, schema: handle.schema });
  const deps: ContentDeps = { db: handle.app, repository, clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS, storage };
  const rows = (table: string, where: string, params: readonly unknown[] = [], tenantId: string = TENANT_A.tenantId): Promise<Row[]> =>
    withTenant(handle.app, tenantId, async (tx) => {
      const order = table === 'content' ? 'tcontent_id' : '1';
      return (await tx.query(`SELECT * FROM ${handle.schema}.${table} WHERE ${where} ORDER BY ${order}`, [...params])).rows as Row[];
    });
  return {
    handle,
    deps,
    withConfig: (config) => ({ ...deps, config: { ...CONTENT_CONFIG_DEFAULTS, ...config } }),
    rows,
    versions: (contentId) => rows('content', 'contentid = $1', [contentId]),
  };
}

/** A seeded tree of its own for the enclosing describe, dropped after it. */
function useSeededTree(): () => SeededTree {
  let tree: SeededTree | undefined;
  beforeAll(async () => {
    tree = await seededTree();
  });
  afterAll(async () => {
    await tree?.handle.drop();
  });
  return () => {
    if (tree === undefined) throw new Error('The seeded tree is created in beforeAll');
    return tree;
  };
}

/** `[title, active, approved]` of each version, in insertion order. */
const states = (versions: readonly Row[]): unknown[][] => versions.map((row) => [row.title, row.active, row.approved]);

const PG = await pgAvailable();

describe.skipIf(!PG)('contentManager.add over the seeded tree', () => {
  const tree = useSeededTree();

  it('saves a new page for an editor as active and approved, with fresh CF ids, its unique filename and the audit columns', async () => {
    const longName = 'Eda Editor With A Display Name Longer Than Fifty Characters';
    const editor = actorOf('editor', longName);
    const saved = await saveContent(tree().deps, editor, SITE, { siteid: SITE_ID, parentid: ROOT, type: 'Page', title: 'Editor News', approved: 1 });
    expect(saved.errors).toEqual({});
    const contentId = saved.bean.contentId();
    expect(isCfUuid(contentId) && isCfUuid(saved.bean.contentHistId())).toBe(true);
    const expected = uniqueFilename({ urlTitle: formatFilename('Editor News', FILENAME_RULES), contentId, parentId: ROOT, parentFilename: '', exists: () => false, ...FILENAME_RULES });
    expect(await tree().versions(contentId)).toEqual([
      expect.objectContaining({
        contenthistid: saved.bean.contentHistId(),
        parentid: ROOT,
        active: 1,
        approved: 1,
        filename: expected.filename,
        urltitle: expected.urlTitle,
        lastupdate: TEST_CLOCK.now(),
        lastupdateby: longName.slice(0, 50),
        lastupdatebyid: editor.userId,
      }),
    ]);
  });

  it('suffixes a filename already used under the parent', async () => {
    const saved = await saveContent(tree().deps, S2, SITE, { siteid: SITE_ID, parentid: SECTION, type: 'Page', title: 'Page Two', approved: 1 });
    const expected = uniqueFilename({
      urlTitle: formatFilename('Page Two', FILENAME_RULES),
      contentId: saved.bean.contentId(),
      parentId: SECTION,
      parentFilename: 'section',
      exists: (candidate) => candidate === 'section/page-two',
      ...FILENAME_RULES,
    });
    expect(expected).toEqual({ filename: 'section/page-two1', urlTitle: 'page-two1' });
    expect(await tree().versions(saved.bean.contentId())).toEqual([expect.objectContaining({ filename: expected.filename, urltitle: expected.urlTitle })]);
  });

  it('publishes an edit as a new active version and archives the version it replaced', async () => {
    const created = await saveContent(tree().deps, S2, SITE, { siteid: SITE_ID, parentid: ROOT, type: 'Page', title: 'Edited', approved: 1 });
    const contentId = created.bean.contentId();
    const edited = await publish(tree().deps, S2, SITE, { siteid: SITE_ID, contentid: contentId, parentid: ROOT, type: 'Page', title: 'Edited Twice' });
    expect(edited.bean.contentId()).toBe(contentId);
    expect(edited.bean.contentHistId()).not.toBe(created.bean.contentHistId());
    expect(states(await tree().versions(contentId))).toEqual([
      ['Edited', 0, 1],
      ['Edited Twice', 1, 1],
    ]);
  });

  it('moves every version to the new filename of an approved rename and archives it, and archives nothing for a draft', async () => {
    const link = { siteid: SITE_ID, contentid: LINK_NODE, parentid: ROOT, type: 'Link', body: 'https://example.org/' };
    const draft = await saveDraft(tree().deps, S2, SITE, { ...link, title: 'Draft Link', urltitle: 'Draft Link' });
    const draftRow = draft.written.find((row) => row.contenthistid === draft.bean.contentHistId());
    expect(draftRow).toMatchObject({ approved: 0, filename: 'example-link' });
    expect(shouldArchiveFilename({ approved: draftRow?.approved ?? null, type: draftRow?.type ?? null })).toBe(false);
    expect(await tree().rows('filename_archive', 'contentid = $1', [LINK_NODE])).toEqual([]);

    const renamed = await publish(tree().deps, S2, SITE, { ...link, title: 'Renamed Link', urltitle: 'Renamed Link' });
    const versions = await tree().versions(LINK_NODE);
    expect(versions.map((row) => [row.contenthistid, row.active, row.approved, row.filename])).toEqual([
      [IDS.hist.linkNodeActive, 0, 1, 'renamed-link'],
      [renamed.bean.contentHistId(), 1, 1, 'renamed-link'],
    ]);
    const active = versions.find((row) => row.contenthistid === renamed.bean.contentHistId());
    expect(active).toMatchObject({ urltitle: 'renamed-link' });
    expect(shouldArchiveFilename({ approved: Number(active?.approved), type: String(active?.type) })).toBe(true);
    expect((await tree().rows('filename_archive', 'contentid = $1', [LINK_NODE])).map((row) => [row.filename, row.siteid])).toEqual([['renamed-link', SITE_ID]]);
  });
});

describe.skipIf(!PG)('drafts, purged drafts and archive trimming', () => {
  const tree = useSeededTree();
  const restricted = (title: string): ContentInput => ({ siteid: SITE_ID, contentid: RESTRICTED, parentid: ROOT, type: 'Page', title });

  it('saves a draft beside the active version, keeps the drafts on a publish without purgeDrafts, purges them and trims the archive to maxArchivedVersions on the next, and keeps every archived version at 0', async () => {
    const draft = await saveDraft(tree().deps, S2, SITE, restricted('Restricted Draft Two'));
    expect(draft.errors).toEqual({});
    expect(states(await tree().versions(RESTRICTED))).toEqual([
      ['Restricted', 1, 1],
      ['Restricted (draft)', 0, 0],
      ['Restricted Draft Two', 0, 0],
    ]);

    await publish(tree().withConfig({ purgeDrafts: false }), S2, SITE, restricted('Restricted v2'));
    expect(states(await tree().versions(RESTRICTED))).toEqual([
      ['Restricted', 0, 1],
      ['Restricted (draft)', 0, 0],
      ['Restricted Draft Two', 0, 0],
      ['Restricted v2', 1, 1],
    ]);

    await publish(tree().withConfig({ purgeDrafts: true, maxArchivedVersions: 1 }), S2, SITE, restricted('Restricted v3'));
    expect(states(await tree().versions(RESTRICTED))).toEqual([
      ['Restricted v2', 0, 1],
      ['Restricted v3', 1, 1],
    ]);

    expect(CONTENT_CONFIG_DEFAULTS.maxArchivedVersions).toBe(0);
    await publish(tree().deps, S2, SITE, restricted('Restricted v4'));
    expect(states(await tree().versions(RESTRICTED))).toEqual([
      ['Restricted v2', 0, 1],
      ['Restricted v3', 0, 1],
      ['Restricted v4', 1, 1],
    ]);
  });
});

// Seeded paths keep the bootstrap's quoted form, whose stored-path crumb read matches no row, so the chain is assigned to a saved folder.
describe.skipIf(!PG)('approval-chain saves', () => {
  const tree = useSeededTree();
  const requestsOf = (contentHistId: string) => tree().rows('approval_request', 'contenthistid = $1', [contentHistId]);
  let folderId = '';

  beforeAll(async () => {
    folderId = (await saveContent(tree().deps, S2, SITE, { siteid: SITE_ID, parentid: ROOT, type: 'Folder', title: 'Chained Folder', approved: 1 })).bean.contentId();
    await withTenant(tree().handle.app, TENANT_A.tenantId, (tx) =>
      tree().deps.repository.approvals.upsertAssignment(tx, { contentid: folderId, siteid: SITE_ID, chainid: IDS.approval.chain }),
    );
  });

  it("raises a pending request from the chain's first group for a non-exempt editor saving under the chained folder", async () => {
    const saved = await saveContent(tree().deps, EDITOR, SITE, { siteid: SITE_ID, parentid: folderId, type: 'Page', title: 'Chained Page', approved: 1 });
    expect(saved.errors).toEqual({});
    expect(states(await tree().versions(saved.bean.contentId()))).toEqual([['Chained Page', 1, 0]]);
    expect(await requestsOf(saved.bean.contentHistId())).toEqual([
      expect.objectContaining({ chainid: IDS.approval.chain, groupid: IDS.groups.approvers, userid: EDITOR.userId, status: 'Pending', siteid: SITE_ID }),
    ]);
  });

  it('saves an exempt site admin approved, without a request', async () => {
    const saved = await saveContent(tree().deps, SITE_ADMIN, SITE, { siteid: SITE_ID, parentid: folderId, type: 'Page', title: 'Admin Page', approved: 1 });
    expect(states(await tree().versions(saved.bean.contentId()))).toEqual([['Admin Page', 1, 1]]);
    expect(await requestsOf(saved.bean.contentHistId())).toEqual([]);
  });

  it("activates the pending version as the chain's last approval does", async () => {
    const pending = await saveContent(tree().deps, EDITOR, SITE, { siteid: SITE_ID, parentid: folderId, type: 'Page', title: 'Chained Page', approved: 1 });
    const pendingId = pending.bean.contentId();
    const pendingHistId = pending.bean.contentHistId();
    expect(await requestsOf(pendingHistId)).toEqual([expect.objectContaining({ status: 'Pending' })]);
    const approved = await withGatedTenant(tree().deps.db, APPROVER.tenantId, (tx) =>
      approveVersion(tx, tree().deps, APPROVER, SITE, pendingHistId, { approvingChainRequest: true }),
    );
    expect(approved.errors).toEqual({});
    expect(approved.bean.contentHistId()).not.toBe(pendingHistId);
    expect(states(await tree().versions(pendingId))).toEqual([
      ['Chained Page', 0, 0],
      ['Chained Page', 1, 1],
    ]);
    expect(await requestsOf(approved.bean.contentHistId())).toEqual([]);
  });
});

describe.skipIf(!PG)('version deletes', () => {
  const tree = useSeededTree();
  const histIds = async (contentId: string): Promise<unknown[]> => (await tree().versions(contentId)).map((row) => row.contenthistid);
  const pdfFile = async (): Promise<Row | undefined> => (await tree().rows('file', 'fileid = $1', [IDS.files.pdf], TENANT_UMBRELLA.tenantId))[0];

  it('deletes one version and keeps a file another version still uses (contentManager.delete)', async () => {
    await deleteVersion(tree().deps, S2, SITE, { contentHistId: IDS.hist.fileNodeDraft, siteId: SITE_ID });
    expect(await histIds(FILE_NODE)).toEqual([IDS.hist.fileNodeActive]);
    expect(await pdfFile()).toMatchObject({ deleted: 0 });
  });

  it('refuses a JSON API delete of the active version and deletes an inactive one', async () => {
    const byHist = (contenthistid: string) => deleteContentEntity(tree().deps, S2, SITE, { event: { siteid: SITE_ID, contenthistid }, validateCsrf: () => true });
    expect(await byHist(IDS.hist.pageTwoActive)).toEqual({ aborted: false });
    expect(await byHist(IDS.hist.pageTwoDraft)).toEqual({ aborted: false });
    expect(await histIds(PAGE_TWO)).toEqual([IDS.hist.pageTwoActive]);
  });

  it('removes the archived and unassigned draft versions, keeping the active and pending change-set ones (deleteHistAll)', async () => {
    const page = { siteid: SITE_ID, contentid: PAGE_ONE, parentid: SECTION, type: 'Page' };
    const published = await publish(tree().deps, S2, SITE, { ...page, title: 'Page One v2' });
    await saveDraft(tree().deps, S2, SITE, { ...page, title: 'Page One Draft v3' });
    expect(await histIds(PAGE_ONE)).toHaveLength(4);
    await deleteHistAll(tree().deps, S2, SITE, { contentId: PAGE_ONE, siteId: SITE_ID });
    const kept = await tree().versions(PAGE_ONE);
    expect(kept.map((row) => [row.contenthistid, row.active, row.changesetid])).toEqual([
      [IDS.hist.pageOneDraft, 0, IDS.changesets.scheduledDue],
      [published.bean.contentHistId(), 1, null],
    ]);
  });

  it('keeps a version pending approval through deleteHistAll', async () => {
    const published = await publish(tree().deps, S2, SITE, { siteid: SITE_ID, contentid: SECTION, parentid: ROOT, type: 'Folder', title: 'Section v2' });
    await deleteHistAll(tree().deps, S2, SITE, { contentId: SECTION, siteId: SITE_ID });
    expect(await histIds(SECTION)).toEqual([IDS.hist.sectionDraft, published.bean.contentHistId()]);
    expect(await tree().rows('approval_request', 'requestid = $1', [IDS.approval.request])).toEqual([expect.objectContaining({ status: 'Pending' })]);
  });
});

describe.skipIf(!PG)('deleteAll of a section', () => {
  const tree = useSeededTree();
  const activeChildren = (parentId: string) => tree().rows('content', 'parentid = $1 AND active = 1', [parentId]);
  const addFile = (fileName: string, contentType?: string) =>
    saveContent(tree().deps, S2, SITE, { siteid: SITE_ID, parentid: SECTION, type: 'File', title: fileName, approved: 1 }, { files: [textPart(fileName, contentType)] });

  it('adds an uploaded File child to a section, halts an image upload, aborts deleteAll of the home page and trashes the section with every descendant', async () => {
    const saved = await addFile('notes.txt');
    expect(saved.errors).toEqual({});
    const uploadedId = saved.bean.contentId();
    const [child] = (await activeChildren(SECTION)).filter((row) => row.type === 'File');
    const uploadedFileId = String(child?.fileid);
    const expected = uniqueFilename({ urlTitle: formatFilename('notes.txt', FILENAME_RULES), contentId: uploadedId, parentId: SECTION, parentFilename: 'section', exists: () => false, ...FILENAME_RULES });
    expect(child).toMatchObject({ contentid: uploadedId, type: 'File', parentid: SECTION, approved: 1, filename: expected.filename, body: 'notes.txt' });
    expect(await tree().rows('file', 'fileid = $1', [uploadedFileId], TENANT_UMBRELLA.tenantId)).toEqual([
      expect.objectContaining({ contentid: uploadedId, filename: 'notes.txt', fileext: 'txt', deleted: 0 }),
    ]);

    const before = await activeChildren(SECTION);
    await expect(addFile('photo.png', 'image/png')).rejects.toBeInstanceOf(ImageUploadHaltedError);
    expect(await activeChildren(SECTION)).toEqual(before);

    expect(await deleteAll(tree().deps, S2, SITE, { contentId: ROOT, siteId: SITE_ID })).toEqual({ aborted: true });
    expect(await tree().rows('trash', 'true')).toEqual([]);

    const nodes = [PAGE_ONE, PAGE_TWO, uploadedId, SECTION];
    expect(await deleteAll(tree().deps, S2, SITE, { contentId: SECTION, siteId: SITE_ID })).toEqual({ aborted: false, topId: ROOT });
    const trash = await tree().rows('trash', 'true', [], TENANT_A.tenantId);
    expect([...trash].sort((a, b) => Number(a.orderno) - Number(b.orderno)).map((row) => [row.objectid, row.objectclass])).toEqual(
      nodes.map((id) => [id, 'content']),
    );
    expect(new Set(trash.map((row) => row.deleteid)).size).toBe(1);
    expect(trash.find((row) => row.objectid === SECTION)).toMatchObject({ parentid: ROOT, siteid: SITE_ID, objectlabel: 'Section', deletedby: 'Super User' });
    expect(await tree().rows('content', 'contentid = ANY($1)', [nodes])).toEqual([]);
    expect(await tree().rows('file', 'fileid = $1', [uploadedFileId], TENANT_UMBRELLA.tenantId)).toEqual([expect.objectContaining({ deleted: 1 })]);
    expect(await tree().rows('file', 'fileid = $1', [IDS.files.pdf], TENANT_UMBRELLA.tenantId)).toEqual([expect.objectContaining({ deleted: 0 })]);
  });
});

describe.skipIf(!PG)('quick edit and the JSON API', () => {
  const tree = useSeededTree();
  const activeOf = async (contentId: string): Promise<Row | undefined> => (await tree().versions(contentId)).find((row) => row.active === 1);
  const quick = (actor: Actor, rc: ContentInput, csrfValid = true) => saveQuickEdit(tree().deps, actor, SITE, { rc: { siteid: SITE_ID, ...rc }, csrfValid });

  it.each([
    ['isnav', { isnav: 0 }, { isnav: 0 }],
    ['display', { display: 0, displaystart: '', displaystop: '', displayinterval: '' }, { display: 0 }],
    ['template', { template: 'two.cfm', childtemplate: 'kid.cfm' }, { template: 'two.cfm', childtemplate: 'kid.cfm' }],
    ['inheritobjects', { inheritobjects: 'Reject' }, { inheritobjects: 'Reject' }],
  ])('saves the %s quick edit as a new approved version, ignoring every other posted value', async (attribute, values, expected) => {
    const before = await activeOf(PAGE_ONE);
    const result = await quick(S2, { contentid: PAGE_ONE, attribute, ...values, title: 'Ignored Title', summary: 'Ignored summary' });
    expect(result?.errors).toEqual({});
    const after = await activeOf(PAGE_ONE);
    expect(after?.contenthistid).not.toBe(before?.contenthistid);
    expect(after).toMatchObject({ ...expected, approved: 1, title: 'Page One', summary: before?.summary ?? null });
    expect((await tree().versions(PAGE_ONE)).find((row) => row.contenthistid === before?.contenthistid)).toMatchObject({ active: 0, approved: 1 });
  });

  it.each([
    ['an item with drafts', S2, { contentid: ROOT, attribute: 'isnav', isnav: 0 }, true],
    ['an invalid token', S2, { contentid: PAGE_ONE, attribute: 'isnav', isnav: 1 }, false],
    ['an attribute outside the whitelist', S2, { contentid: PAGE_ONE, attribute: 'title', title: 'Retitled' }, true],
    ['a reader', APPROVER, { contentid: PAGE_ONE, attribute: 'isnav', isnav: 1 }, true],
  ])('saves nothing for %s', async (_label, actor, rc, csrfValid) => {
    const before = await tree().versions(String(rc.contentid));
    expect(await quick(actor, rc, csrfValid)).toBeNull();
    expect(await tree().versions(String(rc.contentid))).toEqual(before);
  });

  it('refuses a JSON API delete where the actor is neither author nor editor', async () => {
    const before = await tree().versions(PAGE_TWO);
    await expect(deleteContentEntity(tree().deps, APPROVER, SITE, { event: { siteid: SITE_ID, id: PAGE_TWO }, validateCsrf: () => true })).rejects.toMatchObject({ type: 'authorization' });
    expect(await tree().versions(PAGE_TWO)).toEqual(before);
  });

  it("deletes an item by id for its section's editor through deleteAll", async () => {
    const pageId = (await saveContent(tree().deps, S2, SITE, { siteid: SITE_ID, parentid: SECTION, type: 'Page', title: 'Deleted By Id', approved: 1 })).bean.contentId();
    expect(await deleteContentEntity(tree().deps, EDITOR, SITE, { event: { siteid: SITE_ID, id: pageId }, validateCsrf: () => true })).toEqual({ aborted: false });
    expect(await tree().versions(pageId)).toEqual([]);
    expect(await tree().rows('trash', 'objectid = $1', [pageId])).toEqual([expect.objectContaining({ objectclass: 'content', deletedby: 'Eda Editor' })]);
  });
});

