// The change-set secondary menu and shell hook against cchangesets/dsp_secondary_menu.cfm.
import { describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { encodeHtml, encodeJs, isSafeHtml, toString, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor, type RbLookup } from '@/lib/resource-bundles/rb';
import {
  cchangesetsSecondaryMenu,
  renderChangesetsMenu,
  type ChangesetMenuState,
} from '@/screens/cchangesets/secondary-menu';
import { editorRequest, makeAdminRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomLink } from '../../helpers/dom-model';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';

const CHANGESET_ID = '7C1A2B3D-4E5F-4A6B-8C9D0E1F2A3B4C5D';
const PREVIEW_LINK = `http://localhost:8080/default/?changesetID=${CHANGESET_ID}`;
const PERM_MODULE_ID = '00000000000000000000000000000000014';
const EN_US = rbFor('en_US');

const UNPUBLISHED: ChangesetMenuState = {
  changesetId: CHANGESET_ID,
  published: false,
  isNew: false,
  previewLink: PREVIEW_LINK,
};
const PUBLISHED: ChangesetMenuState = { ...UNPUBLISHED, published: true };
const NEW: ChangesetMenuState = { published: false, isNew: true };

// dsp_secondary_menu.cfm as the ACF 2023 oracle served it to the admin on `default`.
const LEGACY_LIST_MENU =
  '<div class="nav-module-specific btn-group">\n\t\t\n\t\t\t\t' +
  '<a class="btn" title="Add Change Set" href="./?muraAction=cChangesets.edit&changesetID=&siteid=default">' +
  '<i class="mi-plus-circle"></i> Add Change Set</a>\n\t\t\t\t\n\t\t\t\t' +
  `<a class="btn " href="./?muraAction=cPerm.module&contentid=${PERM_MODULE_ID}&siteid=default` +
  `&moduleid=${PERM_MODULE_ID}">` +
  '<i class="mi-group"></i> Permissions</a>\n\t\t\t\t\n\t</div>';
const LEGACY_NEW_EDIT_MENU =
  '<div class="nav-module-specific btn-group">\n\t\t\n\t\t\t\t' +
  '<a class="btn" title="Back to Change Sets" href="./?muraAction=cChangesets.list&siteid=default">' +
  '<i class="mi-arrow-circle-left"></i> Back to Change Sets</a>\n\t\t\t\t\n\t</div>';

/** Answers markup that legacy emits unencoded for every key. */
const marked: RbLookup = {
  locale: 'en_US',
  rbKey: (key) => `<b>${key}</b> & "co"`,
  messageFormat: (pattern) => pattern,
};

const adminOn = (item: string, rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  makeAdminRequest({ circuit: 'cChangesets', item, rc: { changesetID: CHANGESET_ID, ...rc } }, 'admin');

/** The markup string, after checking it is markup the shell embeds unescaped. */
function markupOf(html: SafeHtml): string {
  expect(isSafeHtml(html)).toBe(true);
  return toString(html);
}

const BACK: DomLink = { href: './?muraAction=cchangesets.list&siteid=default', text: 'Back to Change Sets' };
const VIEW_EDIT: DomLink = {
  href: `./?muraAction=cchangesets.edit&changesetID=${CHANGESET_ID}&siteid=default`,
  text: 'View Edit Form',
};
const VIEW_ASSIGNMENTS: DomLink = {
  href: `./?muraAction=cchangesets.assignments&changesetID=${CHANGESET_ID}&siteid=default`,
  text: 'View Content Assignments List',
};
const PREVIEW: DomLink = { href: '#', text: 'Preview Change Set' };
const ADD: DomLink = { href: './?muraAction=cchangesets.edit&changesetID=&siteid=default', text: 'Add Change Set' };

/** A menu request with its loaded change set, the links legacy renders and the preview URL it sets. */
interface LinkCase {
  readonly name: string;
  readonly req: () => AdminRequest;
  readonly state?: ChangesetMenuState;
  readonly links: DomLink[];
  readonly previewLink?: string;
}

describe('renderChangesetsMenu', () => {
  it.each<{ name: string; menu: () => SafeHtml; legacy: string }>([
    { name: 'the list as the hook', menu: () => cchangesetsSecondaryMenu(adminOn('list')), legacy: LEGACY_LIST_MENU },
    {
      name: 'the edit form of a new change set',
      menu: () => renderChangesetsMenu(adminOn('edit'), EN_US, NEW).html,
      legacy: LEGACY_NEW_EDIT_MENU,
    },
    {
      name: 'the edit form as the hook',
      menu: () => cchangesetsSecondaryMenu(adminOn('edit')),
      legacy: LEGACY_NEW_EDIT_MENU,
    },
  ])('matches the oracle bytes for $name', ({ menu, legacy }) => {
    expect(markupOf(menu())).toBe(legacy);
  });

  const assignments = (): AdminRequest => adminOn('assignments');
  const edit = (): AdminRequest => adminOn('edit');
  const editorList = (): AdminRequest => editorRequest({ circuit: 'cChangesets', item: 'list' });
  it.each<LinkCase>([
    {
      name: 'assignments of an unpublished set',
      req: assignments,
      state: UNPUBLISHED,
      links: [BACK, VIEW_EDIT, PREVIEW],
      previewLink: PREVIEW_LINK,
    },
    { name: 'assignments of a published set', req: assignments, state: PUBLISHED, links: [BACK, VIEW_EDIT] },
    { name: 'assignments without a loaded set', req: assignments, links: [BACK, VIEW_EDIT] },
    {
      name: 'edit of an unpublished set',
      req: edit,
      state: UNPUBLISHED,
      links: [BACK, VIEW_ASSIGNMENTS, PREVIEW],
      previewLink: PREVIEW_LINK,
    },
    { name: 'edit of a published set', req: edit, state: PUBLISHED, links: [BACK, VIEW_ASSIGNMENTS] },
    { name: 'edit of a new set', req: edit, state: NEW, links: [BACK] },
    { name: 'the list for an editor', req: editorList, links: [ADD] },
    { name: 'an action without a case', req: () => adminOn('module'), links: [] },
  ])('links $name as legacy does', ({ req, state, links, previewLink }) => {
    const menu = renderChangesetsMenu(req(), EN_US, state);

    expect(fragmentModel(markupOf(menu.html)).links).toEqual(links);
    expect(menu.previewLink).toBe(previewLink);
  });

  it('offers Permissions to a site admin of the requested site', () => {
    const req = siteAdminRequest('tenant-a', { circuit: 'cChangesets', item: 'list', rc: { siteid: 'tenant-a' } });

    expect(fragmentModel(markupOf(renderChangesetsMenu(req, EN_US).html)).links).toEqual([
      { href: './?muraAction=cchangesets.edit&changesetID=&siteid=tenant-a', text: 'Add Change Set' },
      {
        href: `./?muraAction=cperm.module&contentid=${PERM_MODULE_ID}&moduleid=${PERM_MODULE_ID}&siteid=tenant-a`,
        text: 'Permissions',
      },
    ]);
  });

  it.each(REQUESTED_SITE_CASES)('links Permissions for $who only when it administers that site', (testCase) => {
    const req = testCase.request({ circuit: 'cChangesets', item: 'list' });
    const site = testCase.siteid;
    const add: DomLink = { href: `./?muraAction=cchangesets.edit&changesetID=&siteid=${site}`, text: ADD.text };
    const permissions: DomLink = {
      href: `./?muraAction=cperm.module&contentid=${PERM_MODULE_ID}&moduleid=${PERM_MODULE_ID}&siteid=${site}`,
      text: 'Permissions',
    };

    expect(fragmentModel(markupOf(renderChangesetsMenu(req, EN_US).html)).links).toEqual(
      testCase.administers ? [add, permissions] : [add],
    );
  });

  it('leaves Permissions out for Change Sets plus Site Manager module access, which legacy does not check', () => {
    const roles = [Roles.systemUser, moduleRole(PERM_MODULE_ID), moduleRole('00000000000000000000000000000000000')];
    const req = makeAdminRequest({ circuit: 'cChangesets', item: 'list', user: { roles } }, 'qaEditor');

    expect(fragmentModel(markupOf(renderChangesetsMenu(req, EN_US).html)).links).toEqual([ADD]);
  });

  it('encodes each value as legacy does', () => {
    const rcId = `${CHANGESET_ID}&x=<1>`;
    const link = "http://localhost/?changesetID=1&a='b'";
    const state: ChangesetMenuState = { ...UNPUBLISHED, changesetId: rcId, previewLink: link };
    const rc = { siteid: 'tenant a&b', changesetID: rcId };

    const assignments = markupOf(renderChangesetsMenu(adminOn('assignments', rc), marked, state).html);
    const edit = markupOf(renderChangesetsMenu(adminOn('edit', rc), marked, state).html);

    expect(assignments).toContain(
      `href="./?muraAction=cChangesets.edit&siteid=tenant+a%26b&changesetID=${encodeHtml(rcId)}"`,
    );
    expect(edit).toContain(`href="./?muraAction=cChangesets.assignments&siteid=tenant+a%26b&changesetID=${rcId}"`);
    for (const menu of [assignments, edit]) {
      expect(menu).toContain(`onclick="return preview('${encodeJs(link)}','');"`);
      expect(menu).toContain('title="<b>changesets.backtochangesets</b> & "co""');
    }
  });

  it("labels the hook's menu in the session's bundle", () => {
    const req = makeAdminRequest({ circuit: 'cChangesets', item: 'edit', session: { rb: 'de' } }, 'admin');

    expect(fragmentModel(markupOf(cchangesetsSecondaryMenu(req))).links).toEqual([
      { href: BACK.href, text: 'Zur\u00fcck zu Change-Sets' },
    ]);
  });
});
