// csettings.loadcustomimages for the tenant-a site admin over the programs-sites fixtures. Missing rc elements,
// imageAction matching, service failures, hostile values and byte parity are in loadcustomimages-fragment.test.ts.
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HTML_CONTENT_TYPE } from '@/lib/responses';
import { loadCustomImagesScreen } from '@/screens/csettings/loadcustomimages';
import {
  DELETE_IMAGE_SIZE_RESULT,
  IMAGE_SIZE_IDS,
  IMAGE_SIZE_LIST_EMPTY,
  IMAGE_SIZE_LIST_TENANT_A,
  SAVE_IMAGE_SIZE_RESULT,
  customImageSizeHeroBanner,
} from '../../fixtures/programs-sites/image-sizes';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

// The registry loads every circuit's screens; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: { secondaryMenus: {} } }));

type Fields = Readonly<Record<string, string>>;
type SizeList = typeof IMAGE_SIZE_LIST_TENANT_A;

const SITE = SITE_IDS.tenantA;
const HERO_ID = IMAGE_SIZE_IDS.heroBanner;
const LIST_PATH = `/v1/sites/${SITE}/image-sizes` as const;
const SIZE_PATH = `${LIST_PATH}/${HERO_ID}` as const;
const LIST_ROUTE = routeKey('GET', 'programs-sites', LIST_PATH);
const SAVE_ROUTE = routeKey('PUT', 'programs-sites', SIZE_PATH);
const DELETE_ROUTE = routeKey('DELETE', 'programs-sites', SIZE_PATH);

const POSTED = { name: 'hero-banner', height: '400', width: '1200' } as const;

// esapiEncode('javascript') escapes '-' as \x2D; the size id is echoed as stored.
const OPEN_HERO = `return openCustomImageSize('${HERO_ID}','tenant\\x2Da');`;

const TENANT_A_TABLE = Object.freeze({
  headers: ['', 'Name', 'Height', 'Width'],
  rows: IMAGE_SIZE_LIST_TENANT_A.map((size) => ['', size.name, size.height, size.width]),
});

/** programs-sites answering the size writes with their contract results and the list GET with `list`. */
const sizeRoutes = (list: SizeList): FakeRouteTable => ({
  [SAVE_ROUTE]: { status: 200, body: SAVE_IMAGE_SIZE_RESULT },
  [DELETE_ROUTE]: { status: 200, body: DELETE_IMAGE_SIZE_RESULT },
  [LIST_ROUTE]: { status: 200, body: list },
});

const callKeys = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.map(({ method, service, path }) => routeKey(method, service, path as `/${string}`));

/** The fragment the admin-raw handler serves for the dialog's post of `rc`: load, then render. */
async function serve(rc: Fields, list: SizeList = IMAGE_SIZE_LIST_TENANT_A) {
  const gateway = fakeGatewayClient(sizeRoutes(list));
  const req = siteAdminRequest(SITE, { circuit: 'csettings', item: 'loadcustomimages', rc: { siteid: SITE, ...rc } });
  const ctx = makeScreenContext({ req, gateway });
  const result = await loadCustomImagesScreen.render(ctx, await loadCustomImagesScreen.load(ctx));
  expect(result.body).not.toBeInstanceOf(Uint8Array);
  return { gateway, result, markup: String(result.body) };
}

describe('csettings.loadcustomimages for the tenant-a site admin', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it.each<{ label: string; rc: Fields; calls: string[]; form?: Fields }>([
    {
      label: 'save',
      rc: { sizeid: HERO_ID, imageAction: 'save', ...POSTED },
      calls: [SAVE_ROUTE, LIST_ROUTE],
      form: { siteid: SITE, sizeid: HERO_ID, ...POSTED },
    },
    { label: 'delete', rc: { sizeid: HERO_ID, imageAction: 'delete' }, calls: [DELETE_ROUTE, LIST_ROUTE] },
    { label: 'save without a sizeid', rc: { sizeid: '', imageAction: 'save', ...POSTED }, calls: [LIST_ROUTE] },
    { label: 'an empty imageAction', rc: { sizeid: HERO_ID, imageAction: '' }, calls: [LIST_ROUTE] },
  ])('$label: exact calls, then the GET answer as the table', async ({ rc, calls, form }) => {
    const { gateway, markup } = await serve(rc);

    expect(callKeys(gateway)).toEqual(calls);
    expect(gateway.calls[0]?.form).toEqual(form);
    expect(fragmentModel(markup).tables).toEqual([TENANT_A_TABLE]);
  });

  it('answers the bare size table with edit links to each size', async () => {
    const { result, markup } = await serve({ sizeid: '' });
    const $ = cheerio.load(markup, null, false);

    expect(result.status).toBe(200);
    expect(result.contentType).toBe(HTML_CONTENT_TYPE);
    expect(markup).not.toMatch(/<(?:html|head|body)\b|mura-header|nav-module-specific/i);
    expect($('table.mura-table-grid tr')).toHaveLength(1 + IMAGE_SIZE_LIST_TENANT_A.length);
    expect($('a[href="#"]').map((_, a) => $(a).attr('onclick')).get()).toEqual([OPEN_HERO, OPEN_HERO]);
    expect($('td.actions > ul > li.edit > a > i.mi-pencil')).toHaveLength(1);
    expect($('td.var-width > a').text()).toBe(customImageSizeHeroBanner.name);
  });

  it('answers the empty-state notice when the site has no sizes', async () => {
    const { markup } = await serve({ sizeid: '' }, IMAGE_SIZE_LIST_EMPTY);
    const $ = cheerio.load(markup, null, false);

    expect(fragmentModel(markup).tables).toEqual([]);
    expect($('div.help-block-empty').text()).toBe('There are currently no custom image sizes.');
  });
});
