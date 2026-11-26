// Unit tests for the carch view model over recorded edit-screen models, against the legacy edit, status and menu views.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPONENT_MODULE_ID,
  CONTENT_MODULE_ID,
  FORM_MODULE_ID,
  NODE_LEVEL_LIST,
  ROOT_CONTENT_ID,
  VARIATION_MODULE_ID,
  carchViewState,
  extendedList,
  isDeletable,
  isSiteAdminOrS2,
  lockState,
  pageLevelList,
  permOf,
  structOf,
  structText,
  type CarchPageData,
  type CarchStats,
  type DeletableInput,
  type LockState,
} from '@/screens/carch/model';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { CONTENT_IDS, carchEditExistingPage, carchEditNewPage } from '../../fixtures/strategies-content/carch';
import { USER_IDS } from '../../fixtures/session';

const existingBean = structOf(carchEditExistingPage.rc, 'contentBean');
const existingStats = structOf(existingBean, 'stats');
const LOCKABLE = { hasLockableNodes: true } as const;
const UNLOCKABLE = { hasLockableNodes: false } as const;

/** isDeletable inputs as edit.cfm reads them for `view`, outside the compact display; ids by its lower-case names. */
function deletableInputOf(view: CarchPageData): DeletableInput {
  const bean = structOf(view.rc, 'contentBean');
  return {
    compactDisplay: 'false',
    parentId: structText(bean, 'parentid'),
    contentId: structText(bean, 'contentid'),
    siteLocking: structText(structOf(view.rc, 'site'), 'locking'),
    perm: permOf(view),
    isLocked: structText(bean, 'isLocked'),
  };
}

/** The recorded page's stats with a node lock held by `lockID`. */
function statsLockedBy(lockID: string): CarchStats {
  return { ...existingStats, lockID, lockType: 'node' };
}

/** The recorded page with `rc.perm` replaced. */
function withPerm(perm: string): CarchPageData {
  const view = structuredClone(carchEditExistingPage);
  view.rc.perm = perm;
  return view;
}

const NO_LOCK: LockState = {
  isLocked: false,
  isLockedBySomeoneElse: false,
  nodeLockedByYou: false,
  nodeLockedBySomeoneElse: false,
};

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('module ids', () => {
  it.each([
    ['CONTENT_MODULE_ID', CONTENT_MODULE_ID, '00000000000000000000000000000000000'],
    ['COMPONENT_MODULE_ID', COMPONENT_MODULE_ID, '00000000000000000000000000000000003'],
    ['FORM_MODULE_ID', FORM_MODULE_ID, '00000000000000000000000000000000004'],
    ['VARIATION_MODULE_ID', VARIATION_MODULE_ID, '00000000000000000000000000000000099'],
    ['ROOT_CONTENT_ID', ROOT_CONTENT_ID, '00000000000000000000000000000000001'],
  ])('%s is the 35-character legacy id', (_, value, expected) => {
    expect(value).toBe(expected);
    expect(value).toHaveLength(35);
  });
});

describe('content type lists', () => {
  const PAGE_LEVEL = ['Page', 'Folder', 'Calendar'];
  const GALLERY_PAGE_LEVEL = ['Page', 'Folder', 'Calendar', 'Gallery'];
  const EXTENDED = ['Page', 'Folder', 'Calendar', 'Link', 'File', 'Component', 'Form'];
  const GALLERY_EXTENDED = ['Page', 'Folder', 'Calendar', 'Gallery', 'Link', 'File', 'Component', 'Form'];

  it('lists the node-level types in edit.cfm order', () => {
    expect(NODE_LEVEL_LIST).toEqual(['Page', 'Folder', 'Calendar', 'Gallery', 'Link', 'File']);
    expect(Object.isFrozen(NODE_LEVEL_LIST)).toBe(true);
  });

  it.each([
    ['Page', PAGE_LEVEL, EXTENDED],
    ['Folder', PAGE_LEVEL, EXTENDED],
    ['Calendar', PAGE_LEVEL, EXTENDED],
    ['Gallery', GALLERY_PAGE_LEVEL, GALLERY_EXTENDED],
    ['File', PAGE_LEVEL, EXTENDED],
    ['Link', PAGE_LEVEL, EXTENDED],
    ['Component', PAGE_LEVEL, EXTENDED],
    ['Form', PAGE_LEVEL, EXTENDED],
    ['Variation', PAGE_LEVEL, EXTENDED],
  ])('offers the %s edit lists', (type, pageLevel, extended) => {
    expect(pageLevelList(type)).toEqual(pageLevel);
    expect(extendedList(type)).toEqual(extended);
  });

  it('offers the lists of the recorded page type', () => {
    const type = structText(existingBean, 'type');
    expect([pageLevelList(type), extendedList(type)]).toEqual([PAGE_LEVEL, EXTENDED]);
  });
});

describe('lockState', () => {
  it('reports no lock for the recorded page, whose lock id is empty', () => {
    expect(lockState(existingStats, LOCKABLE, USER_IDS.admin)).toEqual(NO_LOCK);
  });

  it.each([
    ['the session user', USER_IDS.admin],
    ['another user', USER_IDS.qaEditor],
  ])('ignores a node lock of %s on a site without lockable nodes', (_, lockId) => {
    expect(lockState(statsLockedBy(lockId), UNLOCKABLE, USER_IDS.admin)).toEqual(NO_LOCK);
  });

  it('reports a node lock of the session user as locked by you', () => {
    expect(lockState(statsLockedBy(USER_IDS.admin), LOCKABLE, USER_IDS.admin)).toEqual({
      isLocked: true,
      isLockedBySomeoneElse: false,
      nodeLockedByYou: true,
      nodeLockedBySomeoneElse: false,
    });
  });

  it('reports a node lock of another user as locked by someone else', () => {
    expect(lockState(statsLockedBy(USER_IDS.qaEditor), LOCKABLE, USER_IDS.admin)).toEqual({
      isLocked: true,
      isLockedBySomeoneElse: true,
      nodeLockedByYou: false,
      nodeLockedBySomeoneElse: true,
    });
  });
});

describe('isDeletable', () => {
  const existing = deletableInputOf(carchEditExistingPage);

  it('reads the recorded page as a top-level unlocked node of an editor on a site without locking', () => {
    expect(existing).toEqual({
      compactDisplay: 'false',
      parentId: ROOT_CONTENT_ID,
      contentId: CONTENT_IDS.aboutUs,
      siteLocking: 'none',
      perm: 'editor',
      isLocked: '0',
    });
  });

  it.each<[string, Partial<DeletableInput>, boolean]>([
    ['the recorded page', {}, true],
    ['the compact display', { compactDisplay: 'true' }, false],
    ['a top-level node under top-level locking', { siteLocking: 'top' }, false],
    ['a top-level node under full locking', { siteLocking: 'all' }, false],
    ['a nested node under top-level locking', { parentId: CONTENT_IDS.aboutUs, siteLocking: 'top' }, true],
    ['a nested node under full locking', { parentId: CONTENT_IDS.aboutUs, siteLocking: 'all' }, false],
    ['an author', { perm: 'author' }, false],
    ['a reader', { perm: 'read' }, false],
    ['no node access', { perm: 'none' }, false],
    ['the home node', { contentId: ROOT_CONTENT_ID }, false],
    ['a content bean locked for editing', { isLocked: 1 }, false],
  ])('decides %s', (_, overrides, expected) => {
    expect(isDeletable({ ...existing, ...overrides })).toBe(expected);
  });

  it('keeps new content deletable, as the expression has no isNew term', () => {
    expect(structText(structOf(carchEditNewPage.rc, 'contentBean'), 'isNew')).toBe('1');
    expect(isDeletable(deletableInputOf(carchEditNewPage))).toBe(true);
  });

  it('leaves a node lock of another user to the menu guard', () => {
    const lock = lockState(statsLockedBy(USER_IDS.qaEditor), LOCKABLE, USER_IDS.admin);
    expect(isDeletable(existing)).toBe(true);
    expect(isDeletable(existing) && !lock.isLockedBySomeoneElse).toBe(false);
  });
});

describe('isSiteAdminOrS2', () => {
  it.each([
    ['the S2 admin', () => adminS2Request(), true],
    ['the tenant-a site admin on tenant-a', () => siteAdminRequest('tenant-a'), true],
    ['the editor', () => editorRequest(), false],
    ['the editor posting s2=1', () => editorRequest({ rc: { s2: '1' } }), false],
  ])('decides %s', (_, request, expected) => {
    expect(isSiteAdminOrS2(request())).toBe(expected);
  });
});

describe('permOf', () => {
  it('reads the recorded editor verdict', () => {
    expect(permOf(carchEditExistingPage)).toBe('editor');
  });

  it.each(['author', 'read', 'none'])('reads the %s verdict', (perm) => {
    expect(permOf(withPerm(perm))).toBe(perm);
  });

  it('refuses a model without rc.perm', () => {
    const view = structuredClone(carchEditExistingPage);
    delete view.rc.perm;
    expect(() => permOf(view)).toThrow(TypeError);
  });
});

describe('carchViewState', () => {
  it('derives the recorded page state for the S2 admin holding its node lock', () => {
    const req = adminS2Request({
      rc: { siteid: structText(existingBean, 'siteID') },
      session: { mura: { userID: USER_IDS.admin } },
    });
    const state = carchViewState(req, {
      ...deletableInputOf(carchEditExistingPage),
      stats: statsLockedBy(USER_IDS.admin),
      ...LOCKABLE,
    });
    expect(state).toEqual({
      isLocked: true,
      isLockedBySomeoneElse: false,
      nodeLockedByYou: true,
      nodeLockedBySomeoneElse: false,
      perm: 'editor',
      deletable: true,
      siteAdminOrS2: true,
      poweruser: true,
      s2IsPrivate: true,
    });
  });
});
