// csettings.loadcustomimage through its registered fragment definition: gate, load, render and the wire response.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HTML_CONTENT_TYPE, htmlResponse } from '@/lib/responses';
import { csettingsScreens } from '@/screens/csettings';
import type { ScreenContext, ScreenDefinition } from '@/screens/registry';
import { GET_IMAGE_SIZE_HERO_BANNER, customImageSizeHeroBanner } from '../../fixtures/programs-sites/image-sizes';
import { SITE_IDS } from '../../fixtures/programs-sites/sites';
import { adminS2Request, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient } from '../../helpers/fake-gateway';

type AdminRequest = ScreenContext['req'];
type FragmentDefinition = Extract<ScreenDefinition, { mode: 'fragment' }>;

const SITE_ID = SITE_IDS.tenantA;
const SIZE_ID = customImageSizeHeroBanner.sizeID;
const SIZE_PATH = `/v1/sites/${SITE_ID}/image-sizes/${SIZE_ID}` as const;
const SIZE_ROUTE = routeKey('GET', 'programs-sites', SIZE_PATH);
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const SHELL_MARKERS = [
  '<!DOCTYPE',
  '<html',
  '<head',
  '<body',
  'mura-header',
  'id="page-container"',
  'id="mura-content"',
  'id="sidebar"',
] as const;
const ACTION = { circuit: 'csettings', item: 'loadcustomimage' } as const;
const NOW = new Date('2026-06-30T12:00:00Z');

// Context built here, not with makeScreenContext, which loads the whole screen registry; the csettings barrel suffices.
// The legacy view renders literal labels and no CSRF token, so a bundle or token read is a defect.
const unused = (member: string) => (): never => {
  throw new Error(`csettings.loadcustomimage used ${member}`);
};
const CSRF_UNUSED: ScreenContext['csrf'] = {
  tokens: unused('csrf.tokens'),
  prefetch: unused('csrf.prefetch'),
  render: unused('csrf.render'),
};
const RB_UNUSED: ScreenContext['rb'] = {
  locale: 'en_US',
  rbKey: unused('rb.rbKey'),
  messageFormat: unused('rb.messageFormat'),
};

const siteAdminFor = (sizeid: string): AdminRequest =>
  siteAdminRequest(SITE_ID, { ...ACTION, rc: { siteid: SITE_ID, sizeid } });

const s2AdminFor = (sizeid: string): AdminRequest => adminS2Request({ ...ACTION, rc: { siteid: SITE_ID, sizeid } });

const storedSizeGateway = (body: unknown = GET_IMAGE_SIZE_HERO_BANNER): FakeGatewayClient =>
  fakeGatewayClient({ [SIZE_ROUTE]: { status: 200, body } });

function fragmentDefinition(): FragmentDefinition {
  const def = csettingsScreens.find((candidate) => candidate.action === 'loadcustomimage');
  if (def?.mode !== 'fragment') throw new Error('csettings.loadcustomimage is not a registered fragment');
  return def;
}

/** The admin-raw answer for `req`: the screen gate must allow, then load, render and the legacy-headed response. */
async function dispatch(req: AdminRequest, gateway: FakeGatewayClient): Promise<Response> {
  const def = fragmentDefinition();
  const decision = await def.gate?.(req, { secure: () => ({ kind: 'redirect', location: 'secure()' }) });
  expect(decision).toEqual({ kind: 'allow' });
  const hooks: ScreenContext['hooks'] = { secondaryMenus: {} };
  const ctx: ScreenContext = { req, gateway, csrf: CSRF_UNUSED, rb: RB_UNUSED, hooks, now: NOW };
  const raw = await def.render(ctx, await def.load?.(ctx));
  if (raw.body instanceof Uint8Array) throw new TypeError('expected a markup body');
  return htmlResponse(raw.body, { status: raw.status, contentType: raw.contentType });
}

const markupFor = async (req: AdminRequest, gateway: FakeGatewayClient): Promise<string> =>
  (await dispatch(req, gateway)).text();

const sizeIdOf = (markup: string): string | undefined =>
  /<div id="custom-image-form" data-sizeid="([^"]*)" class="mura-layout-row">/.exec(markup)?.[1];

const controlValues = (markup: string): string[] => fragmentModel(markup).controls.map(({ value }) => value);

describe('csettings.loadcustomimage', () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = useTestEnv();
  });
  afterEach(() => {
    restoreEnv();
  });

  it('answers a bare HTML fragment without the shell', async () => {
    const response = await dispatch(siteAdminFor(SIZE_ID), storedSizeGateway());
    const markup = await response.text();

    expect(response.status).toBe(200);
    expect(HTML_CONTENT_TYPE).toBe('text/html;charset=UTF-8');
    expect(response.headers.get('content-type')).toBe(HTML_CONTENT_TYPE);
    for (const marker of SHELL_MARKERS) expect(markup).not.toContain(marker);
    expect(markup.startsWith('\n <div id="custom-image-form"')).toBe(true);
    expect(markup.endsWith('</div>\n')).toBe(true);
    expect(markup.match(/<div class="mura-control-group">/g)).toHaveLength(3);
    expect(fragmentModel(markup).labels).toEqual(['Name', 'Height', 'Width']);
  });

  it.each([
    ['the tenant-a site admin', siteAdminFor],
    ['the S2 admin', s2AdminFor],
  ])('renders the stored size for %s from one programs-sites read', async (_subject, requestFor) => {
    const gateway = storedSizeGateway();
    const markup = await markupFor(requestFor(SIZE_ID), gateway);

    expect(sizeIdOf(markup)).toBe(SIZE_ID);
    expect(markup).toContain(
      '<input id="custom-image-name" type="text" value="hero-banner"  onchange="removePunctuation(this);" maxlength="50"/>',
    );
    expect(markup).toContain('<input id="custom-image-height" type="text" value="400" maxlength="20"/>');
    expect(markup).toContain('<input id="custom-image-width" type="text" value="1200" maxlength="20"/>');
    expect(fragmentModel(markup).controls.map(({ tag, type, value }) => ({ tag, type, value }))).toEqual([
      { tag: 'input', type: 'text', value: 'hero-banner' },
      { tag: 'input', type: 'text', value: '400' },
      { tag: 'input', type: 'text', value: '1200' },
    ]);
    expect(gateway.calls).toEqual([{ service: 'programs-sites', method: 'GET', path: SIZE_PATH }]);
  });

  it('defaults a fresh size for an empty sizeid without reading programs-sites', async () => {
    const gateway = fakeGatewayClient();
    const first = await markupFor(siteAdminFor(''), gateway);
    const second = await markupFor(siteAdminFor(''), gateway);

    const firstId = sizeIdOf(first);
    expect(firstId).toMatch(CF_UUID);
    expect(firstId).toHaveLength(35);
    expect(sizeIdOf(second)).toMatch(CF_UUID);
    expect(sizeIdOf(second)).not.toBe(firstId);
    expect(controlValues(first)).toEqual(['', 'AUTO', 'AUTO']);
    expect(first).toContain('<input id="custom-image-name" type="text" value=""  onchange="removePunctuation(this);"');
    expect(gateway.calls).toEqual([]);
  });

  it('html_attr-encodes a name holding quotes and angle brackets', async () => {
    const name = 'hero-"banner"<b>';
    const markup = await markupFor(siteAdminFor(SIZE_ID), storedSizeGateway({ ...GET_IMAGE_SIZE_HERO_BANNER, name }));

    expect(markup).toContain(
      '<input id="custom-image-name" type="text" value="hero-&quot;banner&quot;&lt;b&gt;"  onchange=',
    );
    expect(controlValues(markup)).toEqual([name, '400', '1200']);
  });
});
