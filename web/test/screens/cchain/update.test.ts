// cchain.update against cchain/update.cfm: the edit.cfm form, with dsp_secondary_menu.cfm's empty update toolbar.
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, cfUuid } from '@opt2/platform/legacy-compat';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toString } from '@/lib/html';
import { cchainScreens, withCchainDefaults } from '@/screens/cchain';
import { loadCchainEdit, renderCchainEdit } from '@/screens/cchain/edit';
import { loadCchainUpdate, renderCchainUpdate } from '@/screens/cchain/update';
import type { ScreenContext } from '@/screens/registry';
import {
  APPROVAL_CHAIN_IDS,
  APPROVAL_GROUP_IDS,
  CCHAIN_PATHS,
  cchainEditData,
  cchainEditNewData,
} from '../../fixtures/strategies-content/approval-chains';
import { siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel, type DomModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeCall, type FakeReply } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext, renderScreenPage } from '../../helpers/screen-context';

// A new chain's id is a random CF UUID; the passthrough spy lets a test route the id the loader draws.
vi.mock('@opt2/platform/legacy-compat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opt2/platform/legacy-compat')>();
  return { ...actual, cfUuid: vi.fn(actual.cfUuid) };
});

type Ctx = ReturnType<typeof makeScreenContext>;

const SITE = 'tenant-a';
const CHAIN = APPROVAL_CHAIN_IDS.standard;
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const TOOLBAR = '.mura-header .nav-module-specific.btn-group';

const chainRoute = (chainid: string): string =>
  routeKey('GET', 'strategies-content', `/v1/sites/${SITE}/approval-chains/${chainid}`);

/** `cchainEditNewData` as strategies-content serves it for `chainid`. */
function newChainReply(chainid: string): FakeReply {
  const { rc } = cchainEditNewData;
  const chain = rc.chain as Readonly<Record<string, unknown>>;
  return { status: 200, body: { rc: { ...rc, chainid, chain: { ...chain, chainID: chainid } } } };
}

/** The tenant-a site admin on `cchain.<item>`, its rc given the `before()` defaults. */
function cchainRequest(item: 'update' | 'edit', chainid: string = CHAIN): ScreenContext['req'] {
  const req = siteAdminRequest(SITE, { circuit: 'cchain', item, rc: { chainid } });
  return { ...req, rc: withCchainDefaults(req.rc) };
}

/** A context whose gateway serves the existing chain's edit model. */
const contextFor = (req: ScreenContext['req']): Ctx =>
  makeScreenContext({
    req,
    gateway: fakeGatewayClient({ [chainRoute(CHAIN)]: { status: 200, body: cchainEditData } }),
  });

const contentCalls = (ctx: Ctx): FakeCall[] =>
  ctx.gateway.calls.filter(({ service }) => service === 'strategies-content');

const fragment = (markup: string): cheerio.CheerioAPI => cheerio.load(markup, null, false);

/** Fragment model of `markup` without the cchain toolbar. */
function modelWithoutToolbar(markup: string): DomModel {
  const $ = fragment(markup);
  $('.nav-module-specific').remove();
  return fragmentModel($.html());
}

/** The toolbar's links as href and trimmed text. */
function toolbarLinks(markup: string): Array<{ href: string; text: string }> {
  const $ = fragment(markup);
  return $(`${TOOLBAR} a`)
    .toArray()
    .map((el) => ({ href: $(el).attr('href') ?? '', text: $(el).text().trim() }));
}

/** Expects one toolbar in `$` with no element children and no text. */
function expectEmptyToolbar($: cheerio.CheerioAPI): void {
  const toolbar = $(TOOLBAR);
  expect(toolbar).toHaveLength(1);
  expect(toolbar.children()).toHaveLength(0);
  expect(toolbar.text().trim()).toBe('');
}

let restore: () => void;
let updateCtx: Ctx;
let editCtx: Ctx;

beforeEach(() => {
  restore = useTestEnv();
  updateCtx = contextFor(cchainRequest('update'));
  editCtx = contextFor(cchainRequest('edit'));
});

afterEach(() => {
  restore();
});

describe('loadCchainUpdate', () => {
  it('loads what edit loads', async () => {
    const data = await loadCchainUpdate(updateCtx);

    expect(data).toEqual(await loadCchainEdit(editCtx));
    expect(data.chain).toMatchObject({ chainId: CHAIN, siteId: SITE, isNew: false });
    expect(contentCalls(updateCtx)).toEqual([
      { service: 'strategies-content', method: 'GET', path: CCHAIN_PATHS.edit },
    ]);
    expect(contentCalls(updateCtx)).toEqual(contentCalls(editCtx));
  });
});

describe('renderCchainUpdate', () => {
  let updateMarkup: string;
  let editMarkup: string;

  beforeEach(async () => {
    const data = await loadCchainUpdate(updateCtx);
    await editCtx.csrf.prefetch([data.chain.chainId]);
    updateMarkup = toString(renderCchainUpdate(updateCtx, data).body);
    editMarkup = toString(renderCchainEdit(editCtx, data).body);
  });

  it('matches edit except toolbar', () => {
    const model = modelWithoutToolbar(updateMarkup);

    expect(model).toEqual(modelWithoutToolbar(editMarkup));
    expect(model.headings).toEqual(['Edit Approval Chain']);
    expect(model.labels).toEqual(['Name', 'Description', 'Available Groups Groups in this Approval Chain']);
    expect(model.controls.map(({ name, type, value }) => [name, type, value])).toEqual([
      ['name', 'text', 'Standard Publishing'],
      ['description', 'textarea', 'Two-step review for public pages: content editors first, then content publishers.'],
      ['availableID', 'hidden', APPROVAL_GROUP_IDS.marketing],
      ['groupID', 'hidden', APPROVAL_GROUP_IDS.contentEditors],
      ['groupID', 'hidden', APPROVAL_GROUP_IDS.contentPublishers],
      ['siteid', 'hidden', SITE],
      ['chainID', 'hidden', CHAIN],
      [CSRF_FIELD_TOKEN, 'hidden', FIXED_CSRF.token],
      [CSRF_FIELD_EXPIRES, 'hidden', FIXED_CSRF.expires],
    ]);
    expect(model.buttons).toEqual([
      { text: 'Delete', type: 'button', hasOnclick: true },
      { text: 'Update', type: 'button', hasOnclick: true },
    ]);
    expect(model.links).toEqual([]);
  });

  it('posts the edit form to cchain.save', () => {
    const $ = fragment(updateMarkup);

    expect($('h1').text().trim()).toBe('Edit Approval Chain');
    expect($('form[name=form1]').attr('action')).toBe('./?muraAction=cchain.save');
  });

  it('renders an empty toolbar', () => {
    expectEmptyToolbar(fragment(updateMarkup));
  });

  it('keeps the back link on edit', () => {
    expect(toolbarLinks(editMarkup)).toEqual([
      { href: `./?muraAction=cchain.list&siteid=${SITE}`, text: 'Back to Approval Chains' },
      { href: `./?muraAction=cchain.pending&siteid=${SITE}&chainID=${CHAIN}`, text: 'Pending Requests' },
    ]);
    expect(toolbarLinks(updateMarkup)).toEqual([]);
  });
});

describe('new chain', () => {
  it('draws a CF UUID for an empty chainid', async () => {
    const actual = await vi.importActual<typeof import('@opt2/platform/legacy-compat')>('@opt2/platform/legacy-compat');
    const ctx = contextFor(cchainRequest('update', ''));
    let drawn = '';
    vi.mocked(cfUuid).mockImplementationOnce(() => {
      drawn = actual.cfUuid();
      ctx.gateway.setRoute(chainRoute(drawn), newChainReply(drawn));
      return drawn;
    });

    const data = await loadCchainUpdate(ctx);

    expect(drawn).toMatch(CF_UUID);
    expect(contentCalls(ctx).map(({ path }) => path)).toEqual([`/v1/sites/${SITE}/approval-chains/${drawn}`]);
    expect(data.chain).toMatchObject({ chainId: drawn, isNew: true });
    const $ = fragment(toString(renderCchainUpdate(ctx, data).body));
    expect($('input[name=chainID]').attr('value')).toBe(drawn);
    expectEmptyToolbar($);
  });
});

describe('cchainScreens update entry', () => {
  it('renders the form in the shell', async () => {
    const def = cchainScreens.find(({ action }) => action === 'update');
    if (def === undefined) throw new Error('cchain.update is not registered');

    const page = await renderScreenPage(def, updateCtx);

    expect(page.kind).toBe('document');
    if (page.kind !== 'document') return;
    const $ = cheerio.load(page.html);
    expect($('form[name=form1]')).toHaveLength(1);
    expectEmptyToolbar($);
  });
});
