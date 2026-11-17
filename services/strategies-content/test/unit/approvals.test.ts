/** Approval chains and the status-modal actions over an in-memory approval store (GS-CO-09, GS-UI-02). */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { TENANT_A, TENANT_UMBRELLA, assertResponseMatchesOpenApi, type InjectResponse } from '@opt2/platform/testing';
import {
  UndefinedLegacyVariableError,
  approvalAction,
  availableGroups,
  cancelRequest,
  chainAccess,
  deleteChain,
  loadRequest,
  requiresApproval,
  saveChain,
  saveRequest,
  writeAction,
} from '../../src/domain/approvals.js';
import { approveVersion, deleteVersionInTransaction, type ContentDeps, type SaveContentResult } from '../../src/domain/content.js';
import { CONTENT_CONFIG_DEFAULTS, actorFromClaims, type Actor, type MailNotice, type SiteContentSettings } from '../../src/domain/context.js';
import { createContentRepository } from '../../src/repo/repository.js';
import { TEST_CLOCK, buildTestApp, createRecordingDb, type RecordingDb, type TestApp } from '../helpers/app.js';
import { IDS, approvalChainRow, approvalRequestRow, contentSeed, groupProjectionRow, newId, seedRecordingDb, tenantASeed, type TenantSeed } from '../helpers/seed.js';
import { SUBJECT_CLAIMS, SUBJECT_USER_IDS, contentHeaders, subjectSessionId, type TokenSubject } from '../helpers/tokens.js';

// The content save engine behind approveVersion needs PostgreSQL and has its own suites; here both calls act on the store.
vi.mock('../../src/domain/content.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/domain/content.js')>();
  return { ...actual, approveVersion: vi.fn(), deleteVersionInTransaction: vi.fn() };
});

type Row = Record<string, unknown>;
type StoreTable = 'approval_chain' | 'approval_membership' | 'approval_request' | 'approval_action' | 'content';

const STORE_TABLES: readonly StoreTable[] = ['approval_chain', 'approval_membership', 'approval_request', 'approval_action', 'content'];
const KEY: Readonly<Record<StoreTable, string>> = {
  approval_chain: 'chainid',
  approval_membership: 'membershipid',
  approval_request: 'requestid',
  approval_action: 'actiontid',
  content: 'contenthistid',
};
const APPROVAL_STATEMENT = /^(?:SELECT \* FROM|INSERT INTO|UPDATE|DELETE FROM) "content"\."(approval_(?:chain|membership|request|action))"/;
const VERSION_READ = /FROM "content"\."content" tcontent LEFT JOIN/;
const POOL_GROUPS_READ = /FROM "content"\."group_projection" WHERE tenant_id = \$1 AND NOT deleted AND is_public/;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
/** Table definitions of the content repository, the source of every column a returned row holds. */
const DEFINITIONS = createContentRepository({ clock: TEST_CLOCK }).platform;

const SITE_ID = TENANT_A.siteId;
const CHAIN = IDS.approval.chain;
const REQUEST = IDS.approval.request;
const APPROVERS = IDS.groups.approvers;
const EDITORS = IDS.groups.editor;
const DRAFT = IDS.hist.sectionDraft;
const ACTIVATED = 'A2000000-0000-0000-0000000000000099';
const NAME_ERROR = "The property named 'name' is not valid";

/** A notice the activating save returns, which the action passes on unsent. */
const SAVE_NOTICE: MailNotice = {
  kind: 'content-notify',
  to: 'editor@example.org',
  from: 'admin@example.org',
  subject: 'Section approved',
  body: 'Section is live.',
  siteId: SITE_ID,
};

const SITE: SiteContentSettings = {
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
    urlTitleDelim: '-',
    allowUnicodeInFilenames: false,
    placeholderImgId: '',
    placeholderImgExt: '',
    directImages: true,
  },
};

type ScriptSetting = 'contentApprovalScript' | 'contentRejectionScript' | 'contentPendingScript' | 'contentCanceledScript';

/** The site with `setting` holding a mail script. */
const scripted = (setting: ScriptSetting): SiteContentSettings => ({ ...SITE, [setting]: 'Review #returnURL#' });

/** The tenant-a groups beyond the seed's chain members, and the umbrella public pool's groups, listed out of name order. */
const EXTRA_GROUPS = {
  zeta: newId(),
  authors: newId(),
  members: newId(),
  beta: newId(),
};

/** Every content dataset, plus the extra groups `availableGroups` lists. */
const SEEDS: readonly TenantSeed[] = [
  ...contentSeed(),
  {
    tenant: TENANT_A,
    rows: [
      groupProjectionRow({ group_id: EXTRA_GROUPS.zeta, group_name: 'Zeta Team' }),
      groupProjectionRow({ group_id: EXTRA_GROUPS.authors, group_name: 'authors' }),
    ].map((row) => ({ table: DEFINITIONS.definition('group_projection'), row })),
  },
  {
    tenant: TENANT_UMBRELLA,
    rows: [
      groupProjectionRow({ tenant_id: TENANT_UMBRELLA.tenantId, group_id: EXTRA_GROUPS.members, site_id: TENANT_UMBRELLA.siteId, group_name: 'Members', is_public: 1 }),
      groupProjectionRow({ tenant_id: TENANT_UMBRELLA.tenantId, group_id: EXTRA_GROUPS.beta, site_id: TENANT_UMBRELLA.siteId, group_name: 'beta Club', is_public: 1 }),
    ].map((row) => ({ table: DEFINITIONS.definition('group_projection'), row })),
  },
];

/** An id as SQL Server's `=` compares it: case-insensitive, trailing spaces ignored. */
const idKey = (value: unknown): string => String(value).replace(/ +$/, '').toLowerCase();

/** Rows of the approval tables and tenant-a's content versions, answering the repository's statements by their WHERE terms. */
interface ApprovalStore {
  /** Copies of the stored rows of `table`, in storage order. */
  rows(table: StoreTable): Row[];
  /** Stores a row built beyond the seed. */
  add(table: StoreTable, row: Row): void;
  /** Sets `changes` on the stored rows of `table` that `match` selects. */
  patch(table: StoreTable, match: (row: Row) => boolean, changes: Row): void;
  /** Removes the stored rows of `table` that `match` selects. */
  remove(table: StoreTable, match: (row: Row) => boolean): void;
}

/** The predicate of the WHERE terms the approval statements use: id lists, column equalities and replaceChainMemberships' request filters. */
function whereOf(where: string, params: readonly unknown[]): (row: Row) => boolean {
  const tests: Array<(row: Row) => boolean> = [];
  for (const [, column = '', n] of where.matchAll(/(\w+) = ANY\(\$(\d+)::bpchar\[\]\)/g)) {
    const ids = (params[Number(n) - 1] as readonly unknown[]).map(idKey);
    tests.push((row) => row[column] !== null && ids.includes(idKey(row[column])));
  }
  for (const [, column = '', n] of where.matchAll(/"?(\w+)"? = \$(\d+)(?![\d:])/g)) {
    tests.push((row) => row[column] === params[Number(n) - 1]);
  }
  const unlike = /lower\(rtrim\(groupid\)\) <> lower\(rtrim\(\$(\d+)::text\)\)/.exec(where);
  if (unlike !== null) {
    const bound = idKey(params[Number(unlike[1]) - 1]);
    tests.push((row) => row.groupid !== null && idKey(row.groupid) !== bound);
  }
  if (where.includes("(groupid IS NULL OR rtrim(groupid) = '')")) {
    tests.push((row) => row.groupid === null || idKey(row.groupid) === '');
  }
  return (row) => tests.every((test) => test(row));
}

/** Membership order (`orderno` NULLS FIRST, then id) or key order, as the statement's ORDER BY asks. */
function sortFor(table: StoreTable, sql: string): (a: Row, b: Row) => number {
  const key = (row: Row): string => idKey(row[KEY[table]]);
  const byKey = (a: Row, b: Row): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  if (!/ORDER BY orderno/.test(sql)) return byKey;
  const order = (row: Row): number => (typeof row.orderno === 'number' ? row.orderno : Number.NEGATIVE_INFINITY);
  return (a, b) => order(a) - order(b) || byKey(a, b);
}

/** Creates a store over tenant-a's seeded approval and content rows and registers its responders on `db`, above the seed's. */
function createApprovalStore(db: RecordingDb): ApprovalStore {
  const tables = new Map<StoreTable, Row[]>(STORE_TABLES.map((table) => [table, []]));
  const held = (table: StoreTable): Row[] => tables.get(table) ?? [];
  for (const { table, row } of tenantASeed().rows) {
    if ((STORE_TABLES as readonly string[]).includes(table.table)) held(table.table as StoreTable).push({ ...row });
  }
  const blank = (table: StoreTable): Row => Object.fromEntries(DEFINITIONS.definition(table).columns.map((column) => [column.name, null]));

  db.respond(APPROVAL_STATEMENT, (params, sql) => {
    const table = APPROVAL_STATEMENT.exec(sql)?.[1] as StoreTable;
    const rows = held(table);
    const insert = /^INSERT INTO \S+ \((.+?)\) VALUES /.exec(sql);
    if (insert?.[1] !== undefined) {
      const columns = insert[1].split(', ').map((column) => column.replace(/"/g, ''));
      const row = { ...blank(table), ...Object.fromEntries(columns.map((column, i) => [column, params[i] ?? null])) };
      rows.push(row);
      return [{ ...row }];
    }
    const update = /^UPDATE \S+ SET (.+) WHERE (.+) RETURNING \*$/.exec(sql);
    if (update?.[1] !== undefined && update[2] !== undefined) {
      const changes = Object.fromEntries([...update[1].matchAll(/"(\w+)" = \$(\d+)/g)].map(([, column = '', n]) => [column, params[Number(n) - 1]]));
      return rows.filter(whereOf(update[2], params)).map((row) => ({ ...Object.assign(row, changes) }));
    }
    const remove = /^DELETE FROM \S+ WHERE (.+) RETURNING \*$/.exec(sql);
    if (remove?.[1] !== undefined) {
      const gone = rows.filter(whereOf(remove[1], params));
      tables.set(table, rows.filter((row) => !gone.includes(row)));
      return gone.map((row) => ({ ...row }));
    }
    const body = sql.replace(/ FOR UPDATE$/, '');
    const where = / WHERE (.*?)(?: ORDER BY .*)?$/.exec(body)?.[1] ?? '';
    const limit = / LIMIT (\d+)$/.exec(body)?.[1];
    const found = rows.filter(whereOf(where, params)).sort(sortFor(table, body));
    return (limit === undefined ? found : found.slice(0, Number(limit))).map((row) => ({ ...row }));
  });

  // readVersion selects by contenthistid; readActive by contentid, active versions only.
  db.respond(VERSION_READ, (params, sql, ctx) => {
    const ids = (params[0] as readonly unknown[]).map(idKey);
    const byContent = /WHERE tcontent\.contentid = ANY/.test(sql);
    return held('content')
      .filter((row) => row.tenant_id === ctx.tenantId && ids.includes(idKey(byContent ? row.contentid : row.contenthistid)) && (!byContent || row.active === 1))
      .map((row) => ({ ...row, filesize: null, contenttype: null, contentsubtype: null, fileext: null, assocfilename: null, approvalstatus: null, requestid: null, approvalgroupid: null }));
  });

  return {
    rows: (table) => held(table).map((row) => ({ ...row })),
    add: (table, row) => {
      held(table).push({ ...blank(table), ...row });
    },
    patch: (table, match, changes) => {
      for (const row of held(table).filter(match)) Object.assign(row, changes);
    },
    remove: (table, match) => {
      tables.set(table, held(table).filter((row) => !match(row)));
    },
  };
}

/** The actor of `subject`'s verified token, with the audit name `fullName`. */
function actorOf(subject: TokenSubject, fullName = 'Ada Lovelace'): Actor {
  const claims = SUBJECT_CLAIMS[subject];
  return actorFromClaims(
    {
      iss: 'opt2-local-identity',
      aud: 'opt2-local',
      sub: SUBJECT_USER_IDS[subject],
      sid: subjectSessionId(subject),
      tid: claims.tid,
      site: claims.site,
      roles: [...claims.roles],
      s2: claims.s2,
      epoch: 1,
      iat: 0,
      exp: 0,
    },
    fullName,
  );
}

const APPROVER = actorOf('approver');

let db: RecordingDb;
let store: ApprovalStore;
let deps: ContentDeps;

/** The stored request of `requestId`. */
const requestRow = (requestId: string = REQUEST): Row | undefined => store.rows('approval_request').find((row) => row.requestid === requestId);

/** The approval-table writes recorded since the last `clear`. */
const approvalWrites = (): string[] => db.writes().map((statement) => statement.sql).filter((sql) => /"content"\."approval_/.test(sql));

/** The transaction control statements recorded since the last `clear`. */
const transactionControl = (): string[] => db.statements.map((statement) => statement.sql).filter((sql) => /^(COMMIT|ROLLBACK)$/.test(sql));

type Tx = Parameters<Parameters<RecordingDb['withTenant']>[1]>[0];

/** Runs `fn` in one tenant-a transaction of the recording database. */
const inTenantA = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.withTenant(TENANT_A.tenantId, fn);

beforeEach(() => {
  db = createRecordingDb();
  seedRecordingDb(db, SEEDS);
  store = createApprovalStore(db);
  deps = { db, repository: createContentRepository({ clock: TEST_CLOCK, schema: db.schema }), clock: TEST_CLOCK, config: CONTENT_CONFIG_DEFAULTS };
  // The activating save writes a new active version of the item; the source version stays until deleteVersion removes it.
  vi.mocked(approveVersion).mockReset().mockImplementation(async (_tx, _deps, _actor, _site, contentHistId) => {
    const source = store.rows('content').find((row) => idKey(row.contenthistid) === idKey(contentHistId));
    if (source === undefined) throw new Error(`no version ${contentHistId}`);
    store.patch('content', (row) => row.contentid === source.contentid && row.active === 1, { active: 0 });
    store.add('content', { ...source, contenthistid: ACTIVATED, active: 1, approved: 1 });
    return { bean: { contentHistId: () => ACTIVATED } as unknown as SaveContentResult['bean'], errors: {}, notices: [SAVE_NOTICE], refused: false, written: [] };
  });
  vi.mocked(deleteVersionInTransaction).mockReset().mockImplementation(async (_tx, _deps, _actor, _site, args) => {
    store.remove('content', (row) => idKey(row.contenthistid) === idKey(args.contentHistId));
  });
});

describe('requiresApproval', () => {
  const crumb = { chainid: CHAIN, exemptid: null };

  it.each<TokenSubject>(['s2', 'site-admin'])('exempts %s while exemptions apply, and requires approval without them', async (subject) => {
    const actor = actorOf(subject);
    expect(await inTenantA((tx) => requiresApproval(tx, deps.repository, actor, [crumb], { groupIds: [] }))).toEqual({ required: false, chainId: '' });
    expect(await inTenantA((tx) => requiresApproval(tx, deps.repository, actor, [crumb], { groupIds: [] }, false))).toEqual({ required: true, chainId: CHAIN });
  });

  it('lets the first crumb, node first, whose chain is stored decide, reading no chain beyond it', async () => {
    const later = newId();
    store.add('approval_chain', approvalChainRow({ chainid: later }));
    const missing = newId();
    const crumbs = [{ chainid: null, exemptid: null }, { chainid: missing, exemptid: APPROVERS }, crumb, { chainid: later, exemptid: null }];
    db.clear();
    expect(await inTenantA((tx) => requiresApproval(tx, deps.repository, APPROVER, crumbs, { groupIds: [APPROVERS] }))).toEqual({ required: true, chainId: CHAIN });
    const lookups = db.statements.filter((statement) => /^SELECT \* FROM "content"\."approval_chain"/.test(statement.sql)).map((statement) => statement.params[1]);
    expect(lookups).toEqual([
      [missing, missing.toLowerCase()],
      [CHAIN, CHAIN.toLowerCase()],
    ]);
  });

  it.each([
    ['exempts a member of one of the crumb\u2019s exempt groups', [APPROVERS], { required: false, chainId: '' }],
    ['requires approval of a non-member', [newId()], { required: true, chainId: CHAIN }],
  ])('%s', async (_label, groupIds, expected) => {
    const crumbs = [{ chainid: CHAIN, exemptid: `${EDITORS},${APPROVERS}` }];
    expect(await inTenantA((tx) => requiresApproval(tx, deps.repository, APPROVER, crumbs, { groupIds }))).toEqual(expected);
  });

  it('requires nothing when no crumb names a stored chain', async () => {
    const crumbs = [{ chainid: '', exemptid: null }, { chainid: newId(), exemptid: null }];
    expect(await inTenantA((tx) => requiresApproval(tx, deps.repository, APPROVER, crumbs, { groupIds: [] }))).toEqual({ required: false, chainId: '' });
  });
});

describe('saveRequest', () => {
  const histId = newId();

  it('starts a request without a group at the chain\u2019s orderno 1 membership and sends no Pending mail without a pending script', async () => {
    const saved = await inTenantA(async (tx) => {
      const { values } = await loadRequest(tx, deps.repository, { contentHistId: histId, chainId: CHAIN, siteId: SITE_ID });
      return saveRequest(tx, deps.repository, { ...values, userid: APPROVER.userId }, APPROVER, SITE);
    });
    expect(saved).toEqual({
      requestid: expect.stringMatching(CF_UUID),
      contenthistid: histId,
      chainid: CHAIN,
      siteid: SITE_ID,
      userid: APPROVER.userId,
      groupid: APPROVERS,
      status: 'Pending',
      created: TEST_CLOCK.now(),
    });
    expect(requestRow(saved.requestid)).toMatchObject({ groupid: APPROVERS, status: 'Pending' });
  });

  it('fails before writing when the pending script is set, as legacy sendActionMessage reads the undefined approvalHistory', async () => {
    db.clear();
    const saving = inTenantA(async (tx) => {
      const { values } = await loadRequest(tx, deps.repository, { contentHistId: histId, chainId: CHAIN, siteId: SITE_ID });
      return saveRequest(tx, deps.repository, values, APPROVER, scripted('contentPendingScript'));
    });
    await expect(saving).rejects.toMatchObject({ name: 'UndefinedLegacyVariableError', variable: 'APPROVALHISTORY' });
    expect(approvalWrites()).toEqual([]);
    expect(store.rows('approval_request').map((row) => row.contenthistid)).not.toContain(histId);
  });
});


describe('approvalAction', () => {
  /** The preview link approvalaction.cfm builds for `histId` from the item's active version (`section`). */
  const previewOf = (histId: string): string => `/section/?previewid=${histId}`;
  const act = (action: string, comment = 'Reviewed', site: SiteContentSettings = SITE, requestId: string = REQUEST) =>
    approvalAction(deps, APPROVER, site, { requestId, action, comment });
  const atLastGroup = (): void => store.patch('approval_request', (row) => row.requestid === REQUEST, { groupid: EDITORS });

  it('approve at group 1 of 2 records the group\u2019s Approval and moves the request to group 2, still Pending, leaving the version inactive', async () => {
    const versions = store.rows('content');
    const result = await act('approve', 'Looks good');
    expect(result).toEqual({ value: { contenthistid: DRAFT, previewurl: previewOf(DRAFT) }, errors: {}, notices: [] });
    expect(store.rows('approval_action')).toEqual([
      expect.objectContaining({ requestid: REQUEST, groupid: APPROVERS, chainid: CHAIN, actiontype: 'Approval', comments: 'Looks good', userid: APPROVER.userId }),
    ]);
    expect(requestRow()).toMatchObject({ groupid: EDITORS, status: 'Pending', contenthistid: DRAFT });
    expect(approveVersion).not.toHaveBeenCalled();
    expect(store.rows('content')).toEqual(versions);
  });

  it('approve at the last group makes the request Approved, activates the version through approveVersion and deletes the inactive source', async () => {
    atLastGroup();
    const result = await act('approve');
    expect(result).toEqual({ value: { contenthistid: ACTIVATED, previewurl: previewOf(ACTIVATED) }, errors: {}, notices: [SAVE_NOTICE] });
    expect(approveVersion).toHaveBeenCalledWith(expect.anything(), deps, APPROVER, SITE, DRAFT, { approvingChainRequest: true });
    expect(deleteVersionInTransaction).toHaveBeenCalledWith(expect.anything(), deps, APPROVER, SITE, { contentHistId: DRAFT, siteId: SITE_ID });
    expect(requestRow()).toMatchObject({ groupid: EDITORS, status: 'Approved', contenthistid: ACTIVATED });
    expect(store.rows('approval_action')).toEqual([expect.objectContaining({ groupid: EDITORS, actiontype: 'Approval' })]);
    const section = store.rows('content').filter((row) => row.contentid === IDS.content.section);
    expect(section.map((row) => [row.contenthistid, row.active])).toEqual([
      [IDS.hist.sectionActive, 0],
      [ACTIVATED, 1],
    ]);
  });

  it('approve on a chain without memberships makes the request Approved and activates the version, keeping the source', async () => {
    const chainId = newId();
    const requestId = newId();
    store.add('approval_chain', approvalChainRow({ chainid: chainId }));
    store.add('approval_request', approvalRequestRow({ requestid: requestId, chainid: chainId, contenthistid: DRAFT, groupid: APPROVERS }));
    expect((await act('approve', '', SITE, requestId)).value.contenthistid).toBe(ACTIVATED);
    expect(approveVersion).toHaveBeenCalledTimes(1);
    expect(deleteVersionInTransaction).not.toHaveBeenCalled();
    expect(requestRow(requestId)).toMatchObject({ status: 'Approved', contenthistid: ACTIVATED });
  });

  it('approve at the last group of a version in a change set makes the request Approved without activating it', async () => {
    atLastGroup();
    store.patch('content', (row) => row.contenthistid === DRAFT, { changesetid: IDS.changesets.scheduledFuture });
    expect((await act('approve')).value).toEqual({ contenthistid: DRAFT, previewurl: previewOf(DRAFT) });
    expect(approveVersion).not.toHaveBeenCalled();
    expect(requestRow()).toMatchObject({ status: 'Approved', contenthistid: DRAFT });
  });

  it.each([
    ['a request that is not Pending', { status: 'Approved' }, 0],
    ['a request whose group left the chain', { groupid: newId() }, 1],
  ])('approve of %s raises the undefined CONTENT variable once the writes before it are committed', async (_label, changes, actions) => {
    store.patch('approval_request', (row) => row.requestid === REQUEST, changes);
    db.clear();
    await expect(act('approve')).rejects.toMatchObject({ name: 'UndefinedLegacyVariableError', variable: 'CONTENT' });
    expect(store.rows('approval_action')).toHaveLength(actions);
    expect(transactionControl()).toEqual(['COMMIT']);
  });

  it('raises the activating save\u2019s afterCommitError once the approval is committed', async () => {
    atLastGroup();
    const failure = new Error('raised after commit');
    vi.mocked(approveVersion).mockResolvedValueOnce({
      bean: { contentHistId: () => DRAFT } as unknown as SaveContentResult['bean'],
      errors: {},
      notices: [],
      refused: false,
      written: [],
      afterCommitError: failure,
    });
    db.clear();
    await expect(act('approve')).rejects.toBe(failure);
    expect(requestRow()).toMatchObject({ status: 'Approved', contenthistid: DRAFT });
    expect(transactionControl()).toEqual(['COMMIT']);
  });

  it.each(['reject', 'decline'])('%s records the group\u2019s Rejection and makes the request Rejected, leaving the version untouched', async (action) => {
    const versions = store.rows('content');
    expect(await act(action, 'Needs work')).toEqual({ value: { contenthistid: DRAFT, previewurl: previewOf(DRAFT) }, errors: {}, notices: [] });
    expect(store.rows('approval_action')).toEqual([
      expect.objectContaining({ requestid: REQUEST, groupid: APPROVERS, actiontype: 'Rejection', comments: 'Needs work', userid: APPROVER.userId }),
    ]);
    expect(requestRow()).toMatchObject({ groupid: APPROVERS, status: 'Rejected', contenthistid: DRAFT });
    expect(approveVersion).not.toHaveBeenCalled();
    expect(store.rows('content')).toEqual(versions);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['approvalAction(cancel)', () => act('Cancel', 'Withdrawn')],
    [
      'cancelRequest',
      () =>
        inTenantA(async (tx) => {
          const { values } = await loadRequest(tx, deps.repository, { requestId: REQUEST });
          return cancelRequest(tx, deps.repository, values, 'Withdrawn', APPROVER, SITE);
        }),
    ],
  ])('%s records the group\u2019s Cancelation and makes the request Canceled', async (_label, cancel) => {
    await cancel();
    expect(store.rows('approval_action')).toEqual([
      expect.objectContaining({ requestid: REQUEST, groupid: APPROVERS, actiontype: 'Cancelation', comments: 'Withdrawn', userid: APPROVER.userId }),
    ]);
    expect(requestRow()).toMatchObject({ status: 'Canceled', contenthistid: DRAFT });
  });

  it.each(['reject', 'cancel'])('%s leaves a request that is not Pending, and its actions, unchanged', async (action) => {
    store.patch('approval_request', (row) => row.requestid === REQUEST, { status: 'Approved' });
    db.clear();
    expect((await act(action)).value.contenthistid).toBe(DRAFT);
    expect(approvalWrites()).toEqual([]);
    expect(requestRow()?.status).toBe('Approved');
  });

  it.each<[string, ScriptSetting, string, string]>([
    ['approve', 'contentApprovalScript', 'Approved', 'Approval'],
    ['reject', 'contentRejectionScript', 'Rejected', 'Rejection'],
    ['cancel', 'contentCanceledScript', 'Canceled', 'Cancelation'],
  ])('%s with %s set commits its writes, then fails reading approvalHistory as legacy sendActionMessage does', async (action, setting, status, actionType) => {
    atLastGroup();
    db.clear();
    await expect(act(action, '', scripted(setting))).rejects.toBeInstanceOf(UndefinedLegacyVariableError);
    expect(requestRow()?.status).toBe(status);
    expect(store.rows('approval_action').map((row) => row.actiontype)).toEqual([actionType]);
    expect(transactionControl()).toEqual(['COMMIT']);
  });
});

describe('writeAction', () => {
  it('inserts a group\u2019s first action keyed by actiontid with its comments and user, then overwrites that row by actiontid', async () => {
    const write = { requestId: REQUEST, groupId: APPROVERS, chainId: CHAIN };
    const [first, second] = await inTenantA(async (tx) => [
      await writeAction(tx, deps.repository, { ...write, actionType: 'Approval', comments: 'first', userId: APPROVER.userId }),
      await writeAction(tx, deps.repository, { ...write, groupId: APPROVERS.toLowerCase(), actionType: 'Rejection', comments: 'second', userId: SUBJECT_USER_IDS.s2 }),
    ]);
    expect(first).toMatchObject({ actiontid: expect.stringMatching(CF_UUID), actiontype: 'Approval', comments: 'first', userid: APPROVER.userId, created: TEST_CLOCK.now() });
    expect(second).toMatchObject({ actiontid: first?.actiontid, actiontype: 'Rejection', comments: 'second', userid: SUBJECT_USER_IDS.s2 });
    expect(store.rows('approval_action')).toEqual([expect.objectContaining({ actiontid: first?.actiontid, comments: 'second', siteid: null, parentid: null })]);
    const updates = db.writes().filter((statement) => /^UPDATE "content"\."approval_action"/.test(statement.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sql).toMatch(/ WHERE "tenant_id" = \$\d+ AND "actiontid" = \$\d+ RETURNING \*$/);
    expect(updates[0]?.params.at(-1)).toBe(first?.actiontid);
  });
});


describe('saveChain', () => {
  const chainWrites = (): string[] => approvalWrites().filter((sql) => /"approval_chain"/.test(sql));
  const membershipsOf = (chainId: string): Row[] =>
    store.rows('approval_membership').filter((row) => row.chainid === chainId).sort((a, b) => Number(a.orderno) - Number(b.orderno));

  it('stamps lastupdate and the audit name cut to 50 characters, keeps created, upserts listed memberships by position and removes the unlisted', async () => {
    const actor = actorOf('s2', 'X'.repeat(60));
    const created = store.rows('approval_chain').find((row) => row.chainid === CHAIN)?.created;
    const added = newId();
    const result = await saveChain(deps, actor, { chainId: CHAIN, siteId: SITE_ID, name: 'Two Step', description: 'Section review', groupId: `${EDITORS},${added}` });
    expect(result).toEqual({
      value: { chainid: CHAIN, siteid: SITE_ID, name: 'Two Step', description: 'Section review', created, lastupdate: TEST_CLOCK.now(), lastupdateby: 'X'.repeat(50), lastupdatebyid: actor.userId },
      errors: {},
      notices: [],
    });
    expect(membershipsOf(CHAIN).map((row) => [row.membershipid, row.groupid, row.orderno])).toEqual([
      [IDS.approval.membershipTwo, EDITORS, 1],
      [expect.stringMatching(CF_UUID), added, 2],
    ]);
    expect(store.rows('approval_chain').find((row) => row.chainid === CHAIN)).toMatchObject({ name: 'Two Step', lastupdate: TEST_CLOCK.now() });
  });

  it.each([
    ['a single listed group leaves its own requests unwritten', APPROVERS, ['editors', 'ungrouped']],
    [
      'two listed groups compare every request with the joined list, so the second group\u2019s request moves too and the first group\u2019s, already holding it, stays unwritten',
      `${APPROVERS},${EDITORS}`,
      ['editors', 'ungrouped'],
    ],
  ])('re-points the chain\u2019s requests to the first group: %s, binding the list as one value', async (_label, groupId, rewritten) => {
    const ids = { seeded: REQUEST, editors: newId(), ungrouped: newId(), otherChain: newId() };
    store.add('approval_request', approvalRequestRow({ requestid: ids.editors, chainid: CHAIN, groupid: EDITORS }));
    store.add('approval_request', approvalRequestRow({ requestid: ids.ungrouped, chainid: CHAIN, groupid: null }));
    store.add('approval_request', approvalRequestRow({ requestid: ids.otherChain, chainid: newId(), groupid: EDITORS }));
    db.clear();
    await saveChain(deps, actorOf('site-admin'), { chainId: CHAIN, siteId: SITE_ID, name: 'Chain', description: '', groupId });
    const locks = db.statements.filter((statement) => /^SELECT \* FROM "content"\."approval_request" WHERE tenant_id = \$1 AND \(.* FOR UPDATE$/.test(statement.sql));
    expect(locks.map((statement) => statement.params)).toEqual([
      [TENANT_A.tenantId, [CHAIN, CHAIN.toLowerCase()], groupId],
      [TENANT_A.tenantId, [CHAIN, CHAIN.toLowerCase()]],
    ]);
    expect(locks[0]?.sql).toContain('AND groupid IS NOT NULL AND lower(rtrim(groupid)) <> lower(rtrim($3::text))');
    expect(locks[1]?.sql).toContain("AND (groupid IS NULL OR rtrim(groupid) = '')");
    const updated = db.writes().filter((statement) => /^UPDATE "content"\."approval_request"/.test(statement.sql)).map((statement) => statement.params.at(-1));
    const named = Object.entries(ids).filter(([, id]) => updated.includes(id)).map(([name]) => name);
    expect(named.sort()).toEqual(rewritten);
    const groups = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, requestRow(id)?.groupid]));
    expect(groups).toEqual({ seeded: APPROVERS, editors: APPROVERS, ungrouped: APPROVERS, otherChain: EDITORS });
  });

  it('answers the bean errors after still replacing the memberships, writing no chain row', async () => {
    const result = await saveChain(deps, actorOf('s2'), { chainId: CHAIN, siteId: SITE_ID, name: 'x'.repeat(101), description: '', groupId: EDITORS });
    expect(result.errors).toEqual({ name: NAME_ERROR });
    expect(membershipsOf(CHAIN).map((row) => [row.groupid, row.orderno])).toEqual([[EDITORS, 1]]);
    expect(chainWrites()).toEqual([]);
    expect(store.rows('approval_chain').find((row) => row.chainid === CHAIN)?.name).toBe('Content Approval');
  });

  it('fails a chain id beyond 35 characters, writing neither memberships nor the chain', async () => {
    db.clear();
    const result = await saveChain(deps, actorOf('s2'), { chainId: 'C'.repeat(36), siteId: SITE_ID, name: 'Long', description: '', groupId: EDITORS });
    expect(result.errors).toEqual({ chainID: "The property named 'chainID' is not valid" });
    expect(approvalWrites()).toEqual([]);
  });

  it('inserts an unknown chain with created and lastupdate now, leaving memberships alone without a groupID', async () => {
    const chainId = newId();
    db.clear();
    const { value, errors } = await saveChain(deps, actorOf('s2'), { chainId, siteId: SITE_ID, name: 'New', description: '' });
    expect(errors).toEqual({});
    expect(value).toMatchObject({ chainid: chainId, name: 'New', description: '', created: TEST_CLOCK.now(), lastupdate: TEST_CLOCK.now() });
    expect(approvalWrites().filter((sql) => /^INSERT INTO "content"\."approval_chain"/.test(sql))).toHaveLength(1);
    expect(approvalWrites().filter((sql) => /"approval_membership"|"approval_request"/.test(sql))).toEqual([]);
  });
});

describe('deleteChain', () => {
  it('removes the chain\u2019s memberships and its requests with their actions, then the chain, leaving other chains\u2019 rows', async () => {
    const other = approvalRequestRow({ chainid: newId() });
    store.add('approval_request', other);
    store.add('approval_action', { tenant_id: TENANT_A.tenantId, actiontid: newId(), requestid: REQUEST, groupid: APPROVERS, chainid: CHAIN, actiontype: 'Approval' });
    expect(await deleteChain(deps, actorOf('s2'), CHAIN)).toMatchObject({ chainid: CHAIN, siteid: SITE_ID, name: 'Content Approval' });
    expect(store.rows('approval_chain').filter((row) => row.chainid === CHAIN)).toEqual([]);
    expect(store.rows('approval_membership')).toEqual([]);
    expect(store.rows('approval_action')).toEqual([]);
    expect(store.rows('approval_request').map((row) => row.requestid)).toEqual([other.requestid]);
  });

  it('answers null for an unknown chain, deleting nothing', async () => {
    db.clear();
    expect(await deleteChain(deps, actorOf('s2'), newId())).toBeNull();
    expect(approvalWrites()).toEqual([]);
  });
});

describe('availableGroups', () => {
  it('lists the user pools\u2019 groups outside the chain by name: public ones from the umbrella pool, private ones from the site', async () => {
    db.clear();
    expect(await availableGroups(deps, actorOf('s2'), CHAIN)).toEqual([
      { groupid: EXTRA_GROUPS.authors, groupname: 'authors', siteid: SITE_ID, ispublic: 0 },
      { groupid: EXTRA_GROUPS.beta, groupname: 'beta Club', siteid: TENANT_UMBRELLA.siteId, ispublic: 1 },
      { groupid: EXTRA_GROUPS.members, groupname: 'Members', siteid: TENANT_UMBRELLA.siteId, ispublic: 1 },
      { groupid: EXTRA_GROUPS.zeta, groupname: 'Zeta Team', siteid: SITE_ID, ispublic: 0 },
    ]);
    const reads = db.statements.filter((statement) => POOL_GROUPS_READ.test(statement.sql)).map(({ tenantId, params }) => ({ tenantId, params }));
    expect(reads).toEqual([
      { tenantId: TENANT_UMBRELLA.tenantId, params: [TENANT_UMBRELLA.tenantId, 1, TENANT_UMBRELLA.siteId] },
      { tenantId: TENANT_A.tenantId, params: [TENANT_A.tenantId, 0, SITE_ID] },
    ]);
  });

  it('lists no group once a chain membership has no group, as legacy NOT IN over a NULL does', async () => {
    store.patch('approval_membership', (row) => row.membershipid === IDS.approval.membershipTwo, { groupid: null });
    db.clear();
    expect(await availableGroups(deps, actorOf('s2'), CHAIN)).toEqual([]);
    expect(db.statements.some((statement) => POOL_GROUPS_READ.test(statement.sql))).toBe(false);
  });
});

describe('chainAccess', () => {
  it.each<[TokenSubject, boolean]>([
    ['s2', true],
    ['site-admin', true],
    ['editor', false],
    ['approver', false],
  ])('%s passes the cchain before() gate: %s', (subject, allowed) => {
    expect(chainAccess(actorOf(subject))).toBe(allowed);
  });
});

describe('cchain routes', () => {
  const OPENAPI = parse(readFileSync(new URL('../../contracts/openapi.yaml', import.meta.url), 'utf8')) as object;
  const CHAINS_URL = `/v1/sites/${SITE_ID}/approval-chains`;
  const TOKEN = 'csrf_token=tok&csrf_token_expires=exp';
  const LIST_REDIRECT = { circuit: 'cchain', action: 'list', params: [['siteid', SITE_ID]] };
  const routeDb = createRecordingDb();
  let t: TestApp;

  /** Sends `subject`'s request, a form post when `payload` is given, and checks the answer against its contract operation. */
  async function call(method: 'GET' | 'POST', subject: TokenSubject, payload?: string): Promise<InjectResponse> {
    const headers = await contentHeaders(subject);
    const res = await t.app.inject(
      payload === undefined
        ? { method, url: CHAINS_URL, headers }
        : { method, url: CHAINS_URL, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload },
    );
    assertResponseMatchesOpenApi(OPENAPI, { method, path: CHAINS_URL, status: res.statusCode, contentType: res.headers['content-type'], body: res.body });
    return res;
  }

  beforeAll(async () => {
    t = await buildTestApp({ db: routeDb });
  });

  afterAll(async () => {
    await t?.close();
  });

  beforeEach(() => {
    routeDb.reset();
    seedRecordingDb(routeDb, SEEDS);
    db = routeDb;
    store = createApprovalStore(routeDb);
    t.client.clear();
  });

  it.each<TokenSubject>(['s2', 'site-admin'])('admit %s to cchain.list and to a valid cchain.save, which redirects to cchain.list appending siteid', async (subject) => {
    const list = await call('GET', subject);
    expect(list.statusCode).toBe(200);
    expect((list.json() as { rc: { chains: Array<{ chainID: string }> } }).rc.chains.map((chain) => chain.chainID)).toEqual([CHAIN]);
    const saved = await call('POST', subject, `chainID=${CHAIN}&name=Renamed&groupID=${APPROVERS}&${TOKEN}`);
    expect(saved.json()).toEqual({ saved: true, errors: {}, redirect: LIST_REDIRECT });
    expect(store.rows('approval_chain').find((row) => row.chainid === CHAIN)).toMatchObject({ name: 'Renamed', lastupdateby: 'Test User' });
  });

  it('deny the editor with 403 before a token is consumed or a row written', async () => {
    expect((await call('GET', 'editor')).statusCode).toBe(403);
    expect((await call('POST', 'editor', `chainID=${CHAIN}&name=Renamed&${TOKEN}`)).statusCode).toBe(403);
    expect(t.client.csrfConsumes).toEqual([]);
    expect(approvalWrites()).toEqual([]);
  });

  it('answer bean errors with no redirect, so cchain.save re-renders', async () => {
    const res = await call('POST', 's2', `chainID=${CHAIN}&name=${'x'.repeat(101)}&${TOKEN}`);
    expect(res.json()).toEqual({ saved: false, errors: { name: NAME_ERROR }, redirect: null });
    expect(store.rows('approval_chain').find((row) => row.chainid === CHAIN)?.name).toBe('Content Approval');
  });
});

