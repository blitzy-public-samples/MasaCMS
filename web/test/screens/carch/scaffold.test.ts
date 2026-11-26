// cArch.scaffold, the Custom Entities scaffolder page, against carch/scaffold.cfm as the ACF 2023 oracle serves it.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate, secure } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { carchScreens } from '@/screens/carch';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { scaffoldScreen } from '@/screens/carch/scaffold';
import { findScreen } from '@/screens/registry';
import {
  adminS2Request,
  anonymousRequest,
  editorRequest,
  noSitesRequest,
  unservedEditorRequest,
} from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, type FakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

const SITE = 'default';

// The view of `muraAction=carch.scaffold&siteid=default` as the legacy server rendered it in the full layout, between
// the layout's `<div id="mura-content">` and its close.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/carch-scaffold-${name}.html`, import.meta.url), 'utf8');

const MURA_CONTENT_OPEN = '<div id="mura-content">\n\t\t \t\t';
const MURA_CONTENT_CLOSE = '\n\t\t \t\t\t</div> <!-- /#mura-content -->';
const NO_ACCESS = '/admin/?muraAction=cMessage.noaccess';

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

const contextOf = (req: AdminRequest) => makeScreenContext({ req, gateway: fakeGatewayClient() });

/** The calls the screen made to strategies-content, beside the shell's own prompt read. */
const contentCalls = (gateway: FakeGatewayClient) =>
  gateway.calls.filter((call) => call.service === 'strategies-content' && !call.path.endsWith('/header-prompts'));

/** The `carch.scaffold` request on the default site of the user `request` builds. */
const scaffoldRequest = (request: typeof adminS2Request): AdminRequest =>
  request({ circuit: 'carch', item: 'scaffold', rc: { siteid: SITE } });

describe('cArch.scaffold definition and access', () => {
  it('is a frozen strategies-content page behind the carch gate, registered for the route key', () => {
    expect(scaffoldScreen).toMatchObject({
      circuit: 'carch',
      action: 'scaffold',
      mode: 'page',
      owner: CARCH_OWNER,
      gate: carchGate,
    });
    expect(Object.isFrozen(scaffoldScreen)).toBe(true);
    expect(carchScreens).toContain(scaffoldScreen);
    expect(findScreen('cArch', 'Scaffold', { siteid: SITE })).toBe(scaffoldScreen);
  });

  it('lets qa_editor through on Site Manager access', async () => {
    await expect(runGate(scaffoldRequest(editorRequest), scaffoldScreen.gate)).resolves.toEqual({ kind: 'allow' });
  });

  const secureLocation = (req: AdminRequest): string => {
    const denied = secure(req);
    return denied.kind === 'redirect' ? denied.location : '';
  };
  const withoutSites = (s2IsPrivate: boolean) => (): AdminRequest =>
    noSitesRequest({ s2IsPrivate }, { circuit: 'carch', item: 'scaffold', rc: { siteid: SITE } });

  it.each<[string, () => AdminRequest, (req: AdminRequest) => string]>([
    ['an anonymous request to the secure() login', () => scaffoldRequest(anonymousRequest), secureLocation],
    ['qa_editor without Site Manager there to secure()', () => scaffoldRequest(unservedEditorRequest), secureLocation],
    ['a public member to clogin.logout', withoutSites(false), () => '/admin/?muraAction=clogin.logout'],
    ['a system user without Site Manager to cMessage.noaccess', withoutSites(true), () => NO_ACCESS],
  ])('sends %s before rendering', async (_who, request, location) => {
    const req = request();
    const ctx = contextOf(req);
    await expect(renderScreenPage(scaffoldScreen, ctx)).resolves.toEqual({ kind: 'redirect', location: location(req) });
    expect(contentCalls(ctx.gateway)).toEqual([]);
  });
});

describe('cArch.scaffold view', () => {
  // S2 prints its position in the memberships as IsSuperUser and gets the Permissions buttons; qa_editor neither.
  it.each<[string, typeof adminS2Request]>([
    ['s2', adminS2Request],
    ['editor', editorRequest],
  ])('renders the %s view byte for byte inside the full layout, reading no service', async (name, request) => {
    const ctx = contextOf(scaffoldRequest(request));
    const page = await renderScreenPage(scaffoldScreen, ctx);
    if (page.kind !== 'document') throw new Error(`redirected to ${page.location}`);

    expect(page.doc.layout).toBe('template');
    expect(page.html).toContain(`${MURA_CONTENT_OPEN}${fixture(name)}${MURA_CONTENT_CLOSE}`);
    expect(contentCalls(ctx.gateway)).toEqual([]);
  });

  it('applies the carch before() defaults and embeds no script or menu of its own', async () => {
    const ctx = contextOf(scaffoldRequest(adminS2Request));
    const view = await scaffoldScreen.render(ctx, undefined);

    expect(toString(view.body)).toBe(fixture('s2'));
    expect(view.ajax).toBeUndefined();
    expect(view.htmlHead).toBeUndefined();
    expect(scaffoldScreen.secondaryMenu).toBeUndefined();
    expect(ctx.req.rc.startrow).toBe('1');
    expect(ctx.req.rc.ptype).toBe('Page');
  });
});
