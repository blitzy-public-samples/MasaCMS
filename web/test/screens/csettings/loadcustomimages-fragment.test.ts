// csettings.loadcustomimages against legacy loadcustomimages.cfm: the size dialog's save or delete, then the size table.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/programs-sites';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadCustomImagesScreen } from '@/screens/csettings/loadcustomimages';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

type ImageSize = components['schemas']['ImageSize'];
type Fields = Readonly<Record<string, string>>;

const SIZE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const LIST_PATH = `/v1/sites/${SITE_IDS.default}/image-sizes` as const;
const SIZE_PATH = `${LIST_PATH}/${SIZE_ID}` as const;
const LIST_ROUTE = routeKey('GET', 'programs-sites', LIST_PATH);
const SAVE_ROUTE = routeKey('PUT', 'programs-sites', SIZE_PATH);
const DELETE_ROUTE = routeKey('DELETE', 'programs-sites', SIZE_PATH);

const HERO: ImageSize = { sizeID: SIZE_ID, siteID: SITE_IDS.default, name: 'Hero', height: '400', width: 'AUTO', isNew: 0 };
const THUMB: ImageSize = {
  sizeID: 'B2C3D4E5-F607-1829-3A4B5C6D7E8F9001',
  siteID: SITE_IDS.default,
  name: 'Thumb',
  height: '80',
  width: '80',
  isNew: 0,
};

// The bytes the ACF 2023 oracle served for site `default` holding this one size.
const CAROUSEL_ID = 'AF1B332D-0E88-37DF-1FFF0550299B5E19';
const CAROUSEL: ImageSize = {
  sizeID: CAROUSEL_ID,
  siteID: SITE_IDS.default,
  name: 'carouselimage',
  height: '628',
  width: '1506',
  isNew: 0,
};
const CAROUSEL_MARKUP = [
  '',
  '<table class="mura-table-grid">',
  '<tr>',
  '<th class="actions"></th>',
  '<th >Name</th>',
  '<th>Height</th>',
  '<th>Width</th>',
  '</tr>',
  '',
  '<tr>',
  '<td class="actions"><ul>',
  `\t<li class="edit"><a href="#" text="Edit" onclick="return openCustomImageSize('${CAROUSEL_ID}','default');"><i class="mi-pencil"></i></a></li>`,
  '</ul></td>',
  `<td class="var-width"><a href="#" text="Edit" onclick="return openCustomImageSize('${CAROUSEL_ID}','default');">carouselimage</a></td>`,
  '<td>628</td>',
  '<td>1506</td>',
  '</tr>',
  '',
  '</table>',
  '',
].join('\n');

function contextFor(req: AdminRequest, gateway: FakeGatewayClient = fakeGatewayClient()): ScreenContext {
  return {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en_US'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-06-30T12:00:00Z'),
  };
}

/** The dialog's post as editsite.cfm `loadCustomImages` sends it: `siteid` and `cacheid` plus the given fields. */
const dialogRequest = (rc: Fields = {}): AdminRequest =>
  adminS2Request({
    circuit: 'csettings',
    item: 'loadcustomimages',
    rc: { siteid: SITE_IDS.default, cacheid: '0.5', ...rc },
  });

/** A programs-sites answering every image-size route with `sizes`. */
const sizesGateway = (sizes: readonly ImageSize[] = [HERO]): FakeGatewayClient =>
  fakeGatewayClient({
    [LIST_ROUTE]: { status: 200, body: sizes },
    [SAVE_ROUTE]: { status: 200, body: sizes },
    [DELETE_ROUTE]: { status: 200, body: sizes },
  });

const callsOf = (gateway: FakeGatewayClient): string[] =>
  gateway.calls.map(({ service, method, path }) => `${service} ${method} ${path}`);

function markupOf({ body }: RawBody): string {
  if (!isSafeHtml(body)) throw new Error('expected a SafeHtml body');
  return toString(body);
}

describe('csettings.loadcustomimages', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  describe('load', () => {
    it.each<{ rc: Fields; element: string }>([
      { rc: {}, element: 'SIZEID' },
      { rc: { sizeid: SIZE_ID }, element: 'IMAGEACTION' },
    ])('throws the CFML missing-element error for $element', async ({ rc, element }) => {
      const gateway = sizesGateway();

      const failure = await loadCustomImagesScreen.load(contextFor(dialogRequest(rc), gateway)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).toMatchObject({ message: `Element ${element} is undefined in RC.` });
      expect(gateway.calls).toEqual([]);
    });

    it.each<Fields>([
      { sizeid: '' },
      { sizeid: '', imageAction: 'delete' },
      { sizeid: SIZE_ID, imageAction: '' },
      { sizeid: SIZE_ID, imageAction: 'noop' },
      { sizeid: SIZE_ID, imageAction: 'saved' },
    ])('only lists the sizes for rc %o', async (rc) => {
      const gateway = sizesGateway();

      await expect(loadCustomImagesScreen.load(contextFor(dialogRequest(rc), gateway))).resolves.toEqual([HERO]);
      expect(callsOf(gateway)).toEqual([`programs-sites GET ${LIST_PATH}`]);
    });

    it.each(['delete', 'DELETE', ' Delete\t'])('deletes the size for imageAction %j, then lists', async (imageAction) => {
      const gateway = sizesGateway([THUMB]);

      const sizes = await loadCustomImagesScreen.load(
        contextFor(dialogRequest({ sizeid: SIZE_ID, imageAction, name: 'Hero' }), gateway),
      );

      expect(sizes).toEqual([THUMB]);
      expect(callsOf(gateway)).toEqual([`programs-sites DELETE ${SIZE_PATH}`, `programs-sites GET ${LIST_PATH}`]);
      expect(gateway.calls[0]?.form).toBeUndefined();
    });

    it.each(['save', 'SAVE', ' Save ', 'ſave'])('saves the posted size for imageAction %j, then lists', async (imageAction) => {
      const gateway = sizesGateway([HERO, THUMB]);
      const rc = { sizeid: SIZE_ID, imageAction, name: 'Hero', height: '400', width: 'AUTO' };

      const sizes = await loadCustomImagesScreen.load(contextFor(dialogRequest(rc), gateway));

      expect(sizes).toEqual([HERO, THUMB]);
      expect(callsOf(gateway)).toEqual([`programs-sites PUT ${SIZE_PATH}`, `programs-sites GET ${LIST_PATH}`]);
      expect(gateway.calls[0]?.form).toEqual({
        siteid: SITE_IDS.default,
        sizeid: SIZE_ID,
        name: 'Hero',
        height: '400',
        width: 'AUTO',
      });
    });

    it('forwards only the posted size fields on save', async () => {
      const gateway = sizesGateway();

      await loadCustomImagesScreen.load(contextFor(dialogRequest({ sizeid: SIZE_ID, imageAction: 'save' }), gateway));

      expect(gateway.calls[0]?.form).toEqual({ siteid: SITE_IDS.default, sizeid: SIZE_ID });
    });

    it.each([
      { failing: DELETE_ROUTE, imageAction: 'delete', status: 403, type: GatewayDenialError, op: 'deleteImageSize', calls: 1 },
      { failing: SAVE_ROUTE, imageAction: 'save', status: 400, type: Error, op: 'saveImageSize', calls: 1 },
      { failing: LIST_ROUTE, imageAction: 'save', status: 401, type: GatewayDenialError, op: 'listImageSizes', calls: 2 },
      { failing: LIST_ROUTE, imageAction: '', status: 500, type: Error, op: 'listImageSizes', calls: 1 },
    ])('rejects when $op answers $status', async ({ failing, imageAction, status, type, op, calls }) => {
      const gateway = sizesGateway();
      gateway.setRoute(failing, { status, body: {} });

      const failure = await loadCustomImagesScreen
        .load(contextFor(dialogRequest({ sizeid: SIZE_ID, imageAction }), gateway))
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ message: `${op} answered HTTP ${status}` });
      expect(gateway.calls).toHaveLength(calls);
    });

    it("lists rc.siteid's sizes", async () => {
      const path = `/v1/sites/${SITE_IDS.tenantA}/image-sizes` as const;
      const gateway = fakeGatewayClient({ [routeKey('GET', 'programs-sites', path)]: { status: 200, body: [] } });

      await expect(
        loadCustomImagesScreen.load(contextFor(dialogRequest({ siteid: SITE_IDS.tenantA, sizeid: '' }), gateway)),
      ).resolves.toEqual([]);
      expect(callsOf(gateway)).toEqual([`programs-sites GET ${path}`]);
    });
  });

  describe('render', () => {
    const render = async (sizes: readonly ImageSize[]): Promise<RawBody> =>
      loadCustomImagesScreen.render(contextFor(dialogRequest({ sizeid: '' })), [...sizes]);

    it('answers the bare size table byte for byte as legacy serves it', async () => {
      const result = await render([CAROUSEL]);

      expect(result.status).toBe(200);
      expect(result.contentType).toBe(LEGACY_HTML_CONTENT_TYPE);
      expect(markupOf(result)).toBe(CAROUSEL_MARKUP);
    });

    it('lists every size in order', async () => {
      const markup = markupOf(await render([HERO, THUMB]));

      expect(fragmentModel(markup).tables).toEqual([
        {
          headers: ['', 'Name', 'Height', 'Width'],
          rows: [
            ['', 'Hero', '400', 'AUTO'],
            ['', 'Thumb', '80', '80'],
          ],
        },
      ]);
      expect(markup).toContain('<td>AUTO</td>\n</tr>\n\n<tr>\n<td class="actions"><ul>');
      expect(markup).toContain(`openCustomImageSize('${THUMB.sizeID}','default');">Thumb</a></td>`);
    });

    it('html-encodes the cells, js-encodes the site id and echoes the size id', async () => {
      const size: ImageSize = {
        sizeID: "A'B",
        siteID: "it's",
        name: '<b>"Wide" & Co</b>',
        height: '1<2',
        width: '3>2',
        isNew: 0,
      };

      const markup = markupOf(await render([size]));

      expect(markup).toContain(`onclick="return openCustomImageSize('A'B','it\\x27s');"`);
      expect(markup).toContain('>&lt;b&gt;&quot;Wide&quot; &amp; Co&lt;&#x2f;b&gt;</a></td>\n<td>1&lt;2</td>\n<td>3&gt;2</td>');
    });

    it('answers the empty-state notice when the site has no sizes', async () => {
      const result = await render([]);

      expect(result.contentType).toBe(LEGACY_HTML_CONTENT_TYPE);
      expect(markupOf(result)).toBe('\n\t<div class="help-block-empty">There are currently no custom image sizes.</div>\n');
    });
  });
});
