// renderCfeedSecondaryMenu and the shell's cfeed hook against cfeed/dsp_secondary_menu.cfm.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Roles, moduleRole } from '@opt2/platform/auth';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import {
  cfeedSecondaryMenu,
  renderCfeedSecondaryMenu,
  type CfeedMenuFeed,
  type CfeedMenuOptions,
} from '@/screens/cfeed/secondary-menu';
import type { ShellHooks } from '@/shell/types';
import { FEED_API_ENDPOINT, FEED_IDS } from '../../fixtures/strategies-content/feeds';
import { adminS2Request, makeAdminRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { makeScreenContext } from '../../helpers/screen-context';
import { SUBJECTS } from '../../helpers/tokens';

const COLLECTIONS_MODULE_ID = '00000000000000000000000000000000011';
const SITE_MANAGER_MODULE_ID = '00000000000000000000000000000000000';
const LIST = { circuit: 'cFeed', item: 'list' } as const;
const EDIT = { circuit: 'cFeed', item: 'edit' } as const;
const SITE = 'tenant-a';
const CHANNEL_LINK = 'https://news.example.test/rss.xml';

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The list menu's links on `siteid`: both Add links, then Permissions when `permissions`. */
function listLinks(siteid: string, permissions: boolean): DomLink[] {
  const add = (type: string, text: string): DomLink => ({
    href: `./?muraAction=cfeed.edit&feedID=&siteid=${siteid}&type=${type}`,
    text,
  });
  const module = COLLECTIONS_MODULE_ID;
  const perm: DomLink = {
    href: `./?muraAction=cperm.module&contentid=${module}&moduleid=${module}&siteid=${siteid}`,
    text: 'Permissions',
  };
  return [add('Local', 'Add Local Index'), add('Remote', 'Add Remote Feed'), ...(permissions ? [perm] : [])];
}

/** One link's attributes as written, and the class of its icon. */
interface LinkAttrs {
  href: string | undefined;
  title: string | undefined;
  target: string | undefined;
  className: string | undefined;
  icon: string | undefined;
}

const fragment = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);

function linkAttrs(markup: string): LinkAttrs[] {
  const $ = fragment(markup);
  return $('a')
    .toArray()
    .map((el) => {
      const a = $(el);
      return {
        href: a.attr('href'),
        title: a.attr('title'),
        target: a.attr('target'),
        className: a.attr('class'),
        icon: a.children('i').attr('class'),
      };
    });
}

const link = (href: string, icon: string, extra: Partial<LinkAttrs> = {}): LinkAttrs => ({
  href,
  title: undefined,
  target: undefined,
  className: 'btn',
  icon,
  ...extra,
});

/** The list menu's links on the url-encoded `siteid`, attributes as legacy writes them. */
function listAttrs(siteid: string, permissions: boolean): LinkAttrs[] {
  const add = (type: string, title: string): LinkAttrs =>
    link(`./?muraAction=cFeed.edit&feedID=&siteid=${siteid}&type=${type}`, 'mi-plus-circle', { title });
  const module = COLLECTIONS_MODULE_ID;
  const perm = link(`./?muraAction=cPerm.module&contentid=${module}&siteid=${siteid}&moduleid=${module}`, 'mi-group', {
    className: 'btn ',
  });
  return [add('Local', 'Add Local Index'), add('Remote', 'Add Remote Feed'), ...(permissions ? [perm] : [])];
}

const backAttrs = (siteid: string): LinkAttrs =>
  link(`./?muraAction=cFeed.list&siteid=${siteid}`, 'mi-arrow-circle-left');

const BACK_LINK: DomLink = { href: `./?muraAction=cfeed.list&siteid=${SITE}`, text: 'Back to Collections' };

const viewAttrs = (href: string): LinkAttrs => link(href, 'mi-rss', { title: 'View', target: '_blank' });

const savedFeed = (feed: Partial<CfeedMenuFeed> = {}): CfeedMenuFeed => ({
  feedId: FEED_IDS.localIndex,
  type: 'Local',
  isNew: false,
  channelLink: '',
  ...feed,
});

/** The menu markup for `req` with the bundle a screen context resolves. */
const render = (req: AdminRequest, options: CfeedMenuOptions): string =>
  toString(renderCfeedSecondaryMenu(req, makeScreenContext({ req }).rb, options));

/** The tenant-a system user holding the Collections module grant only. */
const collectionsUserRequest = (): AdminRequest =>
  makeAdminRequest(
    {
      ...LIST,
      session: { siteid: SUBJECTS.systemUser.site },
      user: { roles: [Roles.systemUser, moduleRole(COLLECTIONS_MODULE_ID)] },
    },
    'systemUser',
  );

describe('cfeedSecondaryMenu Permissions on list', () => {
  it.each(REQUESTED_SITE_CASES)('links Permissions for $who only when it administers that site', (testCase) => {
    const markup = toString(cfeedSecondaryMenu(testCase.request(LIST)));

    expect(fragmentModel(markup).links).toEqual(listLinks(testCase.siteid, testCase.administers));
  });

  it('leaves Permissions out for Collections plus Site Manager module access, which legacy does not check', () => {
    const roles = [Roles.systemUser, moduleRole(COLLECTIONS_MODULE_ID), moduleRole(SITE_MANAGER_MODULE_ID)];
    const markup = toString(cfeedSecondaryMenu(makeAdminRequest({ ...LIST, user: { roles } }, 'qaEditor')));

    expect(fragmentModel(markup).links).toEqual(listLinks('default', false));
  });
});

describe('renderCfeedSecondaryMenu on list', () => {
  it.each<{ who: string; request: () => AdminRequest }>([
    { who: 'the S2 admin', request: () => adminS2Request({ ...LIST, rc: { siteid: SITE } }) },
    { who: 'the tenant-a site admin', request: () => siteAdminRequest(SITE, LIST) },
  ])('links both Add buttons and Permissions for $who', ({ request }) => {
    const markup = render(request(), { fuseaction: 'list' });

    expect(fragmentModel(markup).links).toEqual(listLinks(SITE, true));
    expect(linkAttrs(markup)).toEqual(listAttrs(SITE, true));
  });

  it('url-encodes rc.siteid as ESAPI encodeForURL does', () => {
    const markup = render(adminS2Request({ ...LIST, rc: { siteid: 'tenant a&b' } }), { fuseaction: 'list' });

    expect(linkAttrs(markup)).toEqual(listAttrs('tenant+a%26b', true));
  });

  it('links only the Add buttons for a non-admin with Collections module access', () => {
    const markup = render(collectionsUserRequest(), { fuseaction: 'list' });

    expect(fragmentModel(markup).links).toEqual(listLinks(SITE, false));
    expect(linkAttrs(markup)).toEqual(listAttrs(SITE, false));
  });

  it('matches the fuseaction case-insensitively, as cfswitch does', () => {
    const req = siteAdminRequest(SITE, LIST);

    expect(render(req, { fuseaction: 'LIST' })).toBe(render(req, { fuseaction: 'list' }));
  });
});

describe('renderCfeedSecondaryMenu wrapper', () => {
  it.each(['list', 'edit'])('wraps the %s links in one nav-module-specific button group', (fuseaction) => {
    const $ = fragment(render(siteAdminRequest(SITE, EDIT), { fuseaction }));
    const wrapper = $.root().children();

    expect(wrapper).toHaveLength(1);
    expect(wrapper.is('div')).toBe(true);
    expect(wrapper.attr('class')).toBe('nav-module-specific btn-group');
    expect(wrapper.children('a').length).toBe($('a').length);
  });
});

describe('renderCfeedSecondaryMenu outside list', () => {
  it.each<{ name: string; feed: CfeedMenuFeed | undefined }>([
    { name: 'no collection', feed: undefined },
    { name: 'a new local index', feed: savedFeed({ feedId: FEED_IDS.newFeed, isNew: true }) },
    {
      name: 'a new remote feed',
      feed: savedFeed({ feedId: FEED_IDS.newFeed, type: 'Remote', isNew: true, channelLink: CHANNEL_LINK }),
    },
  ])('links only Back to Collections for $name', ({ feed }) => {
    const markup = render(siteAdminRequest(SITE, EDIT), { fuseaction: 'edit', feed, endpoint: FEED_API_ENDPOINT });

    expect(fragmentModel(markup).links).toEqual([BACK_LINK]);
    expect(linkAttrs(markup)).toEqual([backAttrs(SITE)]);
  });

  it.each(['Local', 'local'])('links a saved %s index to the feed API with its feedID', (type) => {
    const feed = savedFeed({ type });
    const markup = render(siteAdminRequest(SITE, EDIT), { fuseaction: 'edit', feed, endpoint: FEED_API_ENDPOINT });
    const href = `${FEED_API_ENDPOINT}/?feedID=${FEED_IDS.localIndex}`;

    expect(fragmentModel(markup).links).toEqual([BACK_LINK, { href, text: 'View Feed' }]);
    expect(linkAttrs(markup)).toEqual([backAttrs(SITE), viewAttrs(href)]);
  });

  it('links a saved remote feed to its channel link', () => {
    const feed = savedFeed({ feedId: FEED_IDS.remoteRss, type: 'Remote', channelLink: CHANNEL_LINK });
    const markup = render(siteAdminRequest(SITE, EDIT), { fuseaction: 'edit', feed });

    expect(fragmentModel(markup).links).toEqual([BACK_LINK, { href: CHANNEL_LINK, text: 'View Feed' }]);
    expect(linkAttrs(markup)).toEqual([backAttrs(SITE), viewAttrs(CHANNEL_LINK)]);
  });

  it("throws legacy's undefined-variable error for a saved local index without the view's endpoint", () => {
    expect(() => render(siteAdminRequest(SITE, EDIT), { fuseaction: 'edit', feed: savedFeed() })).toThrow(
      new Error('Variable ENDPOINT is undefined.'),
    );
  });

  it.each(['import1', 'import2', 'update'])('follows the default branch for %s', (fuseaction) => {
    const markup = render(siteAdminRequest(SITE, { circuit: 'cFeed', item: fuseaction }), { fuseaction });

    expect(linkAttrs(markup)).toEqual([backAttrs(SITE)]);
  });

  it('url-encodes rc.siteid in the back link', () => {
    const markup = render(adminS2Request({ ...EDIT, rc: { siteid: 'tenant a&b' } }), { fuseaction: 'edit' });

    expect(linkAttrs(markup)).toEqual([backAttrs('tenant+a%26b')]);
  });
});

describe('cfeedSecondaryMenu as the shell hook', () => {
  const hooks: ShellHooks = { secondaryMenus: { cfeed: cfeedSecondaryMenu } };

  it.each<{ item: string; links: DomLink[] }>([
    { item: 'list', links: listLinks(SITE, true) },
    { item: 'edit', links: [BACK_LINK] },
  ])('renders the $item menu from req.item with session.rb labels', ({ item, links }) => {
    const req = siteAdminRequest(SITE, { circuit: 'cFeed', item });
    const hook = hooks.secondaryMenus.cfeed;
    if (hook === undefined) throw new TypeError('The cfeed hook is not installed');
    const markup = toString(hook(req));

    expect(req.action).toBe(`core:cfeed.${item}`);
    expect(markup).toBe(render(req, { fuseaction: item }));
    expect(fragmentModel(markup).links).toEqual(links);
  });
});
