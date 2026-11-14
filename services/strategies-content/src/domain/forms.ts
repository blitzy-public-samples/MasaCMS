/**
 * Form responses and the data manager (dataCollectionManager.cfc, carch.datamanager and carch.downloaddata), the cform
 * dialog bean inputs and form list (cform.cfc:161-210, formBuilderManager.cfc:349-368), and JSON API `submitForm`.
 */
import {
  cfEq,
  cfIsBoolean,
  cfIsNumeric,
  cfListAppend,
  cfListToArray,
  cfLsDateFormat,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfTimestampParam,
  cfTimestampText,
  cfToBoolean,
  cfToNumber,
  cfUuid,
  isCfUuid,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { qualified, withGatedTenant, type WriteContext } from '@opt2/platform/migration-kit';
import { poolTenantFor, withTenant, type TenantTx } from '@opt2/platform/tenancy';
import type { DatasetBeanInput, FieldBeanInput, FieldTypeBeanInput, FormBeanInput, NestedFormRow } from '../legacy/admin-render-forms.js';
import type { FormResponseDeletion, FormResponsesArgs, FormResponseWrite } from '../repo/repository.js';
import { CONTENT, type ContentRow, type FormResponsePacketRow } from '../repo/tables.js';
import { LegacyContentBean, type ContentDeps } from './content.js';
import { UndefinedLegacyMethodError, writeContextFor, type Actor } from './context.js';
import { deleteFileVersion, requestHasRestrictedFiles, storeUploadedFile, type UploadedFile } from './files.js';
import { WddxNumber, cfStruct, cfml2wddx, wddx2cfml, wddxStructGet, type WddxStruct, type WddxValue } from './wddx.js';

/** dataCollectionManager.update's `ignoreList` (dataCollectionManager.cfc:107), matched with ListFindNoCase. */
export const FORM_FIELD_IGNORE_LIST =
  '_P,CSSCLASS,ASYNC,CSS,CSSID,CSRF_TOKEN,CSRF_TOKEN_EXPIRES,INSTANCEID,OBJECTID,PERM,OBJECT,OBJECTNAME,OBJECTICONCLASS,VIEW,INITED,LABEL,ASYNC,REPONSECHART,ISCONFIGURATOR,CONTENTID,CONTENTHISTID,NOCACHE,DOACTION,SUBMIT,MLID,SITEID,FORMID,POLLLIST,REDIRECT_URL,REDIRECT_LABEL,X,Y,UKEY,HKEY,formfield1234567891,formfield1234567892,formfield1234567893,formfield1234567894,INITED,useProtect,linkservid,useReCAPTCHA,g-recaptcha,response,grecaptcharesponse,RENDER,RESPONSECHART,CSSSTYLES,CONTENTCSSSTYLES,METACSSSTYLES,CONTENTCSSCLASS,CONTENTCSSID,METACSSCLASS,METACSSID,CLASS';

/** Module id fileManager.create gets for a form attachment (dataCollectionManager.cfc:152). */
export const FORM_ATTACHMENT_MODULE_ID = '00000000000000000000000000000000004';

/** Session locale used when a caller gives none. */
const DEFAULT_LOCALE = 'en_US';
const CRLF = '\r\n';
const SCRIPT_OPEN = /<script|<form/gi;
const SCRIPT_CLOSE = /script>|form>/gi;

/** Request values keyed as CFML `rc` keys them; key case is ignored. */
export type LegacyRc = Readonly<Record<string, unknown>>;

/** Per-call settings of a response write. */
export interface FormWriteOptions {
  requestId?: string;
}

/** JSON API `submitForm`: listed in `publicMethods` (jsonApiUtility.cfc:34) but defined nowhere, so legacy's invoke fails with a 500. */
export function submitForm(): never {
  throw new UndefinedLegacyMethodError('submitForm');
}

// ---- CFML value helpers ----

/** Java String.equalsIgnoreCase, as CFML list and struct-key matching compares. */
function equalsIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a.charAt(i);
    const y = b.charAt(i);
    if (x !== y && x.toUpperCase() !== y.toUpperCase() && x.toLowerCase() !== y.toLowerCase()) return false;
  }
  return true;
}

/** CFML ListFindNoCase(list, value) > 0. */
function listHasNoCase(list: string, value: string): boolean {
  return cfListToArray(list).some((item) => equalsIgnoreCase(item, value));
}

/** The spelling under which `rc` holds `key`, ignoring case; undefined when absent (CFML StructKeyExists false). */
function rcKey(rc: LegacyRc, key: string): string | undefined {
  if (Object.hasOwn(rc, key)) return key;
  return Object.keys(rc).find((name) => equalsIgnoreCase(name, key));
}

/** Whether `rc` holds `key` (CFML `isDefined('rc.<key>')`). */
function rcHas(rc: LegacyRc, key: string): boolean {
  return rcKey(rc, key) !== undefined;
}

/** `rc[key]`, undefined when absent. */
function rcGet(rc: LegacyRc, key: string): unknown {
  const found = rcKey(rc, key);
  return found === undefined ? undefined : rc[found];
}

/** A simple value as CFML reads it in string context; complex values fail as ACF fails converting them. */
function simpleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return cfTimestampText(value);
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

/** `rc.<key>`; a missing key fails as CFML fails reading an undefined element. */
function rcValue(rc: LegacyRc, key: string): unknown {
  const value = rcGet(rc, key);
  if (value === undefined) throw new Error(`Element ${key.toUpperCase()} is undefined in a CFML structure referenced as part of an expression.`);
  return value;
}

/** `rc.<key>` as text; a missing key fails as CFML fails reading an undefined element. */
function rcText(rc: LegacyRc, key: string): string {
  return simpleText(rcValue(rc, key));
}

/** `rc.<key>` as text, or `fallback` when absent (a key the controller or view `cfparam`s). */
function rcTextOr(rc: LegacyRc, key: string, fallback: string): string {
  return rcHas(rc, key) ? rcText(rc, key) : fallback;
}

/** `rc` with `values` set on keys it lacks, as `cfparam` sets them. */
function withDefaults(rc: LegacyRc, values: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rc };
  for (const [key, value] of Object.entries(values)) if (!rcHas(out, key)) out[key] = value;
  return out;
}

/** `rc` with `key` set (an existing spelling kept). */
function withValue(rc: LegacyRc, key: string, value: unknown): Record<string, unknown> {
  return { ...rc, [rcKey(rc, key) ?? key]: value };
}

/** CFML FindNoCase('attachment', field) > 0. */
function isAttachmentField(field: string): boolean {
  return /attachment/i.test(field);
}

/** The file pool tenant's transaction for `tx`'s tenant: `tx` itself for an unpooled site, else a gated one of the pool tenant. */
async function inFilePool<T>(deps: ContentDeps, tx: TenantTx, fn: (fileTx: TenantTx) => Promise<T>): Promise<T> {
  const pool = await poolTenantFor(tx, tx.tenantId, 'file');
  if (pool === null) throw new Error(`Tenant ${tx.tenantId} has no site registry entry`);
  return pool === tx.tenantId ? fn(tx) : withGatedTenant(deps.db, pool, fn);
}

// ---- responses (dataCollectionManager.cfc:91-235) ----

/** What dataCollectionManager.update wrote, with the `info` struct it returns. */
export interface FormResponseUpdate extends FormResponseWrite {
  responseId: string;
  /** `info` in ACF's iteration order, as the packet serializes it. */
  info: WddxStruct;
}

/** dataCollectionManager.update's `info`: every assignment is replayed in order, so `cfStruct` reproduces ACF's key order. */
class InfoStruct {
  private readonly assignments: Array<[string, WddxValue]> = [];
  private readonly values = new Map<string, string>();

  set(key: string, value: string): void {
    this.assignments.push([key, value]);
    this.values.set(key.toUpperCase(), value);
  }

  get(key: string): string {
    return this.values.get(key.toUpperCase()) ?? '';
  }

  struct(): WddxStruct {
    return cfStruct(this.assignments);
  }
}

// Of the scope's one key, requestHasRestrictedFiles inspects only a posted file field literally named `test`
// (isPostedFile('test')); only its posted-file branch is ported, as files.ts ports it.
/** fileManager.requestHasRestrictedFiles(scope={test=value}, fmPublicAllowedExtensions) (dataCollectionManager.cfc:147-148). */
function attachmentRestricted(deps: ContentDeps, files: readonly UploadedFile[]): boolean {
  const probe = files.find((file) => equalsIgnoreCase(file.fieldName, 'test') && file.fileName !== '');
  return requestHasRestrictedFiles(probe === undefined ? [] : [probe], deps.config.fmPublicAllowedExtensions);
}

/** cffile upload, fileManager.process and fileManager.create of an attachment part: the stored file id. */
async function storeAttachment(deps: ContentDeps, actor: Actor, file: UploadedFile, formId: string, opts: FormWriteOptions): Promise<string> {
  if (deps.storage === undefined) throw new Error('Form attachments need the storage port');
  const stored = await storeUploadedFile({ ...deps, storage: deps.storage }, actor, {
    file,
    contentId: formId,
    moduleId: FORM_ATTACHMENT_MODULE_ID,
    requestId: opts.requestId,
  });
  return stored.fileid;
}

/**
 * dataCollectionManager.update: a new response of `data.fieldnames`, or with `data.responseid` the replacement of that
 * response from `data.fieldlist`, keeping `data.entered`. Questions and packet are written in one gated transaction.
 * @param files Posted file parts; an attachment field with a part of its name stores it (non-image only).
 * @throws ImageUploadHaltedError for an image attachment, whose renditions stay legacy-written.
 */
export async function updateResponse(
  deps: ContentDeps,
  actor: Actor,
  data: LegacyRc,
  files: readonly UploadedFile[] = [],
  opts: FormWriteOptions = {},
): Promise<FormResponseUpdate> {
  const values: Record<string, unknown> = { ...data };
  const put = (key: string, value: unknown): void => {
    values[rcKey(values, key) ?? key] = value;
  };
  const formId = rcText(values, 'formid');
  const siteId = rcText(values, 'siteid');
  const info = new InfoStruct();
  info.set('fieldnames', '');

  let ignoreList = FORM_FIELD_IGNORE_LIST;
  const ignoreFields = rcGet(values, 'ignoreFields');
  if (['string', 'number', 'boolean'].includes(typeof ignoreFields) && simpleText(ignoreFields) !== '') {
    ignoreList = cfListAppend(ignoreList, simpleText(ignoreFields));
  }

  const update = rcHas(values, 'responseid');
  const responseId = update ? rcText(values, 'responseid') : cfUuid();
  const fieldList = rcText(values, update ? 'fieldlist' : 'fieldnames');
  // Bound before any write: legacy binds `entered` last, after its non-transactional delete and question inserts.
  const entered = update ? cfTimestampParam(rcValue(values, 'entered')) : deps.clock.now();
  info.set('responseid', responseId);

  const questions: { formfield: string; formvalue: string }[] = [];
  for (const f of cfListToArray(fieldList)) {
    if (listHasNoCase(ignoreList, f)) continue;
    let field = f;
    if (!update && cfEq(f.slice(-8), '_default')) {
      const renamed = f.slice(0, Math.max(0, f.length - 8));
      if (listHasNoCase(rcText(values, 'fieldnames'), renamed)) {
        field = '';
      } else {
        put(renamed, rcValue(values, f));
        field = renamed;
        info.set('fieldnames', cfListAppend(info.get('fieldnames'), field));
      }
    } else {
      info.set('fieldnames', cfListAppend(info.get('fieldnames'), field));
    }
    if (field === '' || !rcHas(values, field)) continue;

    if (isAttachmentField(field) && rcText(values, field) !== '') {
      if (attachmentRestricted(deps, files)) {
        info.set(field, '');
      } else {
        // A field without a posted part fails cffile, whose error legacy swallows, keeping the posted value.
        const part = files.find((file) => equalsIgnoreCase(file.fieldName, field) && file.fileName !== '');
        if (part !== undefined) put(field, await storeAttachment(deps, actor, part, formId, opts));
        info.set(field, rcText(values, field));
      }
    }
    info.set(field, javaTrim(rcText(values, field)));
    info.set(field, info.get(field).replace(SCRIPT_OPEN, '<noscript'));
    info.set(field, info.get(field).replace(SCRIPT_CLOSE, 'noscript>'));
    questions.push({ formfield: field, formvalue: info.get(field) });
  }

  const struct = info.struct();
  const input = {
    responseid: responseId,
    formid: formId,
    siteid: siteId,
    entered,
    data: cfml2wddx(struct),
    fieldlist: info.get('fieldnames'),
    questions,
  };
  const write = writeContextFor(actor, opts.requestId);
  const written = await withGatedTenant(deps.db, actor.tenantId, (tx) =>
    update ? deps.repository.forms.updateResponse(tx, input, write) : deps.repository.forms.insertResponse(tx, input, write),
  );
  return { ...written, responseId, info: struct };
}

/** dataCollectionManager.delete in `tx`; with `deleteFiles`, attachment fields holding a CF UUID flag that file deleted. */
async function deleteResponseInTx(
  deps: ContentDeps,
  tx: TenantTx,
  responseId: string,
  deleteFiles: boolean,
  write: WriteContext,
): Promise<FormResponseDeletion> {
  const deletion = await deps.repository.forms.deleteResponse(tx, { responseId }, write);
  if (deleteFiles && deletion.attachmentFileIds.length > 0) {
    await inFilePool(deps, tx, async (fileTx) => {
      for (const fileId of deletion.attachmentFileIds) await deleteFileVersion(fileTx, deps.repository, fileId, write);
    });
  }
  return deletion;
}

/** dataCollectionManager.delete: a response's questions and packet, and with `deleteFiles` its attachment files. */
export function deleteResponse(
  deps: ContentDeps,
  actor: Actor,
  responseId: string,
  deleteFiles = true,
  opts: FormWriteOptions = {},
): Promise<FormResponseDeletion> {
  const write = writeContextFor(actor, opts.requestId);
  return withGatedTenant(deps.db, actor.tenantId, (tx) => deleteResponseInTx(deps, tx, responseId, deleteFiles, write));
}

/** dataCollectionManager.read: a response's packet row, or null. */
export function readResponse(deps: ContentDeps, actor: Actor, responseId: string): Promise<FormResponsePacketRow | null> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.forms.readResponse(tx, { responseId }));
}

/** The response values the data manager views read: `wddx2cfml(rsdata.data)` (dsp_edit.cfm:83, dsp_response.cfm:186). */
export function responseValues(row: Pick<FormResponsePacketRow, 'data'>): WddxValue {
  return wddx2cfml(row.data ?? '');
}

/** dataCollectionManager.getFullFieldList: every field answered on the form, as a CF list in field order. */
export function getFullFieldList(deps: ContentDeps, actor: Actor, formId: string): Promise<string> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.forms.fullFieldList(tx, { formId }));
}

/** dataCollectionManager.getCurrentFieldList: the form's detail display fields (`^` as `,`), else the full field list. */
export function getCurrentFieldList(deps: ContentDeps, actor: Actor, formId: string): Promise<string> {
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.forms.currentFieldList(tx, { formId }));
}

// ---- data manager (dataCollectionManager.cfc:271-323, 399-414; carch datamanager and downloaddata) ----

/** contentManager.getDownloadselect: a form's first and last submission times and its submission count. */
export interface DownloadSelectRow {
  firstentered: Date | null;
  lastentered: Date | null;
  countentered: number;
}

/** A createDateTime hour or minute argument read from `rc`: an integer in [0, max]; anything else fails as ACF fails it. */
function clockPart(rc: LegacyRc, key: string, max: number): number {
  const value = rcText(rc, key);
  const n = cfIsNumeric(value) ? cfToNumber(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`The value ${value} of ${key} is not a valid createDateTime argument.`);
  return n;
}

/** getData's `start` or `stop`: the LS date of `rc[dateKey]` at `rc[hourKey]:rc[minuteKey]:second`; undefined when absent or no date. */
function boundOf(rc: LegacyRc, keys: readonly [string, string, string], second: number, locale: string): Date | undefined {
  const [dateKey, hourKey, minuteKey] = keys;
  const raw = rcGet(rc, dateKey);
  if (raw === undefined) return undefined;
  let day: Date;
  if (raw instanceof Date) {
    day = raw;
  } else {
    const text = simpleText(raw);
    if (!cfLsIsDate(text, locale)) return undefined;
    day = cfLsParseDateTime(text, locale);
  }
  const bound = new Date(day.getTime());
  bound.setHours(clockPart(rc, hourKey, 23), clockPart(rc, minuteKey, 59), second, 0);
  return bound;
}

/**
 * dataCollectionManager.getData's arguments from `rc`, reading only the keys legacy's short-circuit reads (the stop
 * bound at second 59); a read key `rc` lacks fails as legacy fails.
 * @param locale Session locale of `lsIsDate` and `lsParseDateTime`.
 */
export function formResponsesArgs(rc: LegacyRc, locale = DEFAULT_LOCALE): FormResponsesArgs {
  const sortBy = rcText(rc, 'sortby');
  const byEntered = cfEq(sortBy, 'Entered');
  const keywords = rcText(rc, 'keywords');
  const fieldNames = !byEntered || keywords !== '' ? cfListToArray(rcText(rc, 'fieldnames')) : [];
  const sorted = byEntered || (sortBy !== '' && fieldNames.includes(sortBy));
  const start = boundOf(rc, ['date1', 'hour1', 'minute1'], 0, locale);
  const stop = boundOf(rc, ['date2', 'hour2', 'minute2'], 59, locale);
  const direction = sorted ? rcText(rc, 'sortdirection') : '';
  return {
    formId: rcText(rc, 'contentid'),
    siteId: rcText(rc, 'siteid'),
    fieldNames,
    keywords,
    sortBy,
    ...(start === undefined ? {} : { start }),
    ...(stop === undefined ? {} : { stop }),
    ...(keywords === '' ? {} : { filterBy: rcText(rc, 'filterby') }),
    // A blank direction leaves legacy's ORDER BY ascending.
    ...(javaTrim(direction) === '' ? {} : { sortDirection: direction }),
  };
}

/**
 * dataCollectionManager.getData: the form's packets in the date bounds, filtered by an unwildcarded `pollValue like
 * keywords` (optionally on field `filterBy`) and sorted by `Entered` or one listed field, else by entry date.
 */
export function getData(deps: ContentDeps, actor: Actor, rc: LegacyRc, locale = DEFAULT_LOCALE): Promise<FormResponsePacketRow[]> {
  const args = formResponsesArgs(rc, locale);
  return withTenant(deps.db, actor.tenantId, (tx) => deps.repository.forms.responses(tx, args));
}

/** contentManager.getDownloadselect over the form's responses. */
export async function getDownloadSelect(deps: ContentDeps, actor: Actor, contentId: string, siteId: string): Promise<DownloadSelectRow> {
  const [row] = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.downloadSelect(tx, { contentId, siteId }));
  return row ?? { firstentered: null, lastentered: null, countentered: 0 };
}

/** contentManager.getActiveContent: the form's active version as its contentBean, or the new bean legacy returns when none matches. */
export async function getActiveForm(deps: ContentDeps, actor: Actor, contentId: string, siteId: string): Promise<LegacyContentBean> {
  const now = deps.clock.now();
  const [row] = await withTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.readActive(tx, { contentId, siteId }));
  return row === undefined ? LegacyContentBean.notFound(actor, now, siteId) : LegacyContentBean.fromVersion(row, actor, now);
}

// cfqueryparam cf_sql_numeric binds with its default scale 0.
/** The integer a cf_sql_numeric parameter binds for `value`, rounded half up. */
function numericParam(value: unknown): number {
  const n = cfToNumber(value);
  return Math.sign(n) * Math.floor(Math.abs(n) + 0.5);
}

/**
 * dataCollectionManager.setDisplay: the bean's display fields, sort and nextN on every version of the form (no
 * `active` filter, as legacy). Legacy then purges its content cache, which only the legacy runtime holds.
 */
export function setDisplay(deps: ContentDeps, actor: Actor, bean: LegacyContentBean, opts: FormWriteOptions = {}): Promise<ContentRow[]> {
  const patch = {
    responsedisplayfields: bean.text('responsedisplayfields'),
    sortby: bean.text('sortby'),
    sortdirection: bean.text('sortdirection'),
    nextn: numericParam(bean.get('nextn')),
  };
  const filter = { siteId: bean.text('siteid'), contentId: bean.contentId(), types: ['Form'] };
  const write = writeContextFor(actor, opts.requestId);
  return withGatedTenant(deps.db, actor.tenantId, (tx) => deps.repository.content.updateVersions(tx, filter, patch, write));
}

/** The data manager view datamanager.cfm includes. */
export type DataManagerView = 'responses' | 'edit' | 'display' | 'orm' | 'abort';

/** A CFML struct member ignoring key case; undefined when absent or JSON null. */
function structMember(value: unknown, key: string): unknown {
  if (!isStruct(value)) return undefined;
  const found = Object.keys(value).find((name) => equalsIgnoreCase(name, key));
  return found === undefined || value[found] === null ? undefined : value[found];
}

function isStruct(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** datamanager.cfm:112-124: an ORM-entity form body, a classic one, or JSON whose members legacy fails reading (cfdump, cfabort). */
function formBodyKind(body: string): 'classic' | 'orm' | 'abort' {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'classic';
  }
  const form = structMember(parsed, 'form');
  if (!isStruct(form)) return 'abort';
  if (structMember(form, 'muraormentities') === undefined) return 'classic';
  const attributes = structMember(form, 'formattributes');
  if (!isStruct(attributes)) return 'abort';
  const flag = structMember(attributes, 'muraormentities');
  if (flag === undefined) return 'classic';
  if (typeof flag === 'object') return 'abort';
  return cfIsBoolean(flag) && cfToBoolean(flag) ? 'orm' : 'classic';
}

/** The view datamanager.cfm includes for the form `body` and `rc.action`. */
export function dataManagerView(body: string, action: string): DataManagerView {
  const kind = formBodyKind(body);
  if (kind !== 'classic') return kind;
  if (cfEq(action, 'edit')) return 'edit';
  if (cfEq(action, 'display')) return 'display';
  return 'responses';
}

/** What dsp_response.cfm reads before rendering. */
export interface ResponseListing {
  /** `rc` as the view leaves it: `date1`/`date2` defaulted to the first and last entry dates, `fieldnames` its column list. */
  rc: LegacyRc;
  /** The `getData` rows when `rc.minute1` is defined, else null. */
  rows: FormResponsePacketRow[] | null;
}

/**
 * dsp_response.cfm:1-19, 85-88: non-date `date1`/`date2` fall back to `rsDataInfo`, the columns are the summary display
 * fields (`listLast(responseDisplayFields, '~')`) else the current field list, and with `rc.minute1` the rows are read.
 */
export async function responseList(
  deps: ContentDeps,
  actor: Actor,
  rc: LegacyRc,
  bean: LegacyContentBean,
  rsDataInfo: DownloadSelectRow,
  locale = DEFAULT_LOCALE,
): Promise<ResponseListing> {
  let view: Record<string, unknown> = { ...rc };
  for (const [key, fallback] of [['date1', rsDataInfo.firstentered], ['date2', rsDataInfo.lastentered]] as const) {
    const value = rcGet(view, key);
    if (!(value instanceof Date) && !cfLsIsDate(value === undefined ? '' : simpleText(value), locale)) view = withValue(view, key, fallback ?? '');
  }
  const display = bean.text('responsedisplayfields');
  const fieldnames =
    display.length > 0 && display !== '~'
      ? (cfListToArray(display, '~').at(-1) ?? '').replaceAll('^', ',')
      : await getCurrentFieldList(deps, actor, rcTextOr(view, 'contentid', ''));
  view = withValue(view, 'fieldnames', fieldnames);
  const rows = rcHas(view, 'minute1') ? await getData(deps, actor, view, locale) : null;
  return { rc: view, rows };
}

/** Settings of a data manager request. */
export interface DataManagerOptions extends FormWriteOptions {
  /** `rc.$.validateCSRFTokens(context)`: validates and consumes the request's token; called only where legacy calls it. */
  validateCsrfTokens(context: string): Promise<boolean>;
  /** Posted file parts of an `Update`. */
  files?: readonly UploadedFile[];
  /** Session locale of the LS date functions. */
  locale?: string;
}

/** What a data manager request wrote, and what its view renders from. */
export interface DataManagerResult {
  /** `rc` after datamanager.cfm's cfparams and action (`action` is '' after `setDisplay`). */
  rc: LegacyRc;
  /** The form's contentBean, with any `setDisplay` values. */
  bean: LegacyContentBean;
  outcome: 'updated' | 'deleted' | 'display-set' | 'none';
  view: DataManagerView;
  /** `getDownloadselect`, read after the action. */
  rsDataInfo: DownloadSelectRow;
  /** Responses dsp_response.cfm's filtered delete removed; null when it did not run. */
  filteredDeletions: number | null;
}

/**
 * carch.datamanager's writes (datamanager.cfm:76-106, dsp_response.cfm:162-167): `Update`/`Delete` of `rc.responseid`
 * with valid tokens, `setDisplay`, then the response view's filtered delete with `rc.minute1` and a true `rc.delete`.
 * @param rc Request values carrying carch.before's defaults.
 */
export async function dataManagerAction(deps: ContentDeps, actor: Actor, rc: LegacyRc, opts: DataManagerOptions): Promise<DataManagerResult> {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const siteId = rcText(rc, 'siteid');
  const bean = await getActiveForm(deps, actor, rcTextOr(rc, 'contentid', ''), siteId);
  let view = withDefaults(rc, { keywords: '', filterBy: '', sortBy: bean.text('sortby'), sortDirection: bean.text('sortdirection') });
  const action = rcTextOr(view, 'action', '');
  let outcome: DataManagerResult['outcome'] = 'none';

  if (rcHas(view, 'responseid') && cfEq(action, 'Update') && (await opts.validateCsrfTokens(rcText(view, 'responseid')))) {
    await updateResponse(deps, actor, view, opts.files ?? [], opts);
    outcome = 'updated';
  } else if (rcHas(view, 'responseid') && cfEq(action, 'Delete') && (await opts.validateCsrfTokens(rcText(view, 'responseid')))) {
    await deleteResponse(deps, actor, rcText(view, 'responseid'), true, opts);
    outcome = 'deleted';
  } else if (cfEq(action, 'setDisplay')) {
    bean.setValue('responseDisplayFields', `${rcText(view, 'detailList2')}~${rcText(view, 'summaryList2')}`);
    bean.setValue('nextN', rcValue(view, 'nextn'));
    bean.setValue('sortBy', rcValue(view, 'sortBy'));
    bean.setValue('sortDirection', rcValue(view, 'sortDirection'));
    await setDisplay(deps, actor, bean, opts);
    view = withValue(view, 'action', '');
    outcome = 'display-set';
  }

  const rsDataInfo = await getDownloadSelect(deps, actor, rcTextOr(view, 'contentid', ''), siteId);
  const kind = dataManagerView(bean.text('body'), rcTextOr(view, 'action', ''));
  let filteredDeletions: number | null = null;
  if (kind === 'responses' && rcHas(view, 'minute1')) {
    const listing = await responseList(deps, actor, view, bean, rsDataInfo, locale);
    const flag = rcGet(view, 'delete');
    if (listing.rows !== null && listing.rows.length > 0 && cfIsBoolean(flag) && cfToBoolean(flag)) {
      const rows = listing.rows;
      const write = writeContextFor(actor, opts.requestId);
      await withGatedTenant(deps.db, actor.tenantId, async (tx) => {
        for (const row of rows) await deleteResponseInTx(deps, tx, row.responseid, true, write);
      });
      filteredDeletions = rows.length;
    }
  }
  return { rc: view, bean, outcome, view: kind, rsDataInfo, filteredDeletions };
}

/** The parts of an attachment link: the site's `getScheme()` and `getDomain()`, configBean `getServerPort()` and `getContext()`. */
export interface AttachmentLinkParts {
  scheme: string;
  domain: string;
  serverPort: string;
  context: string;
}

/** The `/_api/render/file/` URL the data manager writes for an attachment file id. */
export function attachmentRenderUrl(link: AttachmentLinkParts, fileId: string): string {
  return `${link.scheme}://${link.domain}${link.serverPort}${link.context}/index.cfm/_api/render/file/?fileID=${fileId}`;
}

/** Settings of carch.downloaddata. */
export interface DownloadDataOptions {
  link: AttachmentLinkParts;
  /** Session locale of the LS date functions and the file name's date. */
  locale?: string;
}

/** The CSV carch.downloaddata writes; the route answers it with legacy's download headers. */
export interface DownloadDataResult {
  /** `<title, spaces as ->_<mmddyy>.csv`, the `Content-Disposition` file name. */
  fileName: string;
  /** The header row's field columns, after `DATE/TIME ENTERED`. */
  columns: string[];
  /** Each data row's cells as written: the entry time, then one cell per listed field. */
  rows: string[][];
  /** The CSV body: every cell followed by `,`, every row by CRLF. */
  body: string;
}

/** downloaddata.cfm's `fixDelim`: quotes doubled, CRLF as a space, wrapped in quotes. */
function fixDelim(value: string): string {
  return `"${value.replaceAll('"', '""').replaceAll(CRLF, ' ')}"`;
}

/** A packet value in string context; undefined for values ACF cannot convert (Masa's packets hold strings only). */
function packetText(value: WddxValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof WddxNumber) return cfNumberString(Number(value.text));
  return undefined;
}

/** One data cell of downloaddata.cfm; its cftry writes nothing for a missing key, a packet that is no struct or a complex value. */
function downloadCell(info: WddxValue, field: string, link: AttachmentLinkParts): string {
  const isPacketStruct = typeof info === 'object' && info !== null && 'kind' in info && info.kind === 'struct';
  if (!isPacketStruct) return '';
  const value = wddxStructGet(info, field);
  if (isAttachmentField(field) && typeof value === 'string' && isCfUuid(value)) return attachmentRenderUrl(link, value);
  const text = packetText(value);
  return text === undefined ? '' : fixDelim(text);
}

/**
 * carch.downloaddata (carch.cfc:480-485, downloaddata.cfm): the current field list's `getData` rows as CSV, each row's
 * cells over the field list with `rc.columns` `fixed`, else over the row's stored `fieldlist`.
 * @throws Error('Invalid WDDX packet') for a packet legacy cannot read, which fails the download as legacy fails it.
 */
export async function downloadData(deps: ContentDeps, actor: Actor, rc: LegacyRc, opts: DownloadDataOptions): Promise<DownloadDataResult> {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const contentId = rcTextOr(rc, 'contentid', '');
  const bean = await getActiveForm(deps, actor, contentId, rcText(rc, 'siteid'));
  const fieldnames = await getCurrentFieldList(deps, actor, contentId);
  const view = withValue(withDefaults(rc, { columns: '' }), 'fieldnames', fieldnames);
  const packets = await getData(deps, actor, view, locale);
  const columns = cfListToArray(fieldnames);
  const fixed = cfEq(rcText(view, 'columns'), 'fixed');
  const rows = packets.map((packet) => {
    const info = wddx2cfml(packet.data ?? '');
    const fields = fixed ? columns : cfListToArray(packet.fieldlist ?? '');
    return [packet.entered === null ? '' : cfTimestampText(packet.entered), ...fields.map((field) => downloadCell(info, field, opts.link))];
  });
  const line = (cells: readonly string[]): string => `${cells.map((cell) => `${cell},`).join('')}${CRLF}`;
  const body = line(['DATE/TIME ENTERED', ...columns]) + rows.map(line).join('');
  const fileName = `${bean.text('title').replaceAll(' ', '-')}_${cfLsDateFormat(deps.clock.now(), 'mmddyy', locale)}.csv`;
  return { fileName, columns, rows, body };
}

// ---- cform dialogs (cform.cfc:161-210, formBuilderManager.cfc:91-368) ----

/** cform.getForm's `getFormBean` arguments: `rc.formID`, a new CF UUID when absent. */
export function cformFormBean(rc: LegacyRc): FormBeanInput & { formId: string } {
  return { formId: rcHas(rc, 'formID') ? rcText(rc, 'formID') : cfUuid() };
}

/** cform.getField's `getFieldBean` arguments: `fieldID` new and `fieldType` `field-textfield` when absent; a missing `formID` stays missing, as legacy fails on it. */
export function cformFieldBean(rc: LegacyRc): FieldBeanInput & { fieldId: string; fieldType: string } {
  return {
    formId: rcHas(rc, 'formID') ? rcText(rc, 'formID') : undefined,
    fieldId: rcHas(rc, 'fieldID') ? rcText(rc, 'fieldID') : cfUuid(),
    fieldType: rcHas(rc, 'fieldType') ? rcText(rc, 'fieldType') : 'field-textfield',
  };
}

/** cform.getFieldType's `getFieldTypeBean` arguments: `fieldTypeID` new and `fieldType` `field-textfield` when absent. */
export function cformFieldTypeBean(rc: LegacyRc): FieldTypeBeanInput & { fieldTypeId: string; fieldType: string } {
  return {
    fieldTypeId: rcHas(rc, 'fieldTypeID') ? rcText(rc, 'fieldTypeID') : cfUuid(),
    fieldType: rcHas(rc, 'fieldType') ? rcText(rc, 'fieldType') : 'field-textfield',
  };
}

/** cform.getDataset's `getDatasetBean` arguments: `datasetID` new when absent or empty; a missing `fieldID` stays missing, as legacy fails on it. */
export function cformDatasetBean(rc: LegacyRc): DatasetBeanInput & { datasetId: string } {
  const datasetId = rcHas(rc, 'datasetID') ? rcText(rc, 'datasetID') : '';
  return {
    datasetId: datasetId === '' ? cfUuid() : datasetId,
    fieldId: rcHas(rc, 'fieldID') ? rcText(rc, 'fieldID') : undefined,
  };
}

/**
 * formBuilderManager.getForms: the site's active forms (`contentid`, `title`) by title, without `excludeFormId` when
 * given; type and id compare as SQL Server's case-insensitive collation compares them.
 */
export function getForms(deps: ContentDeps, actor: Actor, siteId: string, excludeFormId = ''): Promise<NestedFormRow[]> {
  return withTenant(deps.db, actor.tenantId, (tx) => {
    const values: unknown[] = [siteId];
    let sql =
      `SELECT contentid, title FROM ${qualified(tx.schema, CONTENT.table)}` +
      " WHERE lower(rtrim(type)) = 'form' AND siteid = $1 AND active = 1";
    if (excludeFormId !== '') {
      values.push(excludeFormId);
      sql += ' AND lower(rtrim(contentid)) <> lower(rtrim($2::text))';
    }
    sql += ' ORDER BY lower(title) ASC NULLS FIRST, tcontent_id';
    return deps.repository.platform.read(tx, CONTENT.unit, async () => (await tx.query<NestedFormRow>(sql, values)).rows);
  });
}
