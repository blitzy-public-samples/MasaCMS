// Unit tests for the carch view-model rules: module ids, type lists, struct access, node perm, lock and delete state.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARCH_SESSION_MODULE_IDS,
  NODE_LEVEL_LIST,
  ROOT_CONTENT_ID,
  SESSION_TOP_IDS,
  carchViewState,
  extendedList,
  isDeletable,
  isS2IsPrivate,
  isSiteAdminOrS2,
  isSuperOrAdminUser,
  lockState,
  pageLevelList,
  permOf,
  structOf,
  structText,
  structValue,
  type CarchStruct,
  type DeletableInput,
  type LockState,
} from '@/screens/carch/model';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  makeAdminRequest,
  noSitesRequest,
  siteAdminRequest,
} from '../../helpers/admin-request';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { SUBJECTS } from '../../helpers/tokens';

const here = import.meta.dirname ?? __dirname;
const legacySource = (file: string): string =>
  readFileSync(path.resolve(here, '../../../../admin/core', file), 'utf8').replaceAll('\r\n', '\n');

const USER_ID = 'A1000000-0000-0000-0000000000000001';
const OTHER_ID = 'A1000000-0000-0000-0000000000000002';
const PARENT_ID = 'C1000000-0000-0000-0000000000000001';
const CONTENT_ID = 'C1000000-0000-0000-0000000000000002';

/** The list values of a `<cfset name="..."/>` in `source`, in order of appearance. */
function cfsetLists(source: string, name: string): string[][] {
  return [...source.matchAll(new RegExp(`<cfset ${name}="([^"]*)"/>`, 'g'))].map((match) =>
    (match[1] ?? '').split(','),
  );
}

describe('carch module constants', () => {
  const controller = legacySource('controllers/carch.cfc');

  it('whitelists exactly the session module ids of carch before()', () => {
    const list = /!listFind\('([^']+)',session\.moduleid\)/.exec(controller)?.[1];
    expect(CARCH_SESSION_MODULE_IDS).toEqual(list?.split(','));
  });

  it('defaults each module session key to the topid carch before() seeds', () => {
    const seeded = [...controller.matchAll(/session\['(m\d+)'\]=\{topid="(\d+)"\}/g)].map(([, key, topId]) => [
      key,
      topId,
    ]);
    expect(SESSION_TOP_IDS).toEqual(Object.fromEntries(seeded));
  });
});

describe('content type lists', () => {
  const edit = legacySource('views/carch/edit.cfm');
  const [galleryPages, otherPages] = cfsetLists(edit, 'pageLevelList');
  const [galleryExtended, otherExtended] = cfsetLists(edit, 'extendedList');

  it('lists the node-level types of edit.cfm', () => {
    expect(NODE_LEVEL_LIST).toEqual(cfsetLists(edit, 'nodeLevelList')[0]);
  });

  it.each([
    ['Gallery', true],
    ['gallery', true],
    ['Page', false],
    ['Folder', false],
  ])('offers the %s type lists of edit.cfm', (type, isGallery) => {
    expect(pageLevelList(type)).toEqual(isGallery ? galleryPages : otherPages);
    expect(extendedList(type)).toEqual(isGallery ? galleryExtended : otherExtended);
  });
});

describe('struct access', () => {
  const struct: CarchStruct = {
    lockID: USER_ID,
    title: 'Home',
    majorVersion: 2,
    remoteID: null,
    stats: { LockType: 'node' },
    crumbs: [],
  };

  it.each([
    ['lockID', USER_ID],
    ['LOCKID', USER_ID],
    ['missing', undefined],
  ])('reads %s case-insensitively', (key, expected) => {
    expect(structValue(struct, key)).toBe(expected);
  });

  it.each([
    ['TITLE', 'Home'],
    ['majorversion', '2'],
    ['remoteID', ''],
    ['missing', ''],
  ])('reads %s as CFML text', (key, expected) => {
    expect(structText(struct, key)).toBe(expected);
  });

  it.each(['stats', 'crumbs'])('refuses %s as text', (key) => {
    expect(() => structText(struct, key)).toThrow(TypeError);
  });

  it('reads a nested struct case-insensitively', () => {
    expect(structOf(struct, 'STATS')).toBe(struct.stats);
  });

  it.each(['crumbs', 'remoteID', 'title', 'missing'])('refuses %s as a struct', (key) => {
    expect(() => structOf(struct, key)).toThrow(TypeError);
  });
});

describe('permOf', () => {
  it.each([
    ['Editor', 'editor'],
    ['AUTHOR', 'author'],
    ['read', 'read'],
    ['None', 'none'],
  ])('reads rc.perm %s as the %s verdict', (perm, verdict) => {
    expect(permOf({ rc: { perm } })).toBe(verdict);
  });

  it.each(['admin', ''])('refuses rc.perm %j', (perm) => {
    expect(() => permOf({ rc: { perm } })).toThrow(TypeError);
  });
});

describe('lockState', () => {
  const states = (isLocked: boolean, bySomeoneElse: boolean, byYou: boolean): LockState => ({
    isLocked,
    isLockedBySomeoneElse: bySomeoneElse,
    nodeLockedByYou: byYou,
    nodeLockedBySomeoneElse: bySomeoneElse,
  });

  it.each<[string, CarchStruct, boolean, string, LockState]>([
    ['a node lock of the user', { lockID: USER_ID, lockType: 'node' }, true, USER_ID, states(true, false, true)],
    ['a node lock of another user', { lockID: OTHER_ID, lockType: 'node' }, true, USER_ID, states(true, true, false)],
    [
      'a node lock matched without case',
      { LOCKID: USER_ID.toLowerCase(), LockType: 'NODE' },
      true,
      USER_ID,
      states(true, false, true),
    ],
    [
      'an empty node lock id for an empty user id',
      { lockID: '', lockType: 'node' },
      true,
      '',
      states(false, false, true),
    ],
    ['an empty node lock id', { lockID: '', lockType: 'node' }, true, USER_ID, states(false, false, false)],
    ['a file lock', { lockID: OTHER_ID, lockType: 'file' }, true, USER_ID, states(false, false, false)],
    ['no lock columns', {}, true, USER_ID, states(false, false, false)],
    [
      'a site without lockable nodes',
      { lockID: OTHER_ID, lockType: 'node' },
      false,
      USER_ID,
      states(false, false, false),
    ],
  ])('derives the flags of %s', (_, stats, hasLockableNodes, userId, expected) => {
    expect(lockState(stats, { hasLockableNodes }, userId)).toEqual(expected);
  });
});

describe('isDeletable', () => {
  const deletable: DeletableInput = {
    compactDisplay: 'false',
    parentId: PARENT_ID,
    contentId: CONTENT_ID,
    siteLocking: 'none',
    perm: 'editor',
    isLocked: 0,
  };

  it.each<[string, Partial<DeletableInput>, boolean]>([
    ['an unlocked editor node below a folder', {}, true],
    ['the compact display', { compactDisplay: 'true' }, false],
    ['the compact display in upper case', { compactDisplay: 'TRUE' }, false],
    ['history and audit, which omit compactDisplay', { compactDisplay: undefined }, true],
    ['top-level locking below a folder', { siteLocking: 'top' }, true],
    ['full locking below a folder', { siteLocking: 'all' }, false],
    ['a top-level node without locking', { parentId: ROOT_CONTENT_ID }, true],
    ['a top-level node under top-level locking', { parentId: ROOT_CONTENT_ID, siteLocking: 'top' }, false],
    ['a top-level node under full locking', { parentId: ROOT_CONTENT_ID, siteLocking: 'all' }, false],
    ['an author', { perm: 'author' }, false],
    ['a reader', { perm: 'read' }, false],
    ['the home node', { contentId: ROOT_CONTENT_ID }, false],
    ['a locked node', { isLocked: 1 }, false],
    ['a locked node as text', { isLocked: '1' }, false],
    ['an unlocked node as text', { isLocked: '0' }, true],
    // ACF 2023 `neq "true"` and `neq 1`: numbers and trimmed yes/no/true/false words compare as values, the rest as text.
    // rc holds the request value as the admin scan leaves it: the oracle echoes ' true' as "YES" and ' TRUE' as TRUE.
    ["compactDisplay '1'", { compactDisplay: '1' }, false],
    ["compactDisplay 'yes'", { compactDisplay: 'yes' }, false],
    ["compactDisplay ' true'", { compactDisplay: ' true' }, true],
    ["compactDisplay 'true '", { compactDisplay: 'true ' }, true],
    ["compactDisplay '\"YES\"'", { compactDisplay: '"YES"' }, true],
    ["compactDisplay ' TRUE'", { compactDisplay: ' TRUE' }, false],
    ["compactDisplay 'tr\\0ue'", { compactDisplay: 'tr\u0000ue' }, false],
    ["compactDisplay '\\u0001yes'", { compactDisplay: '\u0001yes' }, false],
    ["compactDisplay '1.0'", { compactDisplay: '1.0' }, false],
    ["compactDisplay ' 1.0 '", { compactDisplay: ' 1.0 ' }, false],
    ["compactDisplay '0'", { compactDisplay: '0' }, true],
    ["compactDisplay 'no'", { compactDisplay: 'no' }, true],
    ["compactDisplay 'on'", { compactDisplay: 'on' }, true],
    ["compactDisplay 'y'", { compactDisplay: 'y' }, true],
    ["compactDisplay 'trueish'", { compactDisplay: 'trueish' }, true],
    ["compactDisplay ''", { compactDisplay: '' }, true],
    ["compactDisplay '2'", { compactDisplay: '2' }, true],
    ["isLocked 'yes'", { isLocked: 'yes' }, false],
    ["isLocked 'TRUE'", { isLocked: 'TRUE' }, false],
    ["isLocked ' true'", { isLocked: ' true' }, false],
    ["isLocked '1.0'", { isLocked: '1.0' }, false],
    ["isLocked 'no'", { isLocked: 'no' }, true],
    ["isLocked 'false'", { isLocked: 'false' }, true],
    ["isLocked 'on'", { isLocked: 'on' }, true],
    ["isLocked ''", { isLocked: '' }, true],
    ['isLocked 2', { isLocked: 2 }, true],
  ])('decides %s', (_, overrides, expected) => {
    expect(isDeletable({ ...deletable, ...overrides })).toBe(expected);
  });
});

describe('session membership checks', () => {
  it.each([
    ['the S2 admin', adminS2Request(), true],
    ['the site admin', siteAdminRequest(), true],
    ['the editor', editorRequest(), false],
    ['an editor whose rc claims S2', editorRequest({ rc: { isS2: 'true', memberships: 'S2' } }), false],
  ])('grants site admin or S2 to %s from the verified claims', (_, req, expected) => {
    expect(isSiteAdminOrS2(req)).toBe(expected);
  });

  it.each(REQUESTED_SITE_CASES)('grants site admin or S2 to $who only when it administers that site', (testCase) => {
    expect(isSiteAdminOrS2(testCase.request({}))).toBe(testCase.administers);
  });

  it.each([
    ['the S2 admin', adminS2Request(), true],
    ['the tenant-a site admin on tenant-a', siteAdminRequest('tenant-a'), true],
    ['the tenant-a site admin on tenant-b, which its own site does not change', siteAdminRequest('tenant-b'), true],
    ['the editor', editorRequest(), false],
  ])('reads isSuperUser() or isAdminUser() for %s without rc.siteid', (_, req, expected) => {
    expect(isSuperOrAdminUser(req)).toBe(expected);
  });

  it.each([
    ['a private system user', noSitesRequest({ s2IsPrivate: true }), true],
    ['a public member', noSitesRequest({ s2IsPrivate: false }), false],
  ])('reads the session S2IsPrivate flag of %s', (_, req, expected) => {
    expect(isS2IsPrivate(req)).toBe(expected);
  });

  it.each([
    ['S2IsPrivate;tenant-a,S2IsPrivate', 'TENANT-A', true],
    ['s2isprivate;tenant-a', 'tenant-a', true],
    ['S2IsPrivate;tenant-a,S2IsPrivate', 'tenant-b', false],
    ['S2IsPrivate', 'tenant-a', false],
  ])('finds S2IsPrivate;<site> in %j for %s without case', (memberships, siteId, expected) => {
    const req = makeAdminRequest({ session: { mura: { memberships } } }, 'systemUser');
    expect(isS2IsPrivate(req, siteId)).toBe(expected);
  });

  it('matches the bare S2IsPrivate membership by case', () => {
    expect(isS2IsPrivate(makeAdminRequest({ session: { mura: { memberships: 's2isprivate' } } }, 'systemUser'))).toBe(
      false,
    );
  });

  it('finds no site membership for a session user without memberships', () => {
    expect(isS2IsPrivate(anonymousRequest(), 'default')).toBe(false);
  });
});

describe('carchViewState', () => {
  const input = {
    compactDisplay: 'false',
    parentId: PARENT_ID,
    contentId: CONTENT_ID,
    siteLocking: 'none',
    perm: 'editor' as const,
    isLocked: 0,
    hasLockableNodes: true,
  };

  it('locks against the session user, not rc.userid', () => {
    const req = siteAdminRequest(undefined, { rc: { userid: OTHER_ID } });
    expect(carchViewState(req, { ...input, stats: { lockID: OTHER_ID, lockType: 'node' } })).toEqual({
      isLocked: true,
      isLockedBySomeoneElse: true,
      nodeLockedByYou: false,
      nodeLockedBySomeoneElse: true,
      perm: 'editor',
      deletable: true,
      siteAdminOrS2: true,
      poweruser: true,
      s2IsPrivate: true,
    });
  });

  it('keeps poweruser for a site admin on a site its token does not serve, which siteAdminOrS2 refuses', () => {
    const req = siteAdminRequest('tenant-b');
    expect(carchViewState(req, { ...input, stats: {} })).toMatchObject({ siteAdminOrS2: false, poweruser: true });
  });

  it('reports the node lock of the session user with the session flags', () => {
    const req = makeAdminRequest(
      { session: { mura: { memberships: `S2IsPrivate;${SUBJECTS.qaEditor.site},S2IsPrivate` } } },
      'qaEditor',
    );
    const stats = { lockID: SUBJECTS.qaEditor.sub, lockType: 'node' };
    expect(carchViewState(req, { ...input, perm: 'author', stats })).toEqual({
      isLocked: true,
      isLockedBySomeoneElse: false,
      nodeLockedByYou: true,
      nodeLockedBySomeoneElse: false,
      perm: 'author',
      deletable: false,
      siteAdminOrS2: false,
      poweruser: false,
      s2IsPrivate: true,
    });
  });
});
