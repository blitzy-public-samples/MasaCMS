// The change-set secondary menu against cchangesets/dsp_secondary_menu.cfm 77-107, over the admin request presets.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeHtml, encodeJs, encodeUrl, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import {
  cchangesetsSecondaryMenu,
  renderChangesetsMenu,
  type ChangesetMenuState,
} from '@/screens/cchangesets/secondary-menu';
import type { ShellHooks } from '@/shell/types';
import { CHANGESET_IDS } from '../../fixtures/strategies-content/changesets';
import { adminS2Request, editorRequest, siteAdminRequest, type AdminRequestPartial } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { makeScreenContext } from '../../helpers/screen-context';

const CIRCUIT = 'cChangesets';
const SITE = 'tenant-a';
const PERM_MODULE_ID = '00000000000000000000000000000000014';
const OPEN_ID = CHANGESET_IDS.open;
const PUBLISHED_ID = CHANGESET_IDS.published;

const previewLinkOf = (id: string): string => `http://tenant-a.example/?changesetID=${id}`;
const PREVIEW_LINK = previewLinkOf(OPEN_ID);
const QUOTED_LINK = `${PREVIEW_LINK}&note='x'`;

const UNPUBLISHED: ChangesetMenuState = {
  changesetId: OPEN_ID,
  published: false,
  isNew: false,
  previewLink: PREVIEW_LINK,
};
const PUBLISHED: ChangesetMenuState = {
  changesetId: PUBLISHED_ID,
  published: true,
  isNew: false,
  previewLink: previewLinkOf(PUBLISHED_ID),
};
const NEW: ChangesetMenuState = { changesetId: CHANGESET_IDS.newSet, published: false, isNew: true };

const menuHook: NonNullable<ShellHooks['secondaryMenus']['cchangesets']> = cchangesetsSecondaryMenu;

type Preset = (partial: AdminRequestPartial) => AdminRequest;
const S2: Preset = (partial) => adminS2Request(partial);
const SITE_ADMIN: Preset = (partial) => siteAdminRequest(SITE, partial);
const EDITOR: Preset = (partial) => editorRequest(partial);

/** `preset` on `<circuit>.<item>` with `rc.siteid` defaulting to tenant-a. */
const requestOf = (
  preset: Preset,
  item: string,
  rc: Readonly<Record<string, string>> = {},
  circuit: string = CIRCUIT,
): AdminRequest => preset({ circuit, item, rc: { siteid: SITE, ...rc } });

/** The en_US labels the admin handlers resolve for `req`. */
const rbOf = (req: AdminRequest): RbLookup => makeScreenContext({ req }).rb;

/** One menu anchor as the markup holds it: raw href, class attribute, title, onclick and icon classes. */
interface Anchor {
  readonly tag: string;
  readonly href: string | undefined;
  readonly className: string | undefined;
  readonly title: string | undefined;
  readonly onclick: string | undefined;
  readonly icons: string[];
}

/** An expected anchor and its link text. */
interface Button {
  readonly anchor: Anchor;
  readonly text: string;
}

interface Inspected {
  readonly anchors: Anchor[];
  readonly links: DomLink[];
}

/** The anchors and model links of `markup`, after checking its one root is the module-specific button group. */
function inspect(markup: string): Inspected {
  const $ = cheerio.load(markup, null, false);
  const roots = $.root().children();
  expect(roots).toHaveLength(1);
  expect(roots.is('div')).toBe(true);
  expect(roots.attr('class')).toBe('nav-module-specific btn-group');
  return {
    anchors: roots
      .children()
      .toArray()
      .map((el) => {
        const a = $(el);
        return {
          tag: el.tagName,
          href: a.attr('href'),
          className: a.attr('class'),
          title: a.attr('title'),
          onclick: a.attr('onclick'),
          icons: a
            .children('i')
            .toArray()
            .map((icon) => $(icon).attr('class') ?? ''),
        };
      }),
    links: fragmentModel(markup).links,
  };
}

function expectButtons(inspected: Inspected, buttons: readonly Button[]): void {
  expect(inspected.anchors).toEqual(buttons.map((b) => b.anchor));
  expect(inspected.links).toEqual(buttons.map((b) => ({ href: normaliseAdminUrl(b.anchor.href ?? ''), text: b.text })));
}

const titled = (href: string, title: string, icon: string): Button => ({
  anchor: { tag: 'a', href, className: 'btn', title, onclick: undefined, icons: [icon] },
  text: title,
});

const back = (site: string): Button =>
  titled(`./?muraAction=cChangesets.list&siteid=${encodeUrl(site)}`, 'Back to Change Sets', 'mi-arrow-circle-left');
const viewEdit = (site: string, id: string): Button =>
  titled(
    `./?muraAction=cChangesets.edit&siteid=${encodeUrl(site)}&changesetID=${encodeHtml(id)}`,
    'View Edit Form',
    'mi-pencil',
  );
const viewAssignments = (site: string, id: string): Button =>
  titled(
    `./?muraAction=cChangesets.assignments&siteid=${encodeUrl(site)}&changesetID=${id}`,
    'View Content Assignments List',
    'mi-reorder',
  );
const add = (site: string): Button =>
  titled(`./?muraAction=cChangesets.edit&changesetID=&siteid=${encodeUrl(site)}`, 'Add Change Set', 'mi-plus-circle');
const permissions = (site: string): Button => ({
  anchor: {
    tag: 'a',
    href: `./?muraAction=cPerm.module&contentid=${PERM_MODULE_ID}&siteid=${encodeUrl(site)}&moduleid=${PERM_MODULE_ID}`,
    className: 'btn ',
    title: undefined,
    onclick: undefined,
    icons: ['mi-group'],
  },
  text: 'Permissions',
});
const preview = (link: string): Button => ({
  anchor: {
    tag: 'a',
    href: '#',
    className: 'btn',
    title: undefined,
    onclick: `return preview('${encodeJs(link)}','');`,
    icons: ['mi-globe'],
  },
  text: 'Preview Change Set',
});

/** A menu request, the change set the view loaded, the buttons legacy renders and the preview URL it sets. */
interface MenuCase {
  readonly name: string;
  readonly preset: Preset;
  readonly item: string;
  readonly changesetId?: string;
  readonly state?: ChangesetMenuState;
  readonly buttons: readonly Button[];
  readonly previewLink?: string;
}

const MENU_CASES: readonly MenuCase[] = [
  {
    name: 'assignments of an unpublished set',
    preset: S2,
    item: 'assignments',
    changesetId: OPEN_ID,
    state: UNPUBLISHED,
    buttons: [back(SITE), viewEdit(SITE, OPEN_ID), preview(PREVIEW_LINK)],
    previewLink: PREVIEW_LINK,
  },
  {
    name: 'assignments of a published set',
    preset: S2,
    item: 'assignments',
    changesetId: PUBLISHED_ID,
    state: PUBLISHED,
    buttons: [back(SITE), viewEdit(SITE, PUBLISHED_ID)],
  },
  { name: 'the list for S2', preset: S2, item: 'list', buttons: [add(SITE), permissions(SITE)] },
  { name: 'the list for the tenant-a site admin', preset: SITE_ADMIN, item: 'list', buttons: [add(SITE), permissions(SITE)] },
  { name: 'the list for an editor', preset: EDITOR, item: 'list', buttons: [add(SITE)] },
  { name: 'the edit form of a new set', preset: S2, item: 'edit', changesetId: '', state: NEW, buttons: [back(SITE)] },
  {
    name: 'the edit form of an unpublished set',
    preset: SITE_ADMIN,
    item: 'edit',
    changesetId: OPEN_ID,
    state: UNPUBLISHED,
    buttons: [back(SITE), viewAssignments(SITE, OPEN_ID), preview(PREVIEW_LINK)],
    previewLink: PREVIEW_LINK,
  },
  {
    name: 'the edit form of a published set',
    preset: S2,
    item: 'edit',
    changesetId: PUBLISHED_ID,
    state: PUBLISHED,
    buttons: [back(SITE), viewAssignments(SITE, PUBLISHED_ID)],
  },
];

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('renderChangesetsMenu', () => {
  it.each(MENU_CASES)('renders $name', ({ preset, item, changesetId, state, buttons, previewLink }) => {
    const req = requestOf(preset, item, changesetId === undefined ? {} : { changesetid: changesetId });
    expect(req.action).toBe(`core:cchangesets.${item}`);

    const result = renderChangesetsMenu(req, rbOf(req), state);

    expectButtons(inspect(toString(result.html)), buttons);
    expect(result.previewLink).toBe(previewLink);
  });

  it.each([
    { item: 'assignments', state: UNPUBLISHED },
    { item: 'edit', state: UNPUBLISHED },
  ])('js-encodes the preview link on $item', ({ item, state }) => {
    const req = requestOf(S2, item, { changesetid: OPEN_ID });

    const result = renderChangesetsMenu(req, rbOf(req), { ...state, previewLink: QUOTED_LINK });
    const onclicks = inspect(toString(result.html)).anchors.map((a) => a.onclick).filter((o) => o !== undefined);

    expect(encodeJs(QUOTED_LINK)).not.toContain("'");
    expect(onclicks).toEqual([`return preview('${encodeJs(QUOTED_LINK)}','');`]);
    expect(result.previewLink).toBe(QUOTED_LINK);
  });

  it.each([
    { circuit: CIRCUIT, item: 'save', action: 'core:cchangesets.save' },
    { circuit: 'cPerm', item: 'module', action: 'core:cperm.module' },
  ])('renders an empty menu on $action', ({ circuit, item, action }) => {
    const req = requestOf(S2, item, { changesetid: OPEN_ID }, circuit);
    expect(req.action).toBe(action);

    const inspected = inspect(toString(renderChangesetsMenu(req, rbOf(req), UNPUBLISHED).html));

    expect(inspected.anchors).toEqual([]);
    expect(inspected.links).toEqual([]);
  });

  it('url-encodes the site id in every href', () => {
    const site = 'tenant a';
    expect(encodeUrl(site)).not.toBe(site);
    const render = (item: string, state?: ChangesetMenuState): Inspected => {
      const req = requestOf(S2, item, { siteid: site, changesetid: OPEN_ID });
      return inspect(toString(renderChangesetsMenu(req, rbOf(req), state).html));
    };

    expectButtons(render('assignments', UNPUBLISHED), [back(site), viewEdit(site, OPEN_ID), preview(PREVIEW_LINK)]);
    expectButtons(render('list'), [add(site), permissions(site)]);
    expectButtons(render('edit', UNPUBLISHED), [
      back(site),
      viewAssignments(site, OPEN_ID),
      preview(PREVIEW_LINK),
    ]);
  });
});

describe('cchangesetsSecondaryMenu', () => {
  it('renders the list menu', () => {
    const req = requestOf(S2, 'list');

    expect(toString(menuHook(req))).toBe(toString(renderChangesetsMenu(req, rbOf(req)).html));
    expectButtons(inspect(toString(menuHook(req))), [add(SITE), permissions(SITE)]);
  });

  it('renders an empty menu on save', () => {
    const req = requestOf(S2, 'save');

    expect(inspect(toString(menuHook(req))).anchors).toEqual([]);
  });
});
