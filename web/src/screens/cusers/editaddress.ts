// `cUsers.editAddress`: the controller's `editAddress()` and the address form of `admin/core/views/cusers/editaddress.cfm` (server-only).
import { LegacyServiceUnavailableError, cfEq } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/people';
import { legacySettings } from '@/lib/env';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { PageScreen, ScreenContext } from '../registry';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import {
  extendRenderContext,
  renderExtendAttribute,
  type ExtendAttributeDefinition,
  type ExtendRenderContext,
  type ExtendSetDefinition,
} from './loadextendedattributes';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the text around them joins, and whitespace-only text between two CFML tags or expressions prints one space, or
// nothing after output that already ends in whitespace.

/** People's `getAddressEdit` answer: the person, the address and the address's stored extended values. */
export type AddressEditData = components['schemas']['AddressEditData'];

/** `getSubTypeByName('Address', user subType, user siteID).getExtendSets(inherit=true, activeOnly=true)`. */
export type AddressExtendSetLoader = (ctx: ScreenContext, edit: AddressEditData) => Promise<readonly ExtendSetDefinition[]>;

/** The `tuseraddresses` columns the form prints, in the view's order. */
const ADDRESS_COLUMNS = [
  'addressName',
  'address1',
  'address2',
  'city',
  'state',
  'zip',
  'country',
  'phone',
  'fax',
  'addressURL',
  'addressEmail',
  'hours',
] as const;

type AddressColumn = (typeof ADDRESS_COLUMNS)[number];

/** Everything the view reads after `editAddress()` and the view's own set-up. */
export interface EditAddressData {
  readonly rc: CusersRc;
  /** `rc.addressID`, which `before()` does not default. */
  readonly addressId: string;
  readonly fname: string;
  readonly lname: string;
  /** `userBean.getIsPublic()` as CFML prints it. */
  readonly isPublic: string;
  /** Whether `userBean.getAddresses()` holds no row. */
  readonly noAddresses: boolean;
  /** `rsAddress` columns; '' for a NULL column, and for a new or unknown address. */
  readonly address: Readonly<Record<AddressColumn, string>>;
  readonly extendSets: readonly ExtendSetDefinition[];
  /** Stored extended values of the address by attribute name, as people returns them. */
  readonly extendedValues: Readonly<Record<string, string>>;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<EditAddressData>['render']>>;

const USE_MURA_DEFAULT = 'useMuraDefault';

const USER_JS = raw('<script type="text/javascript" src="assets/js/user.js"></script>');
const TAB_VIEW_CSS = raw('<link rel="stylesheet" href="css/tab-view.css" type="text/css" media="screen">');
const TAB_VIEW_JS = raw('<script type="text/javascript" src="assets/js/tab-view.js"></script>');

// People owns the `tuseraddresses` class extensions, but its contract serves no set or attribute definitions, so the
// registered screen renders legacy's form for an address subtype without sets, and fails closed when the address holds
// extended values whose fields it cannot render; the gateway keeps the action legacy-served in every cut-over version.
/** The extend-set source of the registered screen: none, or the legacy 503 when the address has extended values. */
export const UNSERVED_ADDRESS_EXTEND_SETS: AddressExtendSetLoader = (_ctx, edit) =>
  Object.keys(edit.extendedAttributes).length === 0
    ? Promise.resolve([])
    : Promise.reject(
        new LegacyServiceUnavailableError(
          'People serves no address class-extension definitions',
          'admin',
          'extend-definitions-unserved',
        ),
      );

/** A nullable record value as CFML text; `fallback` for NULL or absent. */
const text = (value: string | number | null | undefined, fallback = ''): string =>
  value === null || value === undefined ? fallback : String(value);

/**
 * `rc.addressID`, read unparamed as the view's first line does.
 * @throws Error As ACF does when the request carries no `addressID`.
 */
function addressIdOf(rc: CusersRc): string {
  const value = rc.addressid;
  if (value === undefined) throw new Error('Element ADDRESSID is undefined in RC.');
  if (typeof value === 'object') throw new TypeError('rc.addressID is not a simple value');
  return String(value);
}

/**
 * The view's data: people's person, address and extended values, whether the person has an address, the address
 * subtype's extend sets, and the form's CSRF pair. Gateway unavailability propagates.
 * @throws GatewayDenialError When people refuses a read (401 or 403).
 * @throws Error When the request carries no `addressID`.
 */
export async function loadEditAddress(
  ctx: ScreenContext,
  loadExtendSets: AddressExtendSetLoader = UNSERVED_ADDRESS_EXTEND_SETS,
): Promise<EditAddressData> {
  const rc = normaliseCusersRc(ctx.req);
  const addressId = addressIdOf(rc);
  const person = { siteid: rc.siteid, userid: rc.userid };
  const [editResponse, userResponse] = await Promise.all([
    ctx.gateway.people.call('get', '/v1/users/address', {
      query: { ...person, addressid: addressId, routeid: rc.routeid },
    }),
    // `getAddresses()` of the user bean: people's address read carries no count, its Edit User read lists them.
    ctx.gateway.people.call('get', '/v1/users/edit', { query: person }),
    ctx.csrf.prefetch([`updateaddress${rc.userid}`]),
  ]);
  const edit = okBody(editResponse, 'people', 'getAddressEdit');
  const { addresses } = okBody(userResponse, 'people', 'getUserEdit');
  const { user, address } = edit;
  return {
    rc,
    addressId,
    fname: text(user.Fname),
    lname: text(user.Lname),
    // A NULL flag keeps `userBean.init`'s value.
    isPublic: text(user.isPublic, '1'),
    noAddresses: addresses.length === 0,
    address: Object.fromEntries(ADDRESS_COLUMNS.map((column) => [column, text(address[column])])) as Record<
      AddressColumn,
      string
    >,
    extendSets: await loadExtendSets(ctx, edit),
    extendedValues: edit.extendedAttributes,
  };
}

// ---- CFML output ----

const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;
const UNICODE_SEPARATOR = /^[\p{Zs}\p{Zl}\p{Zp}]$/u;

/** Java `Character.isWhitespace`. */
function isJavaWhitespace(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if ((cp >= 0x09 && cp <= 0x0d) || (cp >= 0x1c && cp <= 0x20)) return true;
  return cp !== 0xa0 && cp !== 0x2007 && cp !== 0x202f && UNICODE_SEPARATOR.test(ch);
}

/** One output buffer under ACF whitespace management. */
class CfOutput {
  #out = '';

  /** Template text between two CFML constructs; whitespace-only text prints one space after non-whitespace, else nothing. */
  t(value: string): this {
    if (!TEMPLATE_WHITESPACE.test(value)) this.#out += value;
    else if (this.#out !== '' && !isJavaWhitespace(this.#out.slice(-1))) this.#out += ' ';
    return this;
  }

  /** The output of a `#…#` expression. */
  e(value: string): this {
    this.#out += value;
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** CFML `JSStringFormat`. */
const jsStringFormat = (value: string): string => value.replace(/[\\"'\n\r\t\b\f]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch);

/** `getLabel()`: the label, else the name. */
const labelOf = (attr: ExtendAttributeDefinition): string => (attr.label !== '' ? attr.label : attr.name);

/** `addressBean.getExtendedAttribute(attributeID, true)`: the stored value by case-insensitive name, else `useMuraDefault`. */
function extendedValueOf(values: Readonly<Record<string, string>>, attr: ExtendAttributeDefinition): string {
  const lower = attr.name.toLowerCase();
  const key = Object.keys(values).find((name) => name.toLowerCase() === lower);
  return key === undefined ? USE_MURA_DEFAULT : (values[key] ?? USE_MURA_DEFAULT);
}

/** One attribute's control group: label, a stored File's download link, then the control; Hidden edits as a TextBox. */
function renderAttributeGroup(o: CfOutput, attr: ExtendAttributeDefinition, value: string, ctx: ExtendRenderContext): void {
  const isHidden = cfEq(attr.type, 'Hidden');
  const label = labelOf(attr);
  const hiddenMark = (): void => {
    if (isHidden) o.t('<strong>[Hidden]</strong>');
  };
  o.t('\n\t\t\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>\n\t\t\t\t\t\t\t\t\t');
  if (attr.hint !== '') {
    o.t('\n\t\t\t\t\t\t\t\t\t<span data-toggle="popover" title="" data-placement="right" data-content="');
    o.e(encodeHtml(attr.hint)).t('" data-original-title="').e(label).t(' ');
    hiddenMark();
    o.t('">').e(label).t(' ');
    hiddenMark();
    o.t(' <i class="mi-question-circle"></i></span>\n\t\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t').e(label).t(' ');
    hiddenMark();
    o.t('\n\t\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t');
  if (cfEq(attr.type, 'File') && value !== '' && !cfEq(value, USE_MURA_DEFAULT)) {
    o.t(' <a href="').e(legacySettings().context).t('/index.cfm/_api/render/file/?fileID=').e(value);
    o.t('" target="_blank">[Download]</a> <input type="checkbox" value="true" name="extDelete');
    o.e(String(attr.attributeID)).t('"/> Delete');
  }
  o.t('\n\t\t\t\t\t\t\t\t\t</label>\n\t\t\t\t\t\t\t\t\t\n\t\t\t\t\t\t\t\t\t');
  if (isHidden) o.t('\n\t\t\t\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t\t\t\t\t');
  const control: ExtendAttributeDefinition = isHidden ? { ...attr, type: 'TextBox' } : attr;
  o.e(renderExtendAttribute(control, { value, context: ctx }).value);
  o.t('\n\t\t\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t\t\t');
}

/**
 * The extended attributes block (lines 158-198) when the subtype has sets: per set its unclosed `span.extendset`, the
 * hidden set id, the raw set name and each attribute's group, then the `initTabs` script.
 */
function renderExtendBlock(data: EditAddressData, ctx: ScreenContext): SafeHtml {
  if (data.extendSets.length === 0) return raw('');
  const context = extendRenderContext(ctx);
  const o = new CfOutput();
  o.t('\n\n\t\t\t\t\t\t');
  for (const set of data.extendSets) {
    o.t('\n\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t');
    // extendSet.getStyle() always returns '', which leaves the space before `>`.
    o.t('\n\t\t\t\t\t\t\t\t<span class="extendset" extendsetid="').e(set.extendSetID).t('" categoryid="').e(set.categoryID);
    o.t('" ').e('').t('>\n\t\t\t\t\t\t\t\t<input name="extendSetID" type="hidden" value="').e(set.extendSetID);
    o.t('"/>\n\t\t\t\t\t\t\t\t\t<h2>').e(set.name).t('</h2>\n\t\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t');
    for (const attr of set.attributes) renderAttributeGroup(o, attr, extendedValueOf(data.extendedValues, attr), context);
    o.t('\n\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t\t\t').t('\n\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t<script type="text/javascript">\n\t\t\t\t\t\tinitTabs(Array("').e(jsStringFormat(ctx.rb.rbKey('user.basic')));
  o.t('","').e(jsStringFormat(ctx.rb.rbKey('user.extendedattributes')));
  o.t('"),0,0,0);\n\t\t\t\t\t\t</script>\n\t\t\t\t\t');
  return raw(o.toString());
}

// ---- The view ----

/** The Address Information label of each plain text column. */
const TEXT_COLUMNS: ReadonlyArray<readonly [AddressColumn, string]> = Object.freeze([
  ['addressName', 'user.addressname'],
  ['address1', 'user.address1'],
  ['address2', 'user.address2'],
  ['city', 'user.city'],
  ['state', 'user.state'],
  ['zip', 'user.zip'],
  ['country', 'user.country'],
  ['phone', 'user.phone'],
  ['fax', 'user.fax'],
]);

/** One `mura-control-group` of the address fields. */
const controlGroup = (label: SafeHtml | string, control: SafeHtml): SafeHtml => html`<div class="mura-control-group">
\t\t\t\t\t\t<label>${raw(String(label))}</label>
\t\t\t\t\t\t${control}
\t\t\t\t\t</div>`;

/** The address fields from Address name to Hours, each value HTML-encoded as the view encodes it. */
function renderAddressFields(data: EditAddressData, rb: (key: string) => string): SafeHtml {
  const value = (column: AddressColumn): SafeHtml => raw(encodeHtml(data.address[column]));
  const textInput = (column: AddressColumn): SafeHtml =>
    html`<input id="${raw(column)}" name="${raw(column)}" type="text" value="${value(column)}">`;
  return join(
    [
      ...TEXT_COLUMNS.map(([column, key]) => controlGroup(rb(key), textInput(column))),
      controlGroup(`${rb('user.website')} (${rb('user.includehttp')})`, textInput('addressURL')),
      controlGroup(
        rb('user.email'),
        html`<input id="addressEmail" name="addressEmail" validate="email" message="${raw(rb('user.emailvalidate'))}" type="text" value="${value('addressEmail')}">`,
      ),
      controlGroup(rb('user.hours'), html`<textarea id="hours" rows="6" name="hours" >${value('hours')}</textarea>`),
    ],
    raw('\n\n\t\t\t\t\t'),
  );
}

/** Add for a new address, else update and delete. */
function renderButtons(data: EditAddressData, rb: (key: string) => string): SafeHtml {
  if (cfEq(data.addressId, '')) {
    return html`<button class="btn mura-primary" onclick="userManager.submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i>${raw(rb('user.add'))}</button>`;
  }
  return html`<button class="btn mura-primary" onclick="userManager.submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${raw(rb('user.update'))}</button>
\t\t\t\t\t\t\t\t<button class="btn" onclick="submitForm(document.forms.form1,'delete','${raw(jsStringFormat(rb('user.deleteaddressconfirm')))}');"><i class="mi-trash"></i>${raw(rb('user.delete'))}</button>`;
}

const IS_PRIMARY_FIELD = raw('<input type="hidden" name="isPrimary" value="1">');

/** The `cfhtmlhead` texts in the order the view runs them: the user script, then the tab-view assets with sets. */
export function editAddressHtmlHead(data: EditAddressData): SafeHtml {
  return data.extendSets.length === 0 ? USER_JS : join([USER_JS, TAB_VIEW_CSS, TAB_VIEW_JS]);
}

/** The view body inside `#mura-content`, and its `cfhtmlhead` texts. */
export function renderEditAddress(ctx: ScreenContext, data: EditAddressData): ShellView {
  const rb = (key: string): string => ctx.rb.rbKey(key);
  const { rc } = data;
  const back = raw(encodeHtml(rb('sitemanager.back')));
  const action = raw(
    `./?muraAction=cUsers.updateAddress&amp;userid=${encodeUrl(rc.userid)}&amp;routeid=${encodeUrl(rc.routeid)}&amp;siteid=${encodeUrl(rc.siteid)}`,
  );
  const body = html`
\t<form novalidate="novalidate" action="${action}" method="post" enctype="multipart/form-data" name="form1" onsubmit="return userManager.submitForm(this);"  autocomplete="off" >

\t\t<div class="mura-header">
\t\t\t<h1>${raw(rb('user.memberaddressform'))}</h1>
\t\t\t<div class="nav-module-specific btn-group">
\t\t\t<a class="btn" href="#" title="${back}" onclick="window.history.back(); return false;"><i class="mi-arrow-circle-left"></i> ${back}</a>
\t\t\t</div>
\t\t</div> <!-- /.mura-header -->

\t\t<div class="block block-constrain">
\t\t\t<div class="block block-bordered">
\t\t\t\t<div class="block-content">

\t\t\t\t\t<h2>${raw(encodeHtml(data.fname))} ${raw(encodeHtml(data.lname))}</h2>
\t\t\t\t\t${renderAddressFields(data, rb)}

\t\t\t\t\t
\t\t\t\t\t${renderExtendBlock(data, ctx)}

\t\t\t\t\t<div class="mura-actions">
\t\t\t\t\t\t<div class="form-actions">
\t\t\t\t\t\t\t
\t\t\t\t\t\t\t\t${renderButtons(data, rb)}
\t\t\t\t\t\t\t
\t\t\t\t\t\t</div>
\t\t\t\t\t</div>

\t\t\t\t\t${ctx.csrf.render(`updateaddress${rc.userid}`, 'form')}
\t\t\t\t\t<input type="hidden" name="action" value="">
\t\t\t\t\t<input type="hidden" name="addressID" value="${raw(encodeHtmlAttr(data.addressId))}">
\t\t\t\t\t<input type="hidden" name="isPublic" value="${raw(data.isPublic)}">
\t\t\t\t\t${data.noAddresses ? IS_PRIMARY_FIELD : ''}

\t\t\t\t</div> <!-- /.block-content -->
\t\t\t</div> <!-- /.block-bordered -->
\t\t</div> <!-- /.block-constrain -->
\t</form>
`;
  return { body, htmlHead: editAddressHtmlHead(data) };
}

/** `cUsers.editAddress`, owned by people, behind the cUsers `before()` gate. */
export const editAddressScreen: PageScreen<EditAddressData> = Object.freeze({
  circuit: 'cusers',
  action: 'editaddress',
  owner: 'people',
  mode: 'page',
  gate: cusersGate,
  load: (ctx: ScreenContext) => loadEditAddress(ctx),
  render: renderEditAddress,
});
