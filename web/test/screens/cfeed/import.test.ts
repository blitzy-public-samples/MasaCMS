// cFeed.import1 for the tenant-a site admin against admin/core/views/cfeed/import1.cfm, beside coverage.test.ts's cases.
// cFeed.import2 has no web screen: it is a withheld decision-list action (it writes tcontenteventreminders) on legacy.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import type { ServicePath } from '@/lib/gateway-client';
import { toString } from '@/lib/html';
import { cfeedGate } from '@/screens/cfeed/before';
import { cfeedImport1Screen, loadCfeedImport1, renderCfeedImport1 } from '@/screens/cfeed/import1';
import { cfeedAjaxScripts } from '@/screens/cfeed/js';
import { FEED_IDS } from '../../fixtures/strategies-content/feeds';
import { siteAdminRequest } from '../../helpers/admin-request';
import { domModel, fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// The screen context reads only the registry's shell hooks, so the circuit barrels stay unloaded.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

type AdminViewModel = components['schemas']['AdminViewModel'];

const SITE = 'tenant-a';
const IMPORT_PATH: ServicePath = `/v1/sites/${SITE}/feeds/${FEED_IDS.remoteRss}/import`;
const FEED_NAME = 'Partner Updates & Notices';
const NEW_ID = '8F14E45FCEEA167A5A36DEDD4BEA2543';
const EXISTING_ID = 'C9F0F895FB98AB9159F51FD0297E236D';
const IMAGE_ID = '45C48CCE2E2D7FBDEA1AFC51C7C6AD26';

// previewFeedImport items: new, already imported with a changed pubDate, and new with image markup in its description.
const ITEMS = Object.freeze([
  {
    remoteID: NEW_ID,
    link: 'https://feeds.example.test/partner/grant-round',
    title: 'Grant round <2026> opens',
    description: '<p>Applications open in July.</p>',
    isNew: true,
  },
  {
    remoteID: EXISTING_ID,
    link: 'https://feeds.example.test/partner/program-review',
    title: 'Program review',
    description: 'Quarterly summary.',
    isNew: false,
  },
  {
    remoteID: IMAGE_ID,
    link: 'https://feeds.example.test/partner/photos?id=3&lang=en',
    title: 'Site visit photos',
    description: '<img src="x.png"><br><br>text',
    isNew: true,
  },
] as const);

// import1.cfm lines 79-88, byte for byte.
const LEGACY_STYLE = [
  '\t.mura-import-item img{',
  '\t\tmax-width: 200px !important;',
  '\t\tmargin-top: .5em !important;',
  '\t}',
  '\t.mura-import-item br:first-child,',
  '\t.mura-import-item br:first-child + br{',
  '\t\tdisplay: none;',
  '\t}',
].join('\n');

const preview = (version: string, items: readonly unknown[] = ITEMS): AdminViewModel => ({
  rc: { feedBean: { name: FEED_NAME, version }, items },
});

/** The tenant-a site admin on cFeed.import1 of the remote RSS collection, answered with `body`. */
function contextFor(body: AdminViewModel): ReturnType<typeof makeScreenContext> {
  const req = siteAdminRequest(SITE, {
    circuit: 'cfeed',
    item: 'import1',
    rc: { siteid: SITE, feedID: FEED_IDS.remoteRss },
    site: { hasFeedManager: true },
  });
  const gateway = fakeGatewayClient({ [routeKey('GET', 'strategies-content', IMPORT_PATH)]: { status: 200, body } });
  return makeScreenContext({ req, gateway });
}

/** The view body loaded and rendered for `body`, with its parsed fragment and DOM model. */
async function renderImport(body: AdminViewModel = preview('RSS 2.0')) {
  const ctx = contextFor(body);
  const view = renderCfeedImport1(ctx, await loadCfeedImport1(ctx));
  const markup = toString(view.body);
  return { view, markup, $: cheerio.load(markup, null, false), model: fragmentModel(markup) };
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('cFeed.import1 for the tenant-a site admin', () => {
  it('serves the page in the shell from one preview call for rc.feedID', async () => {
    const ctx = contextFor(preview('RSS 2.0'));

    const page = await renderScreenPage(cfeedImport1Screen, ctx);

    expect(page.kind).toBe('document');
    expect(ctx.gateway.calls.filter(({ path }) => path.includes(FEED_IDS.remoteRss))).toEqual([
      { service: 'strategies-content', method: 'GET', path: IMPORT_PATH },
    ]);
    if (page.kind !== 'document') return;
    expect(domModel(page.html).headings).toEqual(expect.arrayContaining(['Remote Feed Import Selection', FEED_NAME]));
  });

  it('posts the selection form to cFeed.import2 with the legacy attributes, the feed name written raw', async () => {
    const { $, markup } = await renderImport();

    expect($('form').attr()).toEqual({
      novalidate: 'novalidate',
      action: `./?muraAction=cFeed.import2&feedid=${FEED_IDS.remoteRss}&siteid=${SITE}`,
      method: 'post',
      name: 'contentForm',
      onsubmit: 'return false;',
    });
    expect($('form > h2').text()).toBe(FEED_NAME);
    expect(markup).toContain(`<h2>${FEED_NAME}</h2>`);
  });

  it('offers every previewed item checked, its remote id unchanged, under an Import label', async () => {
    const { $, markup, model } = await renderImport();
    const rows = $('div.mura-layout-row.mura-import-item.clearfix');

    expect(rows).toHaveLength(3);
    const boxes = rows.find('input[name="remoteID"]').toArray().map((el) => $(el));
    expect(boxes.map((box) => [box.attr('type'), box.attr('value'), box.is('[checked]')])).toEqual([
      ['checkbox', NEW_ID, true],
      ['checkbox', EXISTING_ID, true],
      ['checkbox', IMAGE_ID, true],
    ]);
    for (const id of [NEW_ID, EXISTING_ID, IMAGE_ID]) expect(markup).toContain(`value="${id}" type="checkbox" checked>`);
    expect(model.labels.filter((text) => text === 'Import')).toHaveLength(3);
  });

  it('links each item in a new window, encoding the title and marking content already imported', async () => {
    const { $, markup } = await renderImport();
    const links = $('.mura-import-item a').toArray().map((el) => $(el));

    expect(links.map((link) => [link.attr('href'), link.attr('target'), link.text()])).toEqual([
      [ITEMS[0].link, '_blank', 'Grant round <2026> opens'],
      [ITEMS[1].link, '_blank', 'Program review [Update]'],
      [ITEMS[2].link, '_blank', 'Site visit photos'],
    ]);
    expect(markup).toContain('>Grant round &lt;2026&gt; opens</a>');
    expect(markup).not.toContain('Grant round <2026>');
  });

  it('writes each description as markup, so the image and its line breaks are elements', async () => {
    const { $, markup } = await renderImport();
    const description = $('.mura-import-item').eq(2).children('.mura-12').eq(1);

    expect(description.find('img').attr('src')).toBe('x.png');
    expect(description.find('br')).toHaveLength(2);
    expect(description.text()).toBe('text');
    expect(markup).toContain('<div class="mura-12"><img src="x.png"><br><br>text</div>');
  });

  it('ends the form with the Import button and the hidden import action', async () => {
    const { $ } = await renderImport();
    const button = $('form .mura-actions .form-actions > button');

    expect(button.attr()).toEqual({ class: 'btn mura-primary', onclick: 'feedManager.confirmImport();' });
    expect(button.children('i.mi-sign-in')).toHaveLength(1);
    expect(button.text()).toBe('Import');
    expect($('form > input[name="action"]').attr()).toEqual({ type: 'hidden', name: 'action', value: 'import' });
  });

  it('opens with the legacy style block and the header with only the Back to Collections link', async () => {
    const { $, markup, view, model } = await renderImport();

    expect($('style').attr()).toEqual({ type: 'text/css' });
    expect($('style').text()).toBe(`\n${LEGACY_STYLE}\n`);
    expect(markup.indexOf('<style')).toBeLessThan(markup.indexOf('<div class="mura-header">'));
    expect($('div.mura-header > h1').text()).toBe('Remote Feed Import Selection');
    expect($('div.mura-header .nav-module-specific a')).toHaveLength(1);
    expect($('div.mura-header .nav-module-specific a > i.mi-arrow-circle-left')).toHaveLength(1);
    expect(model.links[0]).toEqual({
      href: normaliseAdminUrl(`./?muraAction=cFeed.list&siteid=${SITE}`),
      text: 'Back to Collections',
    });
    expect(markup).toContain(`<a class="btn" href="./?muraAction=cFeed.list&siteid=${SITE}">`);
    expect(view.ajax === undefined ? undefined : toString(view.ajax)).toBe(toString(cfeedAjaxScripts()));
  });

  it("keeps the form and feed name for the stored 'atom' version, with only the not-supported notice", async () => {
    const { $, model } = await renderImport(preview('atom'));

    expect($('form').attr('name')).toBe('contentForm');
    expect($('form > h2').text()).toBe(FEED_NAME);
    expect($('form > p').text()).toBe('This format is currently not supported.');
    expect($('input[name="remoteID"]')).toHaveLength(0);
    expect($('input[name="action"]')).toHaveLength(0);
    expect(model.buttons).toEqual([]);
  });

  it('keeps the form, Import button and hidden action for an RSS feed with nothing to import', async () => {
    const { $, model } = await renderImport(preview('RSS 2.0', []));

    expect($('form').attr('action')).toBe(`./?muraAction=cFeed.import2&feedid=${FEED_IDS.remoteRss}&siteid=${SITE}`);
    expect($('.mura-import-item')).toHaveLength(0);
    expect(model.controls.map(({ name, type, value }) => [name, type, value])).toEqual([['action', 'hidden', 'import']]);
    expect(model.buttons).toEqual([{ text: 'Import', type: 'submit', hasOnclick: true }]);
  });

  it('is a frozen strategies-content page behind the cfeed before() gate', () => {
    expect(cfeedImport1Screen).toEqual({
      circuit: 'cfeed',
      action: 'import1',
      owner: 'strategies-content',
      mode: 'page',
      gate: cfeedGate,
      load: loadCfeedImport1,
      render: renderCfeedImport1,
    });
    expect(Object.isFrozen(cfeedImport1Screen)).toBe(true);
  });
});
