// The `cArch.datamanager` page: the view's in-place response writes, then the form data manager panels (server-only).
import {
  LegacyServiceUnavailableError,
  cfEq,
  cfIsBoolean,
  cfListToArray,
  cfLsDateOf,
  cfLsIsDate,
  cfToBoolean,
} from '@opt2/platform/legacy-compat';
// `application.coreversion`, which web keeps with its legacy settings rather than restating it here.
import { CORE_VERSION } from '@/lib/env';
import { join, raw, type SafeHtml } from '@/lib/html';
import { assignContext, type AdminRequest } from '@/lib/request-context';
import type { ShellView } from '@/shell/document';
import type { PageControllerRedirect, PageScreen, Rc, ScreenContext } from '../registry';
import { CARCH_OWNER, applyCarchDefaults, carchGate } from './controller';
import { dataDisplayHtmlHead, renderDataDisplay } from './data-manager/display';
import { renderDataEdit } from './data-manager/edit';
import { renderDataResponses, type DataResponseRow, type DataResponsesInput } from './data-manager/response';
import { permOf, structOf, structText, structValue, type CarchStruct } from './model';
import { carchJs } from './partials/js';
import { carchSecondaryMenuCsrfContexts, renderCarchSecondaryMenu, type CarchMenuContent } from './secondary-menu';
import { carchPageData, carchWrite, type CarchOutcome, type CarchPageModel } from './service';

const SERVICE = 'strategies-content';

/** The panel the view includes for `rc.action`. */
type Branch = 'edit' | 'display' | 'response';

/** What the view computed before its output: the page model and the session and response state it renders. */
export interface DataManagerData {
  readonly model: CarchPageModel;
  readonly branch: Branch;
  /** `session.filterBy` and `session.datakeywords` as the request leaves them. */
  readonly sessionFilterBy: string;
  readonly sessionDataKeywords: string;
  /** `dsp_response.cfm`'s `getData` outcome; absent unless that panel runs with `rc.minute1` defined. */
  readonly results?: DataResponsesInput['results'];
}

type Prepared = { readonly kind: 'ready'; readonly data: DataManagerData } | PageControllerRedirect;

/** Models the controller step prepared, keyed by the request's screen context, for `load` to hand on. */
const PREPARED = new WeakMap<ScreenContext, DataManagerData>();

/** `rc[name]`, failing as CFML does when the element is undefined. */
function rcText(rc: Rc, name: string): string {
  const value = rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** `req` with `values` assigned to its rc as CFML assigns scope keys. */
function withRc(req: AdminRequest, values: Readonly<Record<string, string>>): AdminRequest {
  return { ...req, rc: assignContext(req.rc, values) };
}

/** The `cfparam` defaults of `defaults` the rc lacks. */
function missing(rc: Rc, defaults: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(defaults).filter(([name]) => !(name in rc)));
}

/** The page outcome of a call, or the `secure()` redirect of its denial; any other 4xx fails as legacy's error does. */
function settled<T>(
  outcome: CarchOutcome<T>,
  step: string,
): { readonly kind: 'ok'; readonly data: T } | PageControllerRedirect {
  if (outcome.kind === 'redirect') return { kind: 'location', location: outcome.location };
  if (outcome.kind === 'rejected') {
    throw new Error(`${SERVICE} rejected the carch.datamanager ${step} with HTTP ${String(outcome.status)}`);
  }
  return outcome;
}

/** Lines 94-105: whether `rc` selects the Update, Delete or setDisplay write; the service validates any token. */
function selectsInViewWrite(rc: Rc, action: string): boolean {
  return ('responseid' in rc && (cfEq(action, 'Update') || cfEq(action, 'Delete'))) || cfEq(action, 'setDisplay');
}

/** Lines 155-163: the panel `rc.action` includes. */
function branchOf(action: string): Branch {
  if (cfEq(action, 'edit')) return 'edit';
  return cfEq(action, 'display') ? 'display' : 'response';
}

/** A model value that must be an array of structs, such as a query's rows. */
function rowsOf(struct: CarchStruct, key: string): CarchStruct[] {
  const value = structValue(struct, key);
  if (!Array.isArray(value) || !value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
    throw new TypeError(`${SERVICE} returned no rc.${key} rows for carch.datamanager`);
  }
  return value as CarchStruct[];
}

/** A simple model value that must be present; SQL NULL reads as `''`. */
function presentText(struct: CarchStruct, key: string): string {
  if (structValue(struct, key) === undefined) {
    throw new TypeError(`${SERVICE} returned no rc.${key} for carch.datamanager`);
  }
  return structText(struct, key);
}

/** A date column as ColdFusion prints it, or null for SQL NULL. */
function dateOf(row: CarchStruct, key: string): string | null {
  const value = structValue(row, key);
  return value === null || value === undefined ? null : structText(row, key);
}

/** A deserialised WDDX packet with its simple values as CFML text; null where `wddx2cfml` failed. */
function packetOf(row: CarchStruct): Readonly<Record<string, string>> | null {
  const value = structValue(row, 'data');
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('A response packet is not a struct');
  const packet = value as CarchStruct;
  return Object.fromEntries(Object.keys(packet).map((name) => [name, structText(packet, name)]));
}

/** One `rsData` row of the edit or response panel. */
function responseRow(row: CarchStruct): DataResponseRow {
  return { responseId: presentText(row, 'responseID'), entered: dateOf(row, 'entered'), data: packetOf(row) };
}

/** `muraormentities eq true` on the form JSON; undefined where legacy's cftry would dump its error and abort. */
function ormFormFlag(body: string): boolean | undefined {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    // isJSON is false, so the view skips the check.
    return false;
  }
  const asStruct = (value: unknown): CarchStruct | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as CarchStruct) : undefined;
  const root = asStruct(json);
  const form = root === undefined ? undefined : asStruct(structValue(root, 'form'));
  if (form === undefined) return undefined;
  if (structValue(form, 'muraormentities') === undefined) return false;
  const attributes = asStruct(structValue(form, 'formattributes'));
  if (attributes === undefined) return undefined;
  const flag = structValue(attributes, 'muraormentities');
  return flag !== undefined && cfIsBoolean(flag) && cfToBoolean(flag);
}

/**
 * The view's work before output (lines 76-125, and dsp_response.cfm 158-167): carch before(), the rc and session
 * params, the selected write, the page model and, for a filtered response list, its bulk delete.
 * @throws LegacyServiceUnavailableError For an ORM-entity form, whose `dsp_ormform.cfm` include is absent at the pin.
 * @throws GatewayUnavailableError When strategies-content is unavailable.
 */
async function prepare(ctx: ScreenContext): Promise<Prepared> {
  ctx.req = applyCarchDefaults(ctx.req);
  ctx.req = withRc(ctx.req, missing(ctx.req.rc, { keywords: '', filterBy: '' }));
  const { rc } = ctx.req;
  // session.filterBy and session.datakeywords have no store: identity's admin session state declares neither key, so
  // a newSearch sets them for this request only and every other request reads their cfparam default ''.
  const newSearch = 'newSearch' in rc;
  const sessionFilterBy = newSearch ? rcText(rc, 'filterBy') : '';
  const sessionDataKeywords = newSearch ? rcText(rc, 'keywords') : '';

  const action = rcText(rc, 'action');
  if (selectsInViewWrite(rc, action)) {
    const written = settled(await carchWrite(ctx, 'datamanager'), 'write');
    if (written.kind !== 'ok') return written;
    if (cfEq(action, 'setDisplay')) ctx.req = withRc(ctx.req, { action: '' });
  }

  const page = settled(await carchPageData(ctx, 'datamanager'), 'read');
  if (page.kind !== 'ok') return page;
  const model = page.data;
  const bean = structOf(model.rc, 'contentBean');
  // Lines 89-90; the bean already holds any display settings setDisplay saved.
  ctx.req = withRc(
    ctx.req,
    missing(ctx.req.rc, { sortBy: structText(bean, 'sortBy'), sortDirection: structText(bean, 'sortDirection') }),
  );
  if (ormFormFlag(structText(bean, 'body')) !== false) {
    throw new LegacyServiceUnavailableError(
      'The ORM form data manager includes data_manager/dsp_ormform.cfm, which the pinned Masa does not ship',
      'admin',
      'datamanager-orm-form',
    );
  }

  const branch = branchOf(rcText(ctx.req.rc, 'action'));
  const base = { model, branch, sessionFilterBy, sessionDataKeywords };
  if (branch !== 'response' || !('minute1' in ctx.req.rc)) return { kind: 'ready', data: base };
  const rows = rowsOf(model.rc, 'rsData').map(responseRow);
  const remove = ctx.req.rc.delete;
  if (rows.length === 0 || remove === undefined || !cfIsBoolean(remove) || !cfToBoolean(remove)) {
    return { kind: 'ready', data: { ...base, results: { kind: 'rows', rows } } };
  }
  const deleted = settled(await carchWrite(ctx, 'datamanager'), 'bulk delete');
  if (deleted.kind !== 'ok') return deleted;
  return { kind: 'ready', data: { ...base, results: { kind: 'deleted', count: rows.length } } };
}

/** A model flag as a CFML boolean; undefined when the model leaves it out. */
function flagOf(struct: CarchStruct, key: string): boolean | undefined {
  const value = structValue(struct, key);
  return value === undefined || value === null ? undefined : cfToBoolean(value);
}

/** `rc.contentBean` as the secondary menu reads it. */
function menuContent(bean: CarchStruct): CarchMenuContent {
  return {
    isNew: cfEq(structText(bean, 'isNew'), '1'),
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    active: Number(structText(bean, 'active')),
    filename: structText(bean, 'filename'),
    contentHistId: structText(bean, 'contentHistID'),
    parentId: structText(bean, 'parentID'),
    menuTitle: structText(bean, 'menuTitle'),
    remoteUrl: structText(bean, 'remoteURL'),
    fileId: structText(bean, 'fileID'),
    stats: structOf(bean, 'stats'),
  };
}

/** dsp_edit.cfm: the `read(rc.responseid)` row in the form that posts back Update or Delete. */
function editPanel(ctx: ScreenContext, model: CarchPageModel): Promise<SafeHtml> {
  const { rc, session } = ctx.req;
  const responseId = rcText(rc, 'responseid');
  const [row] = rowsOf(model.rc, 'rsData');
  if (row === undefined) throw new TypeError(`${SERVICE} returned no response ${responseId} for carch.datamanager`);
  const { responseId: id, data } = responseRow(row);
  // dsp_edit.cfm deserialises the packet outside any cftry, so legacy fails on one wddx2cfml rejects.
  if (data === null) throw new TypeError(`The packet of response ${id} is not valid WDDX`);
  const entered = dateOf(row, 'entered');
  return renderDataEdit(ctx, {
    fieldnames: presentText(model.rc, 'fieldnames'),
    response: { responseId: id, entered, enteredRaw: entered ?? '', data },
    contentid: rcText(rc, 'contentid'),
    siteid: rcText(rc, 'siteid'),
    moduleid: rcText(rc, 'moduleid'),
    hour1: rcText(rc, 'hour1'),
    hour2: rcText(rc, 'hour2'),
    minute1: rcText(rc, 'minute1'),
    minute2: rcText(rc, 'minute2'),
    date1: rcText(rc, 'date1'),
    date2: rcText(rc, 'date2'),
    sortBy: rcText(rc, 'sortBy'),
    sortDirection: rcText(rc, 'sortDirection'),
    filterBy: rcText(rc, 'filterBy'),
    keywords: rcText(rc, 'keywords'),
    dateKeyFormat: session.dateKeyFormat,
    locale: session.locale,
  });
}

/** dsp_display.cfm: the summary and detail display fields, records per page and sort of the form. */
function displayPanel(ctx: ScreenContext, model: CarchPageModel, bean: CarchStruct): SafeHtml {
  const { rc, session } = ctx.req;
  return renderDataDisplay(ctx, {
    fieldnames: presentText(model.rc, 'fieldnames'),
    responseDisplayFields: structText(bean, 'responseDisplayFields'),
    nextN: structText(bean, 'nextN'),
    sortBy: structText(bean, 'sortBy'),
    sortDirection: structText(bean, 'sortDirection'),
    contentid: rcText(rc, 'contentid'),
    moduleid: rcText(rc, 'moduleid'),
    sessionSiteId: session.siteid,
  });
}

/** dsp_response.cfm 77-87: `rc.date1` when the session locale reads it as a date, else the entry it defaults to. */
function rangeDate(text: string, entered: string | null, locale: string): DataResponsesInput['date1'] {
  if (cfLsIsDate(text, locale)) return { value: cfLsDateOf(text, locale), raw: text };
  return { value: entered, raw: entered ?? '' };
}

/** dsp_response.cfm 89-93: the summary display fields, else the form's current field list. */
function responseFieldnames(model: CarchPageModel, bean: CarchStruct): string {
  const displayFields = structText(bean, 'responseDisplayFields');
  if (displayFields.length === 0 || displayFields === '~') return presentText(model.rc, 'fieldnames');
  return (cfListToArray(displayFields, '~').at(-1) ?? '').replaceAll('^', ',');
}

/** dsp_response.cfm: the download form and, once filtered, the response grid or the bulk delete count. */
function responsePanel(
  ctx: ScreenContext,
  data: DataManagerData,
  bean: CarchStruct,
  info: CarchStruct,
): Promise<SafeHtml> {
  const { rc, session } = ctx.req;
  const firstEntered = dateOf(info, 'firstEntered');
  const lastEntered = dateOf(info, 'lastEntered');
  const { model } = data;
  return renderDataResponses(ctx, {
    countEntered: Number(presentText(info, 'CountEntered')),
    firstEntered,
    lastEntered,
    date1: rangeDate(rcText(rc, 'date1'), firstEntered, session.locale),
    date2: rangeDate(rcText(rc, 'date2'), lastEntered, session.locale),
    fieldnames: responseFieldnames(model, bean),
    sortBy: rcText(rc, 'sortBy'),
    sortDirection: rcText(rc, 'sortDirection'),
    filterBy: rcText(rc, 'filterBy'),
    keywords: rcText(rc, 'keywords'),
    sessionFilterBy: data.sessionFilterBy,
    sessionDataKeywords: data.sessionDataKeywords,
    contentid: rcText(rc, 'contentid'),
    siteid: rcText(rc, 'siteid'),
    sessionSiteId: session.siteid,
    moduleid: rcText(rc, 'moduleid'),
    hour1: rc.hour1,
    minute1: rc.minute1,
    hour2: rc.hour2,
    minute2: rc.minute2,
    columns: rc.columns ?? 'fixed',
    siteScheme: presentText(model.rc, 'scheme'),
    siteDomain: presentText(model.rc, 'domain'),
    serverPort: presentText(model.rc, 'serverPort'),
    context: presentText(model.rc, 'context'),
    dateKeyFormat: session.dateKeyFormat,
    locale: session.locale,
    ...(data.results === undefined ? {} : { results: data.results }),
  });
}

/** The panel include of `data.branch`, which the view places inside `block-content`. */
function panelOf(ctx: ScreenContext, data: DataManagerData, bean: CarchStruct, info: CarchStruct): Promise<SafeHtml> {
  if (data.branch === 'edit') return editPanel(ctx, data.model);
  if (data.branch === 'display') return Promise.resolve(displayPanel(ctx, data.model, bean));
  return responsePanel(ctx, data, bean, info);
}

/** Lines 128-167: the header with the secondary menu and record count, then the selected panel. */
async function renderDataManager(ctx: ScreenContext, data: DataManagerData): Promise<ShellView> {
  const { req, rb } = ctx;
  const { model, branch } = data;
  const bean = structOf(model.rc, 'contentBean');
  const [info] = rowsOf(model.rc, 'rsDataInfo');
  if (info === undefined) throw new TypeError(`${SERVICE} returned an empty rc.rsDataInfo for carch.datamanager`);
  await ctx.csrf.prefetch(carchSecondaryMenuCsrfContexts(req.rc));
  const menuFlags = {
    hasLockableNodes: flagOf(model.rc, 'hasLockableNodes'),
    useLayoutManager: flagOf(model.rc, 'useLayoutManager'),
  };
  const menu = renderCarchSecondaryMenu(ctx, {
    rc: req.rc,
    content: menuContent(bean),
    perm: permOf(model),
    ...menuFlags,
  });
  const panel = await panelOf(ctx, data, bean, info);
  const label = (key: string): string => rb.rbKey(`sitemanager.content.${key}`);
  // The title and count are printed unencoded, as legacy prints them.
  const body = raw(
    `\n\n\t<div class="mura-header">\n\t\t<h1>${label('managedata')}</h1>\n\t\t${menu.value}` +
      `\n\t\t<div class="mura-item-metadata">\n\t\t\t<div class="label-group">` +
      `\n\t\t\t\t<span class="label">${label('fields.title')}: <strong>${structText(bean, 'title')}</strong></span>` +
      `\n\t\t\t\t<span class="label">${label('totalrecordsavailable')}: ` +
      `<strong>${presentText(info, 'CountEntered')}</strong></span>` +
      `\n\t\t\t</div>\n\t\t</div><!-- /.mura-item-metadata -->\n\t</div> <!-- /.mura-header -->\n\t` +
      `\n\n\t<div class="block block-constrain">\n\t\t<div class="block block-bordered">` +
      `\n\t\t  <div class="block-content">` +
      `\n\t\t\t\t\t${panel.value}` +
      `\n\t\t\t</div> <!-- /.block-content -->\n\t\t</div> <!-- /.block-bordered -->` +
      `\n\t</div> <!-- /.block-constrain -->\n`,
  );
  const dateKey = req.session.dateKey.script;
  return {
    body,
    ajax: carchJs(ctx, req.item),
    // cfhtmlhead text accumulates in call order: the view's date key, then dsp_display.cfm's script.
    htmlHead: branch === 'display' ? join([dateKey, dataDisplayHtmlHead(CORE_VERSION)]) : dateKey,
  };
}

/** The `cArch.datamanager` admin action: its in-view writes run as the controller step, before the page renders. */
export const datamanagerScreen: PageScreen<DataManagerData> = Object.freeze({
  circuit: 'carch',
  action: 'datamanager',
  owner: CARCH_OWNER,
  mode: 'page',
  gate: carchGate,
  secondaryMenu: 'carch',
  // The writes and reads run in the redirect step, where a service denial can still answer with secure()'s redirect.
  async redirect(ctx: ScreenContext): Promise<PageControllerRedirect | undefined> {
    const prepared = await prepare(ctx);
    if (prepared.kind !== 'ready') return prepared;
    PREPARED.set(ctx, prepared.data);
    return undefined;
  },
  load(ctx: ScreenContext): Promise<DataManagerData> {
    const data = PREPARED.get(ctx);
    if (data === undefined) return Promise.reject(new Error('carch.datamanager loaded before its controller step ran'));
    PREPARED.delete(ctx);
    return Promise.resolve(data);
  },
  render: renderDataManager,
});
