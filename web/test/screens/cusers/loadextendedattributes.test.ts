// cUsers.loadExtendedAttributes (cusers/loadextendedattributes.cfm) as user.js `loadExtendedAttributes` receives it:
// the mura.json returnsets of the subtype's Default and Basic extend sets, each read through the parity DOM model.
import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { LEGACY_HTML_CONTENT_TYPE, LegacyServiceUnavailableError } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeHtml, encodeHtmlAttr, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { cusersGate } from '@/screens/cusers/gate';
import {
  extendRenderContext,
  legacyJsonEncode,
  loadExtendedAttributesScreen,
  renderExtendAttribute,
  renderExtendSets,
  type ExtendAttributeDefinition,
  type ExtendContainer,
  type ExtendSetDefinition,
  type ExtendSubject,
  type LegacyJsonValue,
  type LoadExtendedAttributesData,
  type RenderExtendSetsOptions,
} from '@/screens/cusers/loadextendedattributes';
import type { ScreenContext } from '@/screens/registry';
import { GROUP_IDS } from '../../fixtures/identity/groups';
import { PERSON_IDS } from '../../fixtures/people/user-list';
import { adminS2Request, editorRequest, siteAdminRequest } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

/** The inventoried variant fields this suite reads. */
interface InventoryVariant {
  readonly routeKey: string;
  readonly owningService: string | null;
  readonly responseMode: string | null;
  readonly contentType: string | null;
}

interface Inventory {
  readonly controllers: ReadonlyArray<{
    readonly actions?: ReadonlyArray<{ readonly variants?: readonly InventoryVariant[] }>;
  }>;
}

const INVENTORY_URL = new URL('../../../../opt2/inventory/legacy-inventory.json', import.meta.url);

function inventoried(routeKey: string): InventoryVariant {
  const inventory = JSON.parse(readFileSync(INVENTORY_URL, 'utf8')) as Inventory;
  const found = inventory.controllers
    .flatMap((controller) => controller.actions ?? [])
    .flatMap((action) => action.variants ?? [])
    .find((variant) => variant.routeKey === routeKey);
  if (found === undefined) throw new Error(`${routeKey} is not inventoried`);
  return found;
}

const INVENTORIED = inventoried('admin:cusers.loadextendedattributes');

const ACTION = { circuit: 'cusers', item: 'loadExtendedAttributes' } as const;
const SITE = 'tenant-a';
const PERSON_RC = { baseID: PERSON_IDS.janeSmith, type: '2', subtype: 'Default', siteid: SITE } as const;
const GROUP_RC = { baseID: GROUP_IDS.defaultEditor, type: '1', subtype: 'Default', siteid: 'default' } as const;

const HINT = 'Shown <publicly> & "kindly"';

/** A `tclassextendattributes` row: an optional TextBox shown to everyone unless `attr` says otherwise. */
const attribute = (
  attr: Partial<ExtendAttributeDefinition> & Pick<ExtendAttributeDefinition, 'attributeID' | 'name' | 'label'>,
): ExtendAttributeDefinition => ({
  hint: '',
  type: 'TextBox',
  adminOnly: 0,
  required: 'false',
  validation: '',
  regex: '',
  message: '',
  defaultValue: '',
  optionList: '',
  optionLabelList: '',
  ...attr,
});

// No service schema carries extend sets, so the screen's own types shape them.
const HINTED_SET: ExtendSetDefinition = {
  extendSetID: 'EA000000-0000-0000-0000000000000D01',
  categoryID: 'CA000000-0000-0000-0000000000000001',
  name: 'Profile & "Prefs"',
  attributes: [attribute({ attributeID: 9201, name: 'extNickname', label: 'Nickname', hint: HINT })],
};

const ADMIN_ONLY_SET: ExtendSetDefinition = {
  extendSetID: 'EA000000-0000-0000-0000000000000D02',
  categoryID: '',
  name: 'Administration',
  attributes: [attribute({ attributeID: 9202, name: 'extCostCentre', label: 'Cost centre', adminOnly: 1 })],
};

const HIDDEN_SET: ExtendSetDefinition = {
  extendSetID: 'EA000000-0000-0000-0000000000000D03',
  categoryID: '',
  name: 'Integration',
  attributes: [attribute({ attributeID: 9203, name: 'extExternalKey', label: 'External key', type: 'Hidden' })],
};

const BASIC_SET: ExtendSetDefinition = {
  extendSetID: 'EA000000-0000-0000-0000000000000D04',
  categoryID: '',
  name: 'Contact',
  attributes: [attribute({ attributeID: 9204, name: 'extPager', label: 'Pager' })],
};

const DEFAULT_SETS: readonly ExtendSetDefinition[] = [HINTED_SET, ADMIN_ONLY_SET, HIDDEN_SET];
const BASIC_SETS: readonly ExtendSetDefinition[] = [BASIC_SET];

const VALUES: Readonly<Record<string, string>> = {
  extNickname: 'JJ',
  extCostCentre: 'CC-104',
  extExternalKey: 'crm-7731',
  extPager: '555-0100',
};

/** The bean of `userID`, holding {@link VALUES}; any other name answers `useMuraDefault`. */
const subject = (userID: string, siteID: string): ExtendSubject => ({
  userID,
  siteID,
  valueOf: (name) => VALUES[name] ?? 'useMuraDefault',
  fileMetaData: () => undefined,
});

const JANE = subject(PERSON_IDS.janeSmith, SITE);
const EDITORS = subject(GROUP_IDS.defaultEditor, 'default');

const personRequest = (): AdminRequest => siteAdminRequest(SITE, { ...ACTION, rc: PERSON_RC });

/** The options the screen renders `container` with for `ctx`. */
const setsOptions = (ctx: ScreenContext, container: ExtendContainer): RenderExtendSetsOptions => ({
  container,
  context: extendRenderContext(ctx),
  compactDisplay: ctx.req.rc['compactDisplay'] ?? 'false',
  privileged: ctx.req.isS2 || ctx.req.isSiteAdmin,
});

/** `container`'s markup for `req`. */
const setsMarkup = (
  sets: readonly ExtendSetDefinition[],
  bean: ExtendSubject,
  req: AdminRequest,
  container: ExtendContainer = 'Default',
): string => toString(renderExtendSets(sets, bean, setsOptions(makeScreenContext({ req }), container)));

/** The returnsets as user.js `setExtendedAttributes` reads them, with `eval("(" + data + ")")`. */
function evalReturnsets(body: string): { readonly extended: string; readonly basic: string } {
  // JSStringFormat escapes `'` as `\'`, which JSON.parse rejects and the legacy client's eval accepts.
  return (0, eval)(`(${body})`) as { readonly extended: string; readonly basic: string };
}

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('legacyJsonEncode', () => {
  it.each<[string, LegacyJsonValue, string]>([
    ['an empty struct', {}, '{}'],
    ['a struct, keys lower-cased in key order', { Extended: 'a', BASIC: 'b' }, '{"extended":"a","basic":"b"}'],
    ['a number', 12, '12'],
    ['integer text, bare', '12', '12'],
    ['decimal text, bare', '1.5', '1.5'],
    ['text through JSStringFormat', 'a"b\'c\\d\n\t', String.raw`"a\"b\'c\\d\n\t"`],
    ['carriage return, backspace and form feed', '\r\b\f', String.raw`"\r\b\f"`],
    ['an array', ['a', 1], '["a",1]'],
    ['a nested struct', { Outer: { Inner: ['x', '2'], Note: 'n' } }, '{"outer":{"inner":["x",2],"note":"n"}}'],
  ])('encodes %s', (_label, value, encoded) => {
    expect(legacyJsonEncode(value)).toBe(encoded);
  });
});

describe('renderExtendSets', () => {
  it('wraps each set in its span with the set and category ids, the hidden set id and the encoded heading', () => {
    const markup = setsMarkup(DEFAULT_SETS, JANE, personRequest());
    const $ = cheerio.load(markup, null, false);

    const spans = $('span.extendset')
      .toArray()
      .map((el) => ({
        extendsetid: $(el).attr('extendsetid'),
        categoryid: $(el).attr('categoryid'),
        hidden: $(el).children('input[type=hidden][name=extendSetID]').attr('value'),
        heading: $(el).children('h2').text(),
        groups: $(el).children('div.mura-control-group').length,
      }));

    expect(spans).toEqual(
      DEFAULT_SETS.map((set) => ({
        extendsetid: set.extendSetID,
        categoryid: set.categoryID,
        hidden: set.extendSetID,
        heading: set.name,
        groups: set.attributes.length,
      })),
    );
    expect(markup).toContain(`<h2>${encodeHtml(HINTED_SET.name)}</h2>`);
    expect(fragmentModel(markup).headings).toEqual(DEFAULT_SETS.map((set) => set.name));
  });

  it('labels each control group, a hinted one with its popover and question icon', () => {
    const markup = setsMarkup(DEFAULT_SETS, JANE, personRequest());
    const $ = cheerio.load(markup, null, false);
    const popover = $('div.mura-control-group > label > span[data-toggle=popover]');

    expect(fragmentModel(markup).labels).toEqual(['Nickname', 'Cost centre', 'External key']);
    expect(popover.length).toBe(1);
    expect(markup).toContain(`data-content="${encodeHtmlAttr(HINT)}"`);
    expect(popover.attr('data-content')).toBe(HINT);
    expect(popover.attr('data-original-title')).toBe('Nickname');
    expect(popover.attr('data-placement')).toBe('right');
    expect(popover.children('i.mi-question-circle').length).toBe(1);
  });

  it('prints each control as renderExtendAttribute renders it, named by the attribute and holding its value', () => {
    const ctx = makeScreenContext({ req: personRequest() });
    const options = setsOptions(ctx, 'Default');
    const markup = toString(renderExtendSets(DEFAULT_SETS, JANE, options));

    for (const attr of DEFAULT_SETS.flatMap((set) => set.attributes)) {
      const control = attr.type === 'Hidden' ? { ...attr, type: 'TextBox' } : attr;
      const value = JANE.valueOf(attr.name);
      const rendered = renderExtendAttribute(control, { value, context: options.context, bean: JANE, readonly: false });
      expect(markup).toContain(toString(rendered));
    }
    expect(fragmentModel(markup).controls.map(({ name, type, value }) => [name, type, value])).toEqual([
      ['extendSetID', 'hidden', HINTED_SET.extendSetID],
      ['extNickname', 'text', 'JJ'],
      ['extendSetID', 'hidden', ADMIN_ONLY_SET.extendSetID],
      ['extCostCentre', 'text', 'CC-104'],
      ['extendSetID', 'hidden', HIDDEN_SET.extendSetID],
      ['extExternalKey', 'text', 'crm-7731'],
    ]);
  });

  it('edits a Hidden attribute as a TextBox', () => {
    const markup = setsMarkup([HIDDEN_SET], JANE, personRequest());
    const [hiddenAttr] = HIDDEN_SET.attributes;
    const asHidden = renderExtendAttribute(hiddenAttr!, {
      value: 'crm-7731',
      context: setsOptions(makeScreenContext({ req: personRequest() }), 'Default').context,
    });

    expect(fragmentModel(markup).controls.find((c) => c.name === 'extExternalKey')).toMatchObject({ tag: 'input', type: 'text' });
    expect(markup).not.toContain(toString(asHidden));
  });

  it.each<[string, boolean, () => AdminRequest]>([
    ['the S2 admin', true, () => adminS2Request({ ...ACTION, rc: PERSON_RC })],
    ['the editor', false, () => editorRequest({ ...ACTION, rc: PERSON_RC })],
    ['the editor whose rc claims S2 and admin', false, () => editorRequest({ ...ACTION, rc: { ...PERSON_RC, s2: '1', isAdmin: 'true' } })],
  ])('leaves an admin-only attribute editable for %s: %s', (_who, editable, request) => {
    const markup = setsMarkup([ADMIN_ONLY_SET], JANE, request());
    const $ = cheerio.load(markup, null, false);
    const control = fragmentModel(markup).controls.find((c) => c.name === 'extCostCentre');

    expect(control === undefined ? undefined : [control.type, control.value]).toEqual(editable ? ['text', 'CC-104'] : undefined);
    expect($('div.mura-control-group').text().includes('CC-104')).toBe(!editable);
  });

  // extendSet.getStyle() always returns '', so a type-2 user's style leaves only the space before `>`.
  it("prints a type-2 user's empty set style, so each span carries no style and no set is hidden", () => {
    const markup = setsMarkup(DEFAULT_SETS, JANE, personRequest());
    const $ = cheerio.load(markup, null, false);

    expect($('span.extendset[style]').length).toBe(0);
    expect(markup).toContain(`categoryid="${HINTED_SET.categoryID}" >`);
  });
});

describe('loadExtendedAttributesScreen', () => {
  it('is the inventoried people-owned fragment behind the cUsers gate', () => {
    expect(loadExtendedAttributesScreen).toMatchObject({
      circuit: 'cusers',
      action: 'loadextendedattributes',
      mode: INVENTORIED.responseMode,
      owner: INVENTORIED.owningService,
    });
    expect(loadExtendedAttributesScreen.gate).toBe(cusersGate);
  });

  // No people or identity contract serves class-extension definitions, so load asks no service and fails closed.
  it.each<[string, Readonly<Record<string, string>>, string]>([
    ['a person', PERSON_RC, PERSON_IDS.janeSmith],
    ['a group', GROUP_RC, GROUP_IDS.defaultEditor],
  ])('fails closed for %s without a service call, after clearing session.mura.editBean', async (_label, rc, baseID) => {
    const req = siteAdminRequest(SITE, { ...ACTION, rc, session: { muraValues: { editBean: { userID: baseID } } } });
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient() });

    const loaded = loadExtendedAttributesScreen.load!(ctx);

    await expect(loaded).rejects.toBeInstanceOf(LegacyServiceUnavailableError);
    await expect(loaded).rejects.toMatchObject({ surface: 'admin', reason: 'extend-definitions-unserved' });
    expect(ctx.req.session.muraValues['editBean']).toBeUndefined();
    expect(ctx.gateway.calls).toEqual([]);
  });

  it('answers the trimmed Default and Basic markup as mura.json returnsets with the inventoried content type', async () => {
    const ctx = makeScreenContext({ req: personRequest(), gateway: fakeGatewayClient() });
    const data: LoadExtendedAttributesData = { subject: JANE, defaultSets: DEFAULT_SETS, basicSets: BASIC_SETS };

    const raw = await loadExtendedAttributesScreen.render(ctx, data);
    const body = String(raw.body);
    const returnsets = evalReturnsets(body);

    expect(raw.status).toBe(200);
    expect(raw.contentType.split(';')[0]).toBe(INVENTORIED.contentType);
    expect(raw.contentType).toBe(LEGACY_HTML_CONTENT_TYPE);
    expect(body.startsWith('{"extended":"')).toBe(true);
    expect(body).toContain('","basic":"');
    // The newline after the view's closing </cfoutput> prints one space.
    expect(body).toBe(
      `${legacyJsonEncode({
        extended: toString(renderExtendSets(DEFAULT_SETS, JANE, setsOptions(ctx, 'Default'))),
        basic: toString(renderExtendSets(BASIC_SETS, JANE, setsOptions(ctx, 'Basic'))),
      })} `,
    );
    expect(body).toContain('<h2>Profile &amp; &quot;Prefs&quot;</h2>');
    expect(body).toContain(String.raw`<span class=\"extendset\" extendsetid=\"EA000000-0000-0000-0000000000000D04\"`);
    for (const part of [returnsets.extended, returnsets.basic]) {
      expect(part).toBe(part.trim());
      expect(part.startsWith('<span class="extendset"')).toBe(true);
      expect(part.endsWith('</span>')).toBe(true);
    }
    expect(fragmentModel(returnsets.basic).headings).toEqual(['Contact']);
    expect(ctx.gateway.calls).toEqual([]);
  });

  it.each<[string, readonly ExtendSetDefinition[], string]>([
    ['neither container', [], '{"extended":"","basic":""} '],
    ['only the Basic container', BASIC_SETS, String.raw`{"extended":"","basic":"<span class=\"extendset\"`],
  ])('answers an empty extended part for a subtype with sets in %s', async (_label, basicSets, prefix) => {
    const ctx = makeScreenContext({ req: personRequest(), gateway: fakeGatewayClient() });

    const raw = await loadExtendedAttributesScreen.render(ctx, { subject: JANE, defaultSets: [], basicSets });

    expect(String(raw.body).startsWith(prefix)).toBe(true);
    expect(evalReturnsets(String(raw.body)).extended).toBe('');
  });

  it("renders a group's Basic sets unhidden, exactly as a person's with the same values", async () => {
    const req = adminS2Request({ ...ACTION, rc: GROUP_RC });
    const groupCtx = makeScreenContext({ req, gateway: fakeGatewayClient() });
    const personCtx = makeScreenContext({ req, gateway: fakeGatewayClient() });

    const group = await loadExtendedAttributesScreen.render(groupCtx, { subject: EDITORS, defaultSets: [], basicSets: BASIC_SETS });
    const person = await loadExtendedAttributesScreen.render(personCtx, { subject: JANE, defaultSets: [], basicSets: BASIC_SETS });
    const { basic } = evalReturnsets(String(group.body));
    const $ = cheerio.load(basic, null, false);

    expect($('span.extendset').length).toBe(1);
    expect($('span.extendset[style]').length).toBe(0);
    expect(fragmentModel(basic).controls.map(({ name, value }) => [name, value])).toEqual([
      ['extendSetID', BASIC_SET.extendSetID],
      ['extPager', '555-0100'],
    ]);
    expect(group.body).toBe(person.body);
  });
});
