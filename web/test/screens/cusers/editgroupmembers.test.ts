// cUsers.editGroupMembers against cusers/editgroupmembers.cfm, inc/dsp_users_list.cfm and cusers.cfc editGroup() (219-241, 263-265).
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editGroupMembersScreen } from '@/screens/cusers/editgroupmembers';
import { cusersGate } from '@/screens/cusers/gate';
import {
  GROUP_IDS,
  adminGroupMembers,
  defaultEditorGroup,
  editorGroupMembers,
  emptyGroupMembers,
} from '../../fixtures/identity/groups';
import { adminS2Request, editorRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseIds, type DomLink, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import {
  fakeGatewayClient,
  routeKey,
  type FakeGatewayClient,
  type FakeReply,
  type RecordedRequest,
} from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The registry pulls in every circuit's screens; the shell reads only its hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type Member = (typeof editorGroupMembers)[number];
type Group = typeof defaultEditorGroup;
type Ctx = ReturnType<typeof makeScreenContext>;

const GROUP_ID = GROUP_IDS.defaultEditor;
const SITE_ID = 'default';
const ADMIN = '/admin/index.cfm?muraAction=';
const ACTION = 'core:cusers.editgroupmembers';
const MEMBERS_PATH = `/v1/groups/${GROUP_ID}/members` as const;
const GROUP_READ = { method: 'GET', path: `/v1/groups/${GROUP_ID}`, query: undefined } as const;

/** identity `listGroupMembers` over `listing`, paged by the request's offset and limit. */
function membersRoute(listing: readonly Member[]): (request: RecordedRequest) => FakeReply {
  return ({ query }) => {
    const offset = Number(query.offset ?? '0');
    const limit = Number(query.limit ?? '1000');
    const items = listing.slice(offset, offset + limit);
    const next = offset + items.length;
    return { status: 200, body: { items, total: listing.length, nextOffset: next < listing.length ? next : null } };
  };
}

interface Setup {
  readonly rc?: Readonly<Record<string, string>>;
  readonly members?: readonly Member[];
  readonly group?: Group;
}

/** The S2 admin on `default` opening `cusers.editgroupmembers`, identity serving `group` with `members`. */
function context({ rc = { userid: GROUP_ID }, members = editorGroupMembers, group = defaultEditorGroup }: Setup = {}): Ctx {
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'identity', `/v1/groups/${GROUP_ID}`)]: { status: 200, body: { group, isNew: false } },
    [routeKey('GET', 'identity', MEMBERS_PATH)]: membersRoute(members),
  });
  const req = adminS2Request({ circuit: 'cusers', item: 'editgroupmembers', rc: { siteid: SITE_ID, ...rc } });
  return makeScreenContext({ req, gateway });
}

interface Page {
  readonly html: string;
  readonly $: CheerioAPI;
}

/** The page inside the shell; a redirect fails the test. */
async function render(ctx: Ctx): Promise<Page> {
  const page = await renderScreenPage(editGroupMembersScreen, ctx);
  if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);
  return { html: page.html, $: cheerio.load(page.html) };
}

/** The masked model of the first element matching `selector`. */
const modelOf = ($: CheerioAPI, selector: string): DomModel => normaliseIds(fragmentModel($.html($(selector).first())));

/** identity's group reads, the group itself first, then the member windows in call order. */
const groupCalls = (gateway: FakeGatewayClient): Array<{ method: string; path: string; query: unknown }> =>
  gateway.calls
    .filter(({ service, path }) => service === 'identity' && path.startsWith('/v1/groups/'))
    .map(({ method, path, query }) => ({ method: method.toUpperCase(), path, query }))
    .sort((a, b) => a.path.length - b.path.length);

/** `[name, value]` of each hidden field of `form#frmNextN`. */
const nextNFields = ($: CheerioAPI): Array<[string, string]> =>
  $('form#frmNextN input[type="hidden"]')
    .toArray()
    .map((el): [string, string] => [$(el).attr('name') ?? '', $(el).attr('value') ?? '']);

/** Masked id, name, mailto target, email and isPublic of each Editor group member, in listing order. */
const EDITOR_ROWS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['<id:1>', 'Author, Avery', 'avery_author%40example.com', 'avery_author@example.com', '0'],
  ['<id:3>', 'Editor, Quinn', 'qa_editor%40example.com', 'qa_editor@example.com', '0'],
  ['<id:4>', 'Member, Nadia', 'no_sites_member%40example.com', 'no_sites_member@example.com', '1'],
];

/** The links of one member row: menu toggle, edit, remove, delete, name and email. */
function memberLinks([id, name, mailto, email, isPublic]: (typeof EDITOR_ROWS)[number], group: string): DomLink[] {
  const edit = `${ADMIN}cusers.edituser&siteid=default&userid=${id}`;
  return [
    { href: 'javascript:;', text: '' },
    { href: edit, text: 'Edit' },
    {
      href: `${ADMIN}cusers.removefromgroup&groupid=${group}&routeid=${group}&siteid=default&userid=${id}`,
      text: 'Remove User From Group',
    },
    {
      href: `${ADMIN}cusers.update&action=delete&csrf_token=<token>&csrf_token_expires=<token>&ispublic=${isPublic}&siteid=default&type=1&userid=${id}`,
      text: 'Delete',
    },
    { href: edit, text: name },
    { href: `mailto:${mailto}`, text: email },
  ];
}

describe('cUsers.editGroupMembers', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = useTestEnv();
  });
  afterEach(() => {
    restore();
  });

  it('is the identity-owned page behind the cUsers gate', () => {
    expect(editGroupMembersScreen).toMatchObject({
      circuit: 'cusers',
      action: 'editgroupmembers',
      owner: 'identity',
      mode: 'page',
      gate: cusersGate,
    });
  });

  it('refuses qa_editor, who lacks the Users module, before reading the group', async () => {
    const req = editorRequest({ circuit: 'cusers', item: 'editgroupmembers', rc: { userid: GROUP_ID } });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient() });

    const page = await renderScreenPage(editGroupMembersScreen, ctx);

    expect(page).toEqual({ kind: 'redirect', location: './' });
    expect(groupCalls(ctx.gateway)).toEqual([]);
  });

  it.each<[string, Record<string, string>]>([
    ['rc.userid', { userid: GROUP_ID }],
    ['rc.groupid over another rc.userid', { groupid: GROUP_ID, userid: GROUP_IDS.defaultAdmin }],
    ['rc.userid beside an empty rc.groupid', { groupid: '', userid: GROUP_ID }],
  ])('loads the group named by %s', async (_form, rc) => {
    const baseline = await render(context());
    const ctx = context({ rc });

    const { $ } = await render(ctx);

    expect(groupCalls(ctx.gateway)).toEqual([
      GROUP_READ,
      { method: 'GET', path: MEMBERS_PATH, query: { offset: '0', limit: '25' } },
    ]);
    expect($('#mura-content').html()).toBe(baseline.$('#mura-content').html());
  });

  it('renders the header buttons, with Download for a group with members', async () => {
    const { $ } = await render(context());

    expect(modelOf($, '.mura-header')).toMatchObject({
      headings: ['Group Maintenance Form'],
      links: [
        { href: '#', text: 'Back' },
        { href: `${ADMIN}cusers.list`, text: 'View All Groups' },
        { href: `${ADMIN}cusers.editgroup&siteid=default&userid=<id:1>`, text: 'Edit Group Settings' },
        { href: `${ADMIN}cusers.downloadgroupmembers&userid=<id:1>`, text: 'Download' },
      ],
    });
    const buttons = $('.mura-header .nav-module-specific a.btn');
    expect(buttons.first().attr('title')).toBe('Back');
    expect(buttons.first().attr('onclick')).toBe('actionModal();window.history.back(); return false;');
    expect(buttons.toArray().slice(2).map((el) => $(el).attr('href'))).toEqual([
      `${ADMIN}cusers.editgroup&userid=${GROUP_ID}&siteid=default`,
      `${ADMIN}cusers.downloadgroupmembers&userid=${GROUP_ID}`,
    ]);
  });

  it('omits Download and shows the empty notice for a group without members', async () => {
    const ctx = context({ members: emptyGroupMembers });

    const { $ } = await render(ctx);

    expect(modelOf($, '.mura-header').links.map(({ text }) => text)).toEqual([
      'Back',
      'View All Groups',
      'Edit Group Settings',
    ]);
    expect($('#mura-content div.help-block-empty').text().trim()).toBe('This group has no members.');
    expect($('table#tbl-users, form#frmNextN')).toHaveLength(0);
    expect(groupCalls(ctx.gateway)).toEqual([
      GROUP_READ,
      { method: 'GET', path: MEMBERS_PATH, query: { offset: '0', limit: '25' } },
    ]);
  });

  it('heads the list with the HTML-encoded group name and Users', async () => {
    const group: Group = { ...defaultEditorGroup, GroupName: 'R&D <Team> "A"' };

    const { html, $ } = await render(context({ group }));

    expect(html).toContain('<strong>R&amp;D &lt;Team&gt; &quot;A&quot;</strong> Users');
    expect(modelOf($, '#mura-content').headings).toEqual(['Group Maintenance Form', 'R&D <Team> "A" Users']);
  });

  it('lists one row per member with edit, remove-from-group and delete actions', async () => {
    const { $ } = await render(context());

    const model = modelOf($, 'table#tbl-users');

    expect(model.tables).toEqual([
      {
        headers: ['', '', 'User', 'Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'],
        rows: [
          ['Edit Remove User From Group Delete', '', 'Author, Avery', 'avery_author@example.com', '06/163/2026', '11:20 AM', 'Admin User'],
          ['Edit Remove User From Group Delete', '', 'Editor, Quinn', 'qa_editor@example.com', '02/41/2026', '10:00 AM', 'Admin User'],
          ['Edit Remove User From Group Delete', '', 'Member, Nadia', 'no_sites_member@example.com', '04/110/2026', '2:00 PM', 'Admin User'],
        ],
      },
    ]);
    expect(model.links).toEqual(EDITOR_ROWS.flatMap((row) => memberLinks(row, '<id:2>')));
    const removes = $('table#tbl-users li.remove a')
      .toArray()
      .map((el) => [$(el).attr('href'), $(el).attr('onclick')]);
    expect(removes).toEqual(
      editorGroupMembers.map((member) => [
        `${ADMIN}cusers.removefromgroup&userid=${member.userID}&routeid=${GROUP_ID}&groupid=${GROUP_ID}&siteid=default`,
        "return confirmDialog('Remove User From Group',this.href)",
      ]),
    );
    expect(nextNFields($)[0]).toEqual(['muraAction', ACTION]);
    expect($('ul.pagination')).toHaveLength(0);
  });

  it('pages the members past recordsperpage, frmNextN posting back to the action', async () => {
    const ctx = context({ members: adminGroupMembers, rc: { userid: GROUP_ID, recordsperpage: '1', startrow: '2' } });

    const { $ } = await render(ctx);

    expect(groupCalls(ctx.gateway)).toEqual([
      GROUP_READ,
      { method: 'GET', path: MEMBERS_PATH, query: { offset: '0', limit: '1' } },
      { method: 'GET', path: MEMBERS_PATH, query: { offset: '1', limit: '1' } },
    ]);
    expect(modelOf($, 'table#tbl-users').tables[0]?.rows.map((row) => row[2])).toEqual(['Webmaster, Wren']);
    expect(ctx.req.action).toBe(ACTION);
    expect(nextNFields($)).toEqual([
      ['muraAction', ACTION],
      ['siteid', 'default'],
      ['ispublic', '1'],
      ['unassigned', '0'],
      ['recordsperpage', '1'],
      ['startrow', '2'],
    ]);
    expect($('ul.pagination li.active').text().trim()).toBe('2');
  });
});
