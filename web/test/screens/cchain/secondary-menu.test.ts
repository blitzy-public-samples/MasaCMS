// The approval-chain toolbar against cchain/dsp_secondary_menu.cfm, labelled from the real en_US bundles.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeUrl, isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderCchainSecondaryMenu, type CchainMenuChain } from '@/screens/cchain/dsp_secondary_menu';
import { shellHooks } from '@/screens/registry';
import { APPROVAL_CHAIN_IDS, NEW_APPROVAL_CHAIN_ID } from '../../fixtures/strategies-content/approval-chains';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl, type DomLink } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

const SITE = 'tenant-a';
const UNSAFE_SITE = 'tenant a&b';
const CHAIN_ID = APPROVAL_CHAIN_IDS.standard;
const SAVED: CchainMenuChain = { chainId: CHAIN_ID, isNew: false };
const UNSAVED: CchainMenuChain = { chainId: NEW_APPROVAL_CHAIN_ID, isNew: true };
const WRAPPER_CLASS = 'nav-module-specific btn-group';

/** A toolbar link as legacy emits it: literal href, en_US label and icon class. */
interface MenuLink {
  readonly href: string;
  readonly label: string;
  readonly icon: string;
}

const BACK: MenuLink = {
  href: `./?muraAction=cchain.list&siteid=${SITE}`,
  label: 'Back to Approval Chains',
  icon: 'mi-arrow-circle-left',
};
const VIEW_EDIT: MenuLink = {
  href: `./?muraAction=cchain.edit&siteid=${SITE}&chainID=${CHAIN_ID}`,
  label: 'View Edit Form',
  icon: 'mi-pencil',
};
const ADD: MenuLink = {
  href: `./?muraAction=cchain.edit&chainID=&siteid=${SITE}`,
  label: 'Add Approval Chain',
  icon: 'mi-plus-circle',
};
const PENDING: MenuLink = {
  href: `./?muraAction=cchain.pending&siteid=${SITE}&chainID=${CHAIN_ID}`,
  label: 'Pending Requests',
  icon: 'mi-reorder',
};

/** One element child of the wrapper, as its markup holds it. */
interface MenuChild {
  readonly tag: string;
  readonly href: string | undefined;
  readonly className: string | undefined;
  readonly title: string | undefined;
  readonly inner: string | null;
}

/** The wrapper's element children, its text and the parity model's links. */
interface RenderedMenu {
  readonly children: MenuChild[];
  readonly text: string;
  readonly links: DomLink[];
}

/** The site admin's request on `cChain.<item>` for `siteid`. */
function requestFor(item: string, siteid: string = SITE): AdminRequest {
  const req = siteAdminRequest(SITE, { circuit: 'cChain', item, rc: { siteid } });
  expect(req.action).toBe(`core:cchain.${item}`);
  return req;
}

/** Renders the toolbar with the screen context's bundles, checking its single wrapper root. */
function render(req: AdminRequest, chain?: CchainMenuChain): RenderedMenu {
  const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({}) });
  const markup = renderCchainSecondaryMenu(ctx.req, ctx.rb, chain);
  expect(isSafeHtml(markup)).toBe(true);
  expect(ctx.gateway.calls).toEqual([]);
  const html = toString(markup);
  const $ = cheerio.load(html, null, false);
  const roots = $.root().children();
  expect(roots).toHaveLength(1);
  const root = roots.first();
  expect(root.is('div')).toBe(true);
  expect(root.attr('class')).toBe(WRAPPER_CLASS);
  const children = root
    .children()
    .toArray()
    .map((el): MenuChild => {
      const child = $(el);
      return {
        tag: el.tagName,
        // Raw, because the model's normalised href reorders parameters and re-encodes the site id.
        href: child.attr('href'),
        className: child.attr('class'),
        title: child.attr('title'),
        inner: child.html(),
      };
    });
  return { children, text: root.text(), links: fragmentModel(html).links };
}

/** Asserts the toolbar holds exactly `expected`, in order. */
function expectLinks(menu: RenderedMenu, expected: readonly MenuLink[]): void {
  expect(menu.links).toEqual(expected.map((link) => ({ href: normaliseAdminUrl(link.href), text: link.label })));
  expect(menu.children).toEqual(
    expected.map(
      (link): MenuChild => ({
        tag: 'a',
        href: link.href,
        className: 'btn',
        title: link.label,
        inner: `<i class="${link.icon}"></i> ${link.label}`,
      }),
    ),
  );
}

/** The `siteid=` value of a literal admin href. */
function siteidOf(href: string | undefined): string | undefined {
  return (href ?? '')
    .split(/[?&]/)
    .find((param) => param.startsWith('siteid='))
    ?.slice('siteid='.length);
}

describe('renderCchainSecondaryMenu', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = useTestEnv();
  });

  afterEach(() => {
    restore();
  });

  it('pending: back and edit links', () => {
    expectLinks(render(requestFor('pending'), SAVED), [BACK, VIEW_EDIT]);
  });

  it('list: add link', () => {
    expectLinks(render(requestFor('list')), [ADD]);
  });

  it('edit of a saved chain: back and pending links', () => {
    expectLinks(render(requestFor('edit'), SAVED), [BACK, PENDING]);
  });

  it('edit of a new chain: back link only', () => {
    expectLinks(render(requestFor('edit'), UNSAVED), [BACK]);
  });

  it.each(['update', 'save', 'delete'])('%s: empty wrapper', (item) => {
    const menu = render(requestFor(item), SAVED);
    expect(menu.children).toEqual([]);
    expect(menu.text.trim()).toBe('');
    expect(menu.links).toEqual([]);
  });

  it.each<[string, CchainMenuChain | undefined, number]>([
    ['pending', SAVED, 2],
    ['list', undefined, 1],
    ['edit', SAVED, 2],
  ])('%s: URL-encodes the site id', (item, chain, count) => {
    expect(encodeUrl(UNSAFE_SITE)).not.toBe(UNSAFE_SITE);
    const req = adminS2Request({ circuit: 'cChain', item, rc: { siteid: UNSAFE_SITE } });
    expect(req.action).toBe(`core:cchain.${item}`);
    const { children } = render(req, chain);
    expect(children).toHaveLength(count);
    for (const child of children) expect(siteidOf(child.href)).toBe(encodeUrl(UNSAFE_SITE));
  });

  it('is not a shell hook', () => {
    expect(shellHooks.secondaryMenus).toHaveProperty('carch');
    expect(shellHooks.secondaryMenus).not.toHaveProperty('cchain');
  });
});
