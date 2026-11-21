// Unit tests for the cArch content nav as the shell renders it: the registry hook over a screen context.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { carchContentNav } from '@/screens/carch/content-nav';
import { shellHooks, type ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// Byte equality with dsp_content_nav.cfm per locale, and label encoding, are content-nav-hook.test.ts's; not repeated.

const ITEMS = [
  { id: 'newZoom', icon: 'mi-search-plus', key: 'sitemanager.zoom' },
  { id: 'newContent', icon: 'mi-plus', key: 'sitemanager.addcontent' },
  { id: 'newCopy', icon: 'mi-copy', key: 'sitemanager.copy' },
  { id: 'newCopyAll', icon: 'mi-sitemap', key: 'sitemanager.copyall' },
  { id: 'newPaste', icon: 'mi-paste', key: 'sitemanager.paste' },
] as const;

const DIALOG =
  /<div id="newContentDialog" title="Add New Content" class="hide">\s*<p>\s*<span class="ui-icon ui-icon-alert" style="float:left; margin:0 7px 20px 0;"><\/span>\s*<span id="newContentContainer"><\/span>\s*<\/p>\s*<\/div>/;

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

const screenContext = (): ScreenContext =>
  makeScreenContext({ req: adminS2Request(), gateway: fakeGatewayClient({}) });

/** The content nav `ctx`'s shell hooks render for its request. */
function renderNav(ctx: ScreenContext): string {
  const hook = ctx.hooks.contentNav;
  if (hook === undefined) throw new Error('The screen context has no content nav hook');
  const markup = hook(ctx.req);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

describe('carchContentNav as the shell hook', () => {
  it('is the registry content nav', () => {
    expect(shellHooks.contentNav).toBe(carchContentNav);
    expect(screenContext().hooks.contentNav).toBe(carchContentNav);
  });

  it('opens the hidden menu and its option list', () => {
    const out = renderNav(screenContext());
    expect(out).toContain('<div id="newContentMenu" class="addNew hide">');
    expect(out).toContain('<ul id="newContentOptions">');
    expect(out.indexOf('<ul id="newContentOptions">')).toBeGreaterThan(out.indexOf('<div id="newContentMenu"'));
  });

  it('lists zoom, add, copy, copy all and paste with empty hrefs and the context labels', () => {
    const ctx = screenContext();
    const out = renderNav(ctx);
    const labels = ITEMS.map(({ key }) => ctx.rb.rbKey(key));
    expect(labels.filter((label) => label.endsWith('_missing'))).toEqual([]);

    expect(fragmentModel(out).links).toEqual(labels.map((text) => ({ href: '', text })));
    const ids = [...out.matchAll(/<li id="([^"]*)"><a href="" id="([^"]*)">/g)].map(([, li, a]) => [li, a]);
    expect(ids).toEqual(ITEMS.map(({ id }) => [id, `${id}Link`]));
    for (const [n, { id, icon }] of ITEMS.entries()) {
      expect(out).toContain(`<li id="${id}"><a href="" id="${id}Link"><i class="${icon}"></i>${labels[n]}</a></li>`);
    }
  });

  it('renders the hidden new-content dialog after the menu', () => {
    const out = renderNav(screenContext());
    expect(out).toContain('<div id="newContentDialog" title="Add New Content" class="hide">');
    expect(out).toContain('<span class="ui-icon ui-icon-alert" style="float:left; margin:0 7px 20px 0;"></span>');
    expect(out).toContain('<span id="newContentContainer"></span>');
    expect(out).toMatch(DIALOG);
    expect(out.indexOf('<div id="newContentDialog"')).toBeGreaterThan(out.indexOf('</ul>'));
  });
});
