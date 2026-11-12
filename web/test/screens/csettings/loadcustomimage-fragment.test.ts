// csettings.loadcustomimage against legacy loadcustomimage.cfm: the custom image size dialog's bare form.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_HTML_CONTENT_TYPE } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/programs-sites';
import { createCsrfRenderer } from '@/lib/csrf';
import { GatewayDenialError } from '@/lib/gateway-client';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { rbFor } from '@/lib/resource-bundles/rb';
import { loadCustomImageScreen, type CustomImageSize } from '@/screens/csettings/loadcustomimage';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

const SIZE_ID = 'A1B2C3D4-E5F6-0718-293A4B5C6D7E8F90';
const SIZE_PATH = `/v1/sites/${SITE_IDS.default}/image-sizes/${SIZE_ID}` as const;
const SIZE_ROUTE = routeKey('GET', 'programs-sites', SIZE_PATH);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;

const STORED_SIZE: components['schemas']['ImageSize'] = {
  sizeID: SIZE_ID,
  siteID: SITE_IDS.default,
  name: 'Hero',
  height: '400',
  width: 'AUTO',
  isNew: 0,
};

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

/** The dialog's request as `editsite` images.ts sends it: `siteid` plus the given fields. */
const dialogRequest = (rc: Readonly<Record<string, string>> = {}): AdminRequest =>
  adminS2Request({ circuit: 'csettings', item: 'loadcustomimage', rc: { siteid: SITE_IDS.default, ...rc } });

function markupOf({ body }: RawBody): string {
  if (!isSafeHtml(body)) throw new Error('expected a SafeHtml body');
  return toString(body);
}

describe('csettings.loadcustomimage', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  describe('load', () => {
    it('throws the CFML missing-element error when rc has no sizeid', async () => {
      const gateway = fakeGatewayClient();

      const failure = await loadCustomImageScreen.load(contextFor(dialogRequest(), gateway)).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).toMatchObject({ message: 'Element SIZEID is undefined in RC.' });
      expect(gateway.calls).toEqual([]);
    });

    it('defaults a new size for an empty sizeid without calling programs-sites', async () => {
      const gateway = fakeGatewayClient();
      const ctx = contextFor(dialogRequest({ sizeid: '' }), gateway);

      const first = await loadCustomImageScreen.load(ctx);
      const second = await loadCustomImageScreen.load(ctx);

      expect(first).toEqual({ sizeID: expect.stringMatching(CF_UUID), name: '', height: 'AUTO', width: 'AUTO' });
      expect(first.sizeID).toHaveLength(35);
      expect(second.sizeID).toMatch(CF_UUID);
      expect(second.sizeID).not.toBe(first.sizeID);
      expect(gateway.calls).toEqual([]);
    });

    it('reads a stored size once from programs-sites', async () => {
      const gateway = fakeGatewayClient({ [SIZE_ROUTE]: { status: 200, body: STORED_SIZE } });

      const size = await loadCustomImageScreen.load(contextFor(dialogRequest({ sizeid: SIZE_ID }), gateway));

      expect(size).toEqual(STORED_SIZE);
      expect(gateway.calls).toEqual([{ service: 'programs-sites', method: 'GET', path: SIZE_PATH }]);
    });

    it.each([
      { status: 403, type: GatewayDenialError, name: 'GatewayDenialError' },
      { status: 400, type: Error, name: 'Error' },
    ])('rejects with $name when programs-sites answers $status', async ({ status, type, name }) => {
      const gateway = fakeGatewayClient({ [SIZE_ROUTE]: { status, body: {} } });

      const failure = await loadCustomImageScreen
        .load(contextFor(dialogRequest({ sizeid: SIZE_ID }), gateway))
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(type);
      expect(failure).toMatchObject({ name, message: `getImageSize answered HTTP ${status}` });
      expect(gateway.calls).toHaveLength(1);
    });
  });

  describe('render', () => {
    const render = async (size: CustomImageSize): Promise<RawBody> =>
      loadCustomImageScreen.render(contextFor(dialogRequest({ sizeid: size.sizeID })), size);

    it('answers the bare form with the name html_attr-encoded', async () => {
      const name = 'Hero "Wide" <b>';
      const result = await render({ sizeID: SIZE_ID, name, height: '400', width: 'AUTO' });
      const markup = markupOf(result);

      expect(result.status).toBe(200);
      expect(result.contentType).toBe(LEGACY_HTML_CONTENT_TYPE);
      expect(markup).not.toMatch(/<(html|head|body)\b/i);
      const opening = `\n <div id="custom-image-form" data-sizeid="${SIZE_ID}" class="mura-layout-row">`;
      expect(markup.startsWith(opening)).toBe(true);
      expect(markup.endsWith('</div>\n')).toBe(true);
      expect(markup).toContain(
        '<input id="custom-image-name" type="text" value="Hero&#x20;&quot;Wide&quot;&#x20;&lt;b&gt;"  onchange="removePunctuation(this);" maxlength="50"/>',
      );
      expect(markup).toContain('<input id="custom-image-height" type="text" value="400" maxlength="20"/>');
      expect(markup).toContain('<input id="custom-image-width" type="text" value="AUTO" maxlength="20"/>');

      const model = fragmentModel(markup);
      expect(model.labels).toEqual(['Name', 'Height', 'Width']);
      expect(model.controls.map(({ type, value }) => ({ type, value }))).toEqual([
        { type: 'text', value: name },
        { type: 'text', value: '400' },
        { type: 'text', value: 'AUTO' },
      ]);
    });

    it('echoes the id, height and width unencoded', async () => {
      const markup = markupOf(await render({ sizeID: 'A&B"', name: '', height: '1<2', width: '"3"' }));

      expect(markup).toContain('data-sizeid="A&B""');
      expect(markup).toContain('<input id="custom-image-name" type="text" value=""');
      expect(markup).toContain('<input id="custom-image-height" type="text" value="1<2" maxlength="20"/>');
      expect(markup).toContain('<input id="custom-image-width" type="text" value=""3"" maxlength="20"/>');
    });
  });
});
