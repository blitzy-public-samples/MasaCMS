// cArch.selectfields (admin/core/views/carch/selectfields.cfm) against legacy ACF 2023 captures and the contract.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { secure } from '@/lib/access-gate';
import { toString } from '@/lib/html';
import { CARCH_OWNER, carchGate } from '@/screens/carch/controller';
import { loadSelectFields, renderSelectFields, selectfieldsScreen } from '@/screens/carch/selectfields';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';
import { makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// registry.ts imports circuit barrels this suite does not load; the screen context reads only its shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const FIELDS_PATH = '/v1/sites/default/feeds/display-fields';
const DISPLAY_LIST = 'Title,Date,Body,Tags';
const AVAILABLE = 'Image,Summary,ReadMore,Credits,Comments,Rating';
const ARCHITECTURE_SCRIPT = '<script src="/admin/assets/js/architecture.min.js?coreversion=';

// Each view is cut from `<div class="main mura-layout-row">` to its `</div>`, captured with compactDisplay=true.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}`, import.meta.url), 'utf8');

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

/** The service's model of the two lists. */
const fields = (displayList: unknown, availableDisplayList: unknown): FakeReply => ({
  status: 200,
  body: { rc: { displayList, availableDisplayList } },
});

/** The S2 admin's compact selectfields request with `url` fields, over a gateway answering the read with `reply`. */
function context(url: Record<string, string>, reply: FakeReply): ScreenContext & { gateway: FakeGatewayClient } {
  const gateway = fakeGatewayClient({ [routeKey('GET', 'strategies-content', FIELDS_PATH)]: reply });
  const req = adminS2Request({
    circuit: 'carch',
    item: 'selectfields',
    rc: { siteid: 'default', compactDisplay: 'true', ...url },
  });
  return makeScreenContext({ req, gateway });
}

/** The view markup after the controller step, load and render, as the page handler runs them. */
async function viewOf(ctx: ScreenContext): Promise<string> {
  await expect(selectfieldsScreen.redirect?.(ctx)).resolves.toBeUndefined();
  return toString(renderSelectFields(ctx, await loadSelectFields(ctx)).body);
}

const itemsOf = (markup: string, state: 'default' | 'highlight'): string[] =>
  Array.from(markup.matchAll(new RegExp(`<li class="ui-state-${state}">([^\\n]*)</li>`, 'g')), (m) => m[1] ?? '');

describe('cArch.selectfields', () => {
  it('is the carried page of strategies-content behind the carch gate', () => {
    expect(selectfieldsScreen).toMatchObject({
      circuit: 'carch',
      action: 'selectfields',
      owner: CARCH_OWNER,
      mode: 'page',
      gate: carchGate,
    });
    expect(Object.isFrozen(selectfieldsScreen)).toBe(true);
  });

  it.each<[string, Record<string, string>, string, string]>([
    ['selectfields-displaylist.html', { contenthistid: '', instanceid: 'abc-123', displaylist: DISPLAY_LIST }, DISPLAY_LIST, AVAILABLE],
    ['selectfields-default.html', { instanceid: "a'b<c" }, 'Date,Title,Image,Summary,Credits,Tags', 'Body,ReadMore,Comments,Rating'],
    [
      'selectfields-unencoded.html',
      { instanceid: '', displaylist: 'Title ,,date,<b>x"y,Summary' },
      'Title ,,date,<b>x"y,Summary',
      'Title,Image,Body,ReadMore,Credits,Comments,Tags,Rating',
    ],
    [
      'selectfields-trim.html',
      { displaylist: 'Date,\tTab\t,\u00a0Nb\u00a0,\u2003Em,\u000bVt,Image' },
      'Date,\tTab\t,\u00a0Nb\u00a0,\u2003Em,\u000bVt,Image',
      'Title,Summary,Body,ReadMore,Credits,Comments,Tags,Rating',
    ],
  ])('matches the legacy view %s byte for byte', async (name, url, displayList, available) => {
    await expect(viewOf(context(url, fields(displayList, available)))).resolves.toBe(fixture(name));
  });

  it.each<[string, Record<string, string>, string]>([
    ['with displayList', { displaylist: DISPLAY_LIST }, DISPLAY_LIST],
    ['without displayList', {}, 'Date,Title,Image,Summary,Credits,Tags'],
  ])('models the picker %s as legacy does', async (_case, url, displayList) => {
    const model = fragmentModel(await viewOf(context(url, fields(displayList, AVAILABLE))));
    expect(model.headings).toEqual(['Select Fields']);
    expect(model.controls.map((c) => [c.name, c.type, c.value])).toEqual([['displayList', 'hidden', displayList]]);
    expect(model.buttons.map((b) => [b.text, b.type])).toEqual([['Update', 'submit']]);
  });

  it.each<[string, string, string, string[], string[]]>([
    ['skips available items listFind finds, case-sensitively', 'Date,Title', 'Date,date,Image', ['date', 'Image'], ['Date', 'Title']],
    ['writes empty lists without items', 'Date', '', [], ['Date']],
    ['skips empty list items', ',Title,,', ',,Body,', ['Body'], ['Title']],
  ])('%s', async (_case, displayList, available, availableItems, displayItems) => {
    const markup = await viewOf(context({}, fields(displayList, available)));
    expect(itemsOf(markup, 'default')).toEqual(availableItems);
    expect(itemsOf(markup, 'highlight')).toEqual(displayItems);
  });

  it('reads the effective rc once, after the carch defaults, for the controller step, load and render', async () => {
    const ctx = context({ instanceid: 'abc-123', displaylist: DISPLAY_LIST }, fields(DISPLAY_LIST, AVAILABLE));
    const page = await renderScreenPage(selectfieldsScreen, ctx);
    expect(page.kind).toBe('document');
    const html = page.kind === 'document' ? page.html : '';
    expect(html).toContain(fixture('selectfields-displaylist.html'));
    expect(html).toContain(ARCHITECTURE_SCRIPT);
    expect(page.kind === 'document' ? page.doc.layout : undefined).toBe('compact');
    expect(ctx.gateway.calls).toHaveLength(1);
    expect(ctx.gateway.calls[0]).toMatchObject({
      service: 'strategies-content',
      method: 'GET',
      path: FIELDS_PATH,
      query: { siteid: 'default', instanceid: 'abc-123', displaylist: DISPLAY_LIST, ajaxrequest: 'false', size: '20' },
    });
    expect(ctx.req.rc.topid).toBe('00000000000000000000000000000000001');
  });

  it('answers a denied read with the controller secure() redirect from its controller step', async () => {
    const ctx = context({}, { status: 403, body: {} });
    const denied = secure(ctx.req);
    await expect(selectfieldsScreen.redirect?.(ctx)).resolves.toEqual({
      kind: 'location',
      location: denied.kind === 'redirect' ? denied.location : '',
    });
    await expect(loadSelectFields(ctx)).rejects.toThrow('getSelectFieldsModel was denied');
    expect(ctx.gateway.calls).toHaveLength(1);
  });

  it('fails the page on any other 4xx', async () => {
    const ctx = context({}, { status: 400, body: {} });
    await expect(selectfieldsScreen.redirect?.(ctx)).resolves.toBeUndefined();
    await expect(loadSelectFields(ctx)).rejects.toThrow('getSelectFieldsModel rejected carch.selectfields with HTTP 400');
  });

  it('reads the lists by case-insensitive name', async () => {
    const reply = { status: 200, body: { rc: { DISPLAYLIST: 'Date', availabledisplaylist: 'Title' } } };
    await expect(loadSelectFields(context({}, reply))).resolves.toEqual({
      displayList: 'Date',
      availableDisplayList: 'Title',
    });
  });

  it.each<[string, unknown, unknown]>([
    ['displayList', undefined, AVAILABLE],
    ['availableDisplayList', DISPLAY_LIST, ['Image']],
  ])('throws when the model holds no rc.%s list', async (name, displayList, available) => {
    await expect(loadSelectFields(context({}, fields(displayList, available)))).rejects.toThrow(
      new TypeError(`getSelectFieldsModel returned no rc.${name} list`),
    );
  });
});
