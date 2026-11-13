// `cUsers.advancedSearch`: the advanced user search form over the session's criteria, and its result list (server-only).
import { cfEq, cfToBoolean } from '@opt2/platform/legacy-compat';
import type { components } from '@/generated/clients/people';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeUrl, raw } from '@/lib/html';
import { ORIGINAL_URL_HEADER, type AdminRequest, type AdvancedSearchParam } from '@/lib/request-context';
import { buildUrl } from '@/lib/urls';
import type { PageScreen, ScreenContext } from '../registry';
import { storeAdvancedSearchCriteria, type AdvancedSearchPage, type AdvancedSearchQuery } from './advancedsearchtocsv';
import { cusersGate, normaliseCusersRc, type CusersRc } from './gate';
import { legacyPageIndex } from './inc/dsp_nextn';
import { renderUsersList, type UsersListInput, type UsersListRow } from './inc/dsp_users_list';
import { renderUsersJs } from './inc/js';

// The markup is the view's bytes as ACF 2023 emits them, matched against legacy captures: CFML comments are dropped and
// the text around them joins, and whitespace-only text between two CFML tags prints nothing after whitespace output.
// Option values, labels and criteria are written unencoded, as the view writes them.

type UserListRow = components['schemas']['UserListRow'];
type UsersNextN = NonNullable<UsersListInput['nextn']>;

/** One active `tusers` attribute of `getExtendedAttributeList(siteID, baseTable='tusers', activeOnly=true)`. */
export interface UserExtendedAttribute {
  readonly attributeID: number | string;
  /** The subtype's `Type`: 1 for groups, 2 for users. */
  readonly type: number | string;
  readonly subType: string;
  /** The attribute name. */
  readonly attribute: string;
}

/** Reads the active `tusers` extended attributes of `siteid`. */
export type UserExtendedAttributeLoader = (ctx: ScreenContext, siteid: string) => Promise<readonly UserExtendedAttribute[]>;

// People owns the `tusers` class extensions, but its contract serves no attribute definitions, so the registered screen
// renders the field list legacy shows for a site without user extended attributes.
/** The extended-attribute source of the registered screen: none. */
export const UNSERVED_USER_EXTENDED_ATTRIBUTES: UserExtendedAttributeLoader = () => Promise.resolve([]);

/** What the view reads after `advancedSearch()`. */
export interface AdvancedSearchData {
  readonly rc: CusersRc;
  /** People's result for the session's stored criteria. */
  readonly page: AdvancedSearchPage;
  readonly extendedAttributes: readonly UserExtendedAttribute[];
  /** `rc.qs`: the request parameters without `ispublic` and `muraaction`, as `name=value&` pairs. */
  readonly qs: string;
}

// The shell view type is taken from the registry's page contract, which this screen implements.
type ShellView = Awaited<ReturnType<PageScreen<AdvancedSearchData>['render']>>;

/** A `[value, label key]` pair of the view's field or condition list. */
type ListEntry = readonly [value: string, labelKey: string];

/** The built-in search fields of lines 82-115, in order. */
const FIELD_OPTIONS: readonly ListEntry[] = [
  ['tusers.fname^varchar', 'user.fname'],
  ['tusers.lname^varchar', 'user.lname'],
  ['tusers.username^varchar', 'user.username'],
  ['tusers.email^varchar', 'user.email'],
  ['tusers.company^varchar', 'user.company'],
  ['tusers.jobTitle^varchar', 'user.jobtitle'],
  ['tusers.website^varchar', 'user.website'],
  ['tusers.mobilePhone^varchar', 'user.mobilephone'],
  ['tuseraddresses.address1^varchar', 'user.address1'],
  ['tuseraddresses.address2^varchar', 'user.address2'],
  ['tuseraddresses.city^varchar', 'user.city'],
  ['tuseraddresses.state^varchar', 'user.state'],
  ['tuseraddresses.Zip^varchar', 'user.zip'],
  ['tusers.created^date', 'user.created'],
  ['tusers.tags^varchar', 'user.tag'],
];

/** The criteria conditions of lines 125-140, in order. */
const CONDITIONS: readonly ListEntry[] = [
  ['Equals', 'params.equals'],
  ['GT', 'params.gt'],
  ['GTE', 'params.gte'],
  ['LT', 'params.lt'],
  ['LTE', 'params.lte'],
  ['NEQ', 'params.neq'],
  ['Begins', 'params.beginswith'],
  ['Contains', 'params.contains'],
];

/** A select option as the view writes it: value and label, both unencoded. */
interface Choice {
  readonly value: string;
  readonly label: string;
}

/** A line break followed by `depth` tabs of legacy indentation. */
const nl = (depth: number): string => `\n${'\t'.repeat(depth)}`;

/** CFML `value eq n` for a 0 or 1 literal, where `true`/`yes` read as 1 and `false`/`no` as 0. */
function cfEqFlag(value: string, n: 0 | 1): boolean {
  if (/^(?:true|yes)$/i.test(value)) return n === 1;
  if (/^(?:false|no)$/i.test(value)) return n === 0;
  return cfEq(value, String(n));
}

// ---- rc.qs ----

/** Java `String.hashCode()`. */
function javaHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
  return hash;
}

/** `HashMap.hash` and `ConcurrentHashMap.spread`, whose bin bits agree. */
const spread = (hash: number): number => (hash ^ (hash >>> 16)) & 0x7fffffff;

const emptyTable = <T>(length: number): T[][] => Array.from({ length }, (): T[] => []);

/** Iteration order of a default `java.util.HashMap` after putting the distinct `names` in order. */
function javaHashMapOrder(names: readonly string[]): string[] {
  let table = emptyTable<string>(16);
  const slot = (name: string, length: number): number => spread(javaHash(name)) & (length - 1);
  names.forEach((name, index) => {
    table[slot(name, table.length)]?.push(name);
    if (index + 1 > table.length * 0.75) {
      const grown = emptyTable<string>(table.length * 2);
      for (const bin of table) for (const entry of bin) grown[slot(entry, grown.length)]?.push(entry);
      table = grown;
    }
  });
  return table.flat();
}

/** One key of a CFML struct: its upper-cased hash key, first-put name and last-put value. */
interface StructEntry {
  readonly key: string;
  readonly hash: number;
  readonly name: string;
  value: string;
}

/** `ConcurrentHashMap.transfer` into a table twice the size, as one thread runs it. */
function concurrentTransfer(table: readonly StructEntry[][]): StructEntry[][] {
  const length = table.length;
  const grown = emptyTable<StructEntry>(length * 2);
  table.forEach((bin, index) => {
    const first = bin[0];
    if (first === undefined) return;
    let runBit = first.hash & length;
    let lastRun = 0;
    bin.forEach((entry, at) => {
      const bit = entry.hash & length;
      if (bit !== runBit) {
        runBit = bit;
        lastRun = at;
      }
    });
    const low = runBit === 0 ? bin.slice(lastRun) : [];
    const high = runBit === 0 ? [] : bin.slice(lastRun);
    for (const entry of bin.slice(0, lastRun)) ((entry.hash & length) === 0 ? low : high).unshift(entry);
    grown[index] = low;
    grown[index + length] = high;
  });
  return grown;
}

/** Iteration order of a CFML struct (a `ConcurrentHashMap` on upper-cased keys) after putting `pairs` in order. */
function cfStructOrder(pairs: ReadonlyArray<readonly [string, string]>): StructEntry[] {
  let table = emptyTable<StructEntry>(16);
  let size = 0;
  for (const [name, value] of pairs) {
    const key = name.toUpperCase();
    const hash = spread(javaHash(key));
    const bin = table[hash & (table.length - 1)] ?? [];
    const existing = bin.find((entry) => entry.key === key);
    if (existing !== undefined) {
      existing.value = value;
      continue;
    }
    bin.push({ key, hash, name, value });
    size += 1;
    while (size >= table.length - (table.length >>> 2)) table = concurrentTransfer(table);
  }
  return table.flat();
}

// Posted names that repeat, or differ only in case, read as the form scope joins them.
/** The servlet parameters in request order: the posted fields of a POST, else the request target's query. */
function requestParameters(req: Pick<AdminRequest, 'formScope' | 'headers' | 'currentUrl'>): Array<readonly [string, string]> {
  const posted = Object.entries(req.formScope);
  if (posted.length > 0) return posted;
  const target = req.headers.get(ORIGINAL_URL_HEADER);
  let query: string;
  // Without the gateway's request-target header the URL scope of `rc.currentURL` stands in.
  if (target === null) query = req.currentUrl.replace(/^\.\/\??/, '');
  else query = target.includes('?') ? target.slice(target.indexOf('?') + 1) : '';
  return [...new URLSearchParams(query)].filter(([name]) => name !== '');
}

// Legacy walks a hash order, not the request's: the sorted parameter names fill a `HashMap`, whose entries fill the
// struct; captures of the ACF 2023 oracle confirm this order for GET and POST requests alike.
/**
 * `rc.qs` of `advancedSearch()`: `getParameterMap()` (first value per name) duplicated into a struct, `ispublic` and
 * `muraaction` deleted, then each remaining `name=value&` in the struct's order.
 */
export function advancedSearchQueryString(req: Pick<AdminRequest, 'formScope' | 'headers' | 'currentUrl'>): string {
  const firstValues = new Map<string, string>();
  for (const [name, value] of requestParameters(req)) if (!firstValues.has(name)) firstValues.set(name, value);
  const names = [...firstValues.keys()].sort();
  const pairs = javaHashMapOrder(names).map((name): readonly [string, string] => [name, firstValues.get(name) ?? '']);
  return cfStructOrder(pairs)
    .filter(({ key }) => key !== 'ISPUBLIC' && key !== 'MURAACTION')
    .map(({ name, value }) => `${name}=${value}&`)
    .join('');
}

// ---- Data ----

/** `rc.it` rows as `getValue` reads them; a NULL column reads as ''. */
const usersListRow = (row: UserListRow): UsersListRow => ({
  userid: row.UserID,
  ispublic: row.isPublic ?? '',
  s2: row.S2 ?? '',
  lname: row.Lname ?? '',
  fname: row.Fname ?? '',
  email: row.Email ?? '',
  lastupdate: row.LastUpdate ?? null,
  lastupdateby: row.LastUpdateBy ?? '',
});

/** People's `nextn` under the names `dsp_nextn` reads. */
const usersNextN = (nextn: AdvancedSearchPage['nextn']): UsersNextN => ({
  totalRecords: nextn.totalrecords,
  recordsPerPage: nextn.recordsperpage,
  numberOfPages: nextn.numberofpages,
  currentPageNumber: nextn.currentpagenumber,
  firstPage: nextn.firstpage,
  lastPage: nextn.lastpage,
  next: nextn.next,
  previous: nextn.previous,
  through: nextn.through,
  startRow: nextn.startrow,
});

/**
 * `advancedSearch()`: people stores a request's non-empty `param` criteria and runs them, else runs the stored ones.
 * @throws GatewayUnavailableError When people is unavailable; the handler answers the legacy 503.
 * @throws GatewayDenialError When people answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function loadAdvancedSearch(
  ctx: ScreenContext,
  loadExtendedAttributes: UserExtendedAttributeLoader = UNSERVED_USER_EXTENDED_ATTRIBUTES,
): Promise<AdvancedSearchData> {
  const rc = normaliseCusersRc(ctx.req);
  const query: AdvancedSearchQuery = {
    siteid: rc.siteid,
    ispublic: rc.ispublic,
    startrow: String(rc.startRow),
    recordsperpage: String(rc.recordsperpage),
  };
  // The request context captured `param` into web's session for the form; people searches its own stored copy.
  const [stored, extendedAttributes] = await Promise.all([
    storeAdvancedSearchCriteria(ctx, query),
    loadExtendedAttributes(ctx, rc.siteid),
  ]);
  const page =
    stored ??
    okBody(
      await ctx.gateway.people.call('get', '/v1/users/advanced-search', {
        query: { ...query, newsearch: String(rc.newsearch) },
      }),
      'people',
      'getAdvancedSearch',
    );
  return { rc, page, extendedAttributes, qs: advancedSearchQueryString(ctx.req) };
}

// ---- View ----

const REMOVE_ONCLICK = '$searchParams.removeSeachParam(this.parentNode);$searchParams.setSearchButtons();return false;';
const ADD_ONCLICK = '$searchParams.addSearchParam();$searchParams.setSearchButtons();return false;';

/** The labels of one criteria row, as `rbKey` returns them. */
interface RowLabels {
  readonly and: string;
  readonly or: string;
  readonly selectField: string;
  readonly remove: string;
  readonly add: string;
}

/** The criteria row's lists: the fields (built-in, then extended) and the conditions. */
interface RowChoices {
  readonly fields: readonly Choice[];
  readonly conditions: readonly Choice[];
}

/** `options`: the built-in fields with their labels, then one `<attributeID>^varchar` per extended attribute. */
function fieldChoices(ctx: Pick<ScreenContext, 'rb'>, attributes: readonly UserExtendedAttribute[]): Choice[] {
  return [
    ...FIELD_OPTIONS.map(([value, key]) => ({ value, label: ctx.rb.rbKey(key) })),
    ...attributes.map(({ attributeID, type, subType, attribute }) => ({
      value: `${attributeID}^varchar`,
      label: `${cfEq(String(type), '1') ? 'Group' : 'User'}/${subType} - ${attribute}`,
    })),
  ];
}

/** Lines 166-197: the single blank row of a new search, its relationship select hidden. */
function renderNewSearchRow(labels: RowLabels, { fields, conditions }: RowChoices): string {
  const options = (choices: readonly Choice[]): string =>
    choices.map(({ value, label }) => `${nl(8)}<option value="${value}">${label}</option>${nl(7)}`).join('');
  return [
    `${nl(5)}<div class="mura-control justify">`,
    `${nl(6)}<select name="paramRelationship1" style="display:none;">`,
    `${nl(7)}<option value="and">${labels.and}</option>${nl(7)}<option value="or">${labels.or}</option>`,
    `${nl(6)}</select>\n${nl(6)}<input type="hidden" name="param" value="1" />\n`,
    `${nl(6)}<select name="paramField1">${nl(7)}<option value="">${labels.selectField}</option>${nl(7)}`,
    options(fields),
    `${nl(6)}</select>${nl(7)}${nl(6)}<select name="paramCondition1">${nl(7)}`,
    options(conditions),
    `${nl(6)}</select>${nl(4)}${nl(6)}<input type="text" name="paramCriteria1">\n${nl(6)}`,
    `${nl(6)}<a class="criteria remove" href="javascript:;" onclick="${REMOVE_ONCLICK}" style="display:none;" title="${labels.remove}">`,
    `${nl(7)}<i class="mi-minus-circle"></i>${nl(6)}</a>${nl(6)}`,
    `${nl(6)}<a class="criteria add" href="javascript:;" onclick="${ADD_ONCLICK}" title="${labels.add}">`,
    `${nl(7)}<i class="mi-plus-circle"></i>${nl(6)}</a>${nl(5)}</div> ${nl(4)}`,
  ].join('');
}

/** Lines 200-236: stored criterion `p` (1-based) with its relationship, field and condition selected. */
function renderStoredRow(p: number, param: AdvancedSearchParam, labels: RowLabels, choices: RowChoices): string {
  const selected = (on: boolean): string => (on ? 'selected' : '');
  const options = (list: readonly Choice[], current: string): string =>
    list
      .map(
        ({ value, label }) =>
          `${nl(8)}<option value="${value}" ${selected(cfEq(current, value))}>${nl(9)}${label}${nl(8)}</option>${nl(7)}`,
      )
      .join('');
  const relationship = (value: string, label: string): string =>
    `${nl(7)}<option value="${value}" ${selected(cfEq(param.Relationship, value))}>${nl(8)}${label}${nl(7)}</option>`;
  return [
    `${nl(6)}<div class="mura-control justify">${nl(6)}<select name="paramRelationship${p}">`,
    relationship('and', labels.and),
    relationship('or', labels.or),
    `${nl(6)}</select>\n${nl(6)}<input type="hidden" name="param" value="${p}" />${nl(6)}`,
    `${nl(6)}<select name="paramField${p}">${nl(7)}<option value="">${labels.selectField}</option>${nl(7)}`,
    options(choices.fields, param.Field),
    `${nl(6)}</select>${nl(6)}${nl(6)}<select name="paramCondition${p}">${nl(7)}`,
    options(choices.conditions, param.Condition),
    `${nl(6)}</select>${nl(6)}${nl(6)}<input type="text" name="paramCriteria${p}" value="${param.Criteria}">`,
    `${nl(6)}<a class="criteria remove" href="javascript:;" onclick="${REMOVE_ONCLICK}" title="${labels.remove}">`,
    `${nl(7)}<i class="mi-minus-circle"></i>${nl(6)}</a>`,
    `${nl(6)}<a class="criteria add" href="javascript:;" onclick="${ADD_ONCLICK}" title="${labels.add}">`,
    `${nl(7)}<i class="mi-plus-circle"></i>${nl(6)}</a><br><br>${nl(6)}</div> ${nl(5)}`,
  ].join('');
}

/**
 * Lines 165-238: one blank row for a new search, for criteria another circuit stored, or without criteria; else one
 * row per stored criterion.
 * @throws TypeError As ACF does when `rc.newSearch` is not a CFML boolean.
 * @throws RangeError As ACF does when `session.paramCount` exceeds the stored criteria.
 */
function renderSearchRows(ctx: ScreenContext, rc: CusersRc, choices: RowChoices): string {
  const { rb } = ctx;
  const { paramArray, paramCount, paramCircuit } = ctx.req.session;
  const labels: RowLabels = {
    and: rb.rbKey('params.and'),
    or: rb.rbKey('params.or'),
    selectField: rb.rbKey('params.selectfield'),
    remove: rb.rbKey('params.removecriteria'),
    add: rb.rbKey('params.addcriteria'),
  };
  if (cfToBoolean(rc.newsearch) || !cfEq(paramCircuit, 'cUsers') || paramCount === 0) {
    return renderNewSearchRow(labels, choices);
  }
  let rows = '';
  for (let p = 1; p <= paramCount; p += 1) {
    const param = paramArray[p - 1];
    if (param === undefined) throw new RangeError(`The element at position ${p} of session.paramArray does not exist.`);
    rows += renderStoredRow(p, param, labels, choices);
  }
  return rows;
}

/** Lines 253-273: the hidden fields and the search button, plus the download button when the search found users. */
function renderActions(ctx: ScreenContext, rc: CusersRc, found: boolean): string {
  const { rb } = ctx;
  const download = found
    ? `${nl(6)}<button type="button" class="btn" onclick="document.forms.form2.muraAction.value='cUsers.advancedSearchToCSV';submitForm(document.forms.form2);$('#action-modal').remove();">` +
      `${nl(7)}<i class="mi-download"></i> ${nl(7)}${rb.rbKey('user.download')}${nl(6)}</button>${nl(5)}`
    : '';
  return [
    `${nl(2)}<div class="mura-actions">${nl(3)}<div class="form-actions">`,
    `${nl(4)}<input type="hidden" name="muraAction" value="cUsers.advancedSearch">`,
    `${nl(4)}<input type="hidden" name="siteid" value="${encodeHtml(rc.siteid)}">`,
    `${nl(4)}<input type="hidden" name="ispublic" value="${encodeHtml(rc.ispublic)}">${nl(4)}${nl(4)}`,
    `${nl(5)}<button type="button" class="btn mura-primary" onclick="document.forms.form2.muraAction.value='cUsers.advancedSearch';submitForm(document.forms.form2);">`,
    `${nl(6)}<i class="mi-search"></i> ${nl(6)}${rb.rbKey('user.search')}${nl(5)}</button>${nl(4)}${nl(4)}${nl(5)}`,
    download,
    `${nl(3)}</div>${nl(2)}</div>\n`,
  ].join('');
}

/** Lines 281-313: the Site Members and System Users tabs with the results pane of `ispublic`, for an admin. */
function renderAdminResults(ctx: ScreenContext, data: AdvancedSearchData, list: string): string {
  const { rb, req } = ctx;
  const { rc, qs } = data;
  const tab = (ispublic: 0 | 1, labelKey: string, after: string): string => {
    const href = buildUrl('cusers.advancedsearch', undefined, `${encodeUrl(qs)}ispublic=${ispublic}`, { ses: req.ses });
    return (
      `${nl(7)}<li${cfEqFlag(rc.ispublic, ispublic) ? ' class="active"' : ''}>${nl(8)}<a href="${href}" onclick="actionModal();">` +
      `${nl(9)}${rb.rbKey(labelKey)}${nl(8)}</a>${nl(7)}</li>${after}`
    );
  };
  const title = cfEqFlag(rc.ispublic, 1) ? rb.rbKey('user.sitemembers') : rb.rbKey('user.systemusers');
  return [
    `${nl(5)}<ul class="mura-tab-links nav-tabs">${nl(6)}`,
    tab(1, 'user.sitemembers', '\n\n\t\t        '),
    tab(0, 'user.systemusers', '\n\t\t      </ul>'),
    `${nl(5)}<!-- start tab -->${nl(5)}<div id="tab2" class="tab-pane">${nl(6)}<div class="block block-bordered">`,
    `${nl(7)}<!-- block header -->${nl(7)}<div class="block-header">${nl(8)}<h3 class="block-title">${title}</h3>`,
    `${nl(7)}</div> <!-- /.block header -->\t\t\t\t\t\t${nl(7)}<div class="block-content">`,
    `${nl(7)}  \t ${nl(5)}  \t\t${nl(8)}${list}\n${nl(8)}</div> <!-- /.block-content -->`,
    `${nl(6)}</div> <!-- /.block-bordered -->${nl(5)}</div> <!-- /.tab-pane -->${nl(5)}<!-- /end tab -->\n\n    `,
  ].join('');
}

/** Lines 315-323: the bordered Site Members results of a non-admin. */
function renderMemberResults(ctx: ScreenContext, list: string): string {
  return [
    `${nl(3)}<div class="block block-bordered">${nl(3)}  <div class="block-content">\n`,
    `\n\t\t      <h3>${ctx.rb.rbKey('user.sitemembers')}</h3>${nl(5)}${nl(5)}${list}`,
    `\n${nl(4)}</div> <!-- /.block-content -->${nl(3)}</div> <!-- /.block-bordered -->\n    `,
  ].join('');
}

/**
 * The view body inside `#mura-content` and `request.ajax` from `inc/js.cfm`. Async because the user list's delete links
 * first fetch their CSRF tokens from identity.
 */
export async function renderAdvancedSearch(ctx: ScreenContext, data: AdvancedSearchData): Promise<ShellView> {
  const { rb, req } = ctx;
  const { rc, page } = data;
  const nextn = usersNextN(page.nextn);
  const pageIndex = legacyPageIndex(nextn.startRow, nextn.recordsPerPage, nextn.totalRecords);
  const rows = page.items.slice((pageIndex - 1) * nextn.recordsPerPage, pageIndex * nextn.recordsPerPage);
  const list = await renderUsersList(ctx, {
    rows: rows.map(usersListRow),
    nextn,
    pageIndex,
    noUsersMessage: rb.rbKey('user.nosearchresults'),
    muraAction: req.action,
    rc,
  });
  const choices: RowChoices = {
    fields: fieldChoices(ctx, data.extendedAttributes),
    conditions: CONDITIONS.map(([value, key]) => ({ value, label: rb.rbKey(key) })),
  };
  const inactiveOption = (value: 0 | 1, labelKey: string): string =>
    `${nl(5)}<option value="${value}" ${cfEqFlag(req.session.inActive, value) ? 'selected' : ''}>${rb.rbKey(labelKey)}</option>`;
  const basicSearchUrl = buildUrl('cusers.search', undefined, `siteid=${encodeUrl(rc.siteid)}`, { ses: req.ses });
  const body = [
    `\n<div class="mura-header">${nl(1)}<h1>${rb.rbKey('user.advancedusersearch')}</h1>\n${nl(1)}`,
    `${nl(1)}<div class="nav-module-specific btn-group">${nl(2)}<a class="btn" href="${basicSearchUrl}" onclick="actionModal();">`,
    `${nl(3)}<i class="mi-search"></i> ${nl(3)}${rb.rbKey('user.basicsearch')}${nl(2)}</a>${nl(1)}</div>\n`,
    `\n</div> <!-- /.mura-header -->\n\n\n<div class="block block-constrain">\n`,
    `\n<form class="mura-search" novalidate="novalidate" id="advancedMemberSearch" action="index.cfm" method="get" name="form2">\n${nl(2)}`,
    `${nl(3)}<div class="mura-control-group" id="searchParams">${nl(5)}<label>${rb.rbKey('user.searchcriteria')}</label>\n${nl(5)}`,
    renderSearchRows(ctx, rc, choices),
    `${nl(3)}</div> \n${nl(2)}${nl(3)}<div class="mura-control-group">${nl(4)}<label>${rb.rbKey('user.inactive')}</label>`,
    `${nl(4)}<select name="inActive">${nl(5)}<option value="">${rb.rbKey('user.all')}</option>`,
    inactiveOption(0, 'user.yes'),
    inactiveOption(1, 'user.no'),
    `${nl(4)}</select>${nl(3)}</div>${nl(2)}\n${nl(1)}`,
    renderActions(ctx, rc, page.items.length > 0),
    `\n</form>\n\n</div>\n\n<div class="block block-constrain">${nl(1)}\n    `,
    rc.isAdmin ? renderAdminResults(ctx, data, list.value) : renderMemberResults(ctx, list.value),
    `  \n  \n\n</div> <!-- /.block-constrain -->\n\n<script type="text/javascript">$searchParams.setSearchButtons();</script>\n\n`,
  ].join('');
  return { body: raw(body), ajax: renderUsersJs(ctx) };
}

/** `cUsers.advancedSearch`, owned by people, behind the cUsers `before()` gate. */
export const advancedSearchScreen: PageScreen<AdvancedSearchData> = Object.freeze({
  circuit: 'cusers',
  action: 'advancedsearch',
  owner: 'people',
  mode: 'page',
  gate: cusersGate,
  load: (ctx: ScreenContext) => loadAdvancedSearch(ctx),
  render: renderAdvancedSearch,
});

