// Masa class-extension validation and persistence of user and address extended attributes (extendManager.cfc,
// extendData.cfc) over people's definition units and `people.extend_data_user_activity`, Masa's
// tclassextenddatauseractivity. Definitions are read-only here; only migration apply writes them.
import type { WriteContext } from '@opt2/platform/migration-kit';
import type { TenantTx } from '@opt2/platform/tenancy';
import {
  LegacyServiceUnavailableError,
  cfDateTimeFormat,
  cfIsDate,
  cfIsDateText,
  cfIsNumeric,
  cfLsIsDate,
  cfLsParseDateTime,
  cfNumberString,
  cfParseDateTimeText,
  cfTimestampParam,
  cfToNumber,
  isCfUuid,
  javaTrim,
  sqlServerDatetime,
} from '@opt2/platform/legacy-compat';
import type { ExtendDataReplacement, ExtendDataValues, PeopleRepository } from '../repo/repository.js';
import type { ExtendAttributeRow, ExtendDataRow, ExtendSetRow, ExtendSubtypeRow } from '../repo/tables.js';

/** The configBean settings the extended-data operations read. */
export interface ExtendConfig {
  strictExtendedData: boolean;
  saveEmptyExtendedValues: boolean;
  stricthtml: boolean;
  stricthtmlexclude: string;
}

/** configBean defaults (configBean.cfc:155, 221) and validateExtendedData's getValue defaults (extendManager.cfc:375-376). */
export const EXTEND_CONFIG_DEFAULTS: Readonly<ExtendConfig> = Object.freeze({
  strictExtendedData: true,
  saveEmptyExtendedValues: true,
  stricthtml: false,
  stricthtmlexclude: '',
});

/** English texts of the `params.error*` keys validateExtendedData formats (en.properties:829-831). */
export const EXTEND_MESSAGES = Object.freeze({
  errordate: '{1} must be a valid date.',
  erroremail: '{1} must be a valid email.',
  errornumeric: '{1} must be numeric.',
});

/** One `tclassextendattributes` row as the validate and save queries select it; NULL columns read as ''. */
export interface ExtendedAttribute {
  attributeId: number;
  name: string;
  validation: string;
  message: string;
  type: string;
  extendSetId: string;
  siteId: string;
}

/** Maps a stored attribute row to the query shape. */
export function toExtendedAttribute(row: ExtendAttributeRow): ExtendedAttribute {
  return {
    attributeId: row.attributeid,
    name: row.name ?? '',
    validation: row.validation ?? '',
    message: row.message ?? '',
    type: row.type ?? '',
    extendSetId: row.extendsetid ?? '',
    siteId: row.siteid ?? '',
  };
}

/** A File-attribute branch whose legacy closure writes strategies-content's `tfiles` and file store; it answers the legacy 503. */
export class UnsupportedBranchError extends LegacyServiceUnavailableError {
  override readonly name: string = 'UnsupportedBranchError';
  readonly branch = 'extended-file' as const;

  constructor(
    readonly attributeId: number,
    detail: string,
  ) {
    super(`Extended attribute ${attributeId} ${detail}`, 'auto', 'extended-file');
  }
}

/** A value of the getAllExtendSetData merge: date attributes parse to a Date, everything else is text. */
export type ExtendValue = string | Date;

/** The bean site, type and subtype whose definition defaults extendData.loadData unions in (extendData.cfc:305-334). */
export interface ExtendDataScope {
  siteId: string;
  type: string;
  subtype: string;
}

/** extendData.getAllExtendSetData of one base id. */
export interface ExtendSetData {
  /** Attribute name to value, keys matched case-insensitively with the first spelling kept and the last value, as a CFML struct. */
  data: Record<string, ExtendValue>;
  /** One name and value per data-query row, in row order, for consumers that replay the struct inserts themselves. */
  entries: Array<readonly [name: string, value: ExtendValue]>;
  /** valueList of the rows' set ids, duplicates and empty items kept. */
  extendSetId: string;
}

/** Settings of one extended-data save. */
export interface ExtendSaveContext {
  /** `data.siteID`: the attribute site filter and the stored `siteid`. */
  siteId: string;
  config: ExtendConfig;
  write: WriteContext;
  /** The request locale setLocale received; ACF's default 'English (US)' when omitted. */
  locale?: string;
}

/** The column getCastString names for an attribute. */
export type CastColumn = 'numericvalue' | 'datetimevalue' | 'stringvalue';

const DEFAULT_LOCALE = 'English (US)';
const STRINGVALUE_WIDTH = 250;
const REMOTE_ID_WIDTH = 35;
const DATE_VALIDATIONS: ReadonlySet<string> = new Set(['date', 'datetime']);
// Legacy's class `[a-zA-Z_0-9-'\+~]` reads the '-' after the range 0-9 as a literal, written escaped here.
const EMAIL = /^[a-zA-Z_0-9\-'+~]+(\.[a-zA-Z_0-9\-'+~]+)*@([a-zA-Z_0-9-]+\.)+[a-zA-Z]{2,7}$/i;
const HTML_TAG = /<\/?[^>]*>/i;
const DYNAMIC_CONTENT = /(\[sava\]|\[mura\]|\[m\]).+?(\[\/sava\]|\[\/mura\]|\[\/m\])/i;
const DECIMAL_TEXT = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
// Bean types whose definition union leaves out the 'Base' subtype (extendData.cfc:316).
const NON_BASE_TYPES = ['1', '2', 'user', 'group', 'address', 'site', 'component', 'form'];

/** CFML list items: comma-split with empty elements dropped and no trimming. */
function cfList(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** SQL Server `=` on text under its case-insensitive collation: trailing spaces ignored, NULL matches nothing. */
function sqlEq(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** A simple value as CFML text, dates as `{ts 'yyyy-MM-dd HH:mm:ss'}`; throws where ACF refuses a complex value. */
function cfText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return cfNumberString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Date) return `{ts '${cfDateTimeFormat(value, 'yyyy-mm-dd HH:nn:ss')}'}`;
  throw new TypeError('Complex object types cannot be converted to simple values.');
}

/** `data[key]` of a struct keyed by lower-cased names, as `normaliseParams` builds it; undefined when absent or null. */
function lookup(input: ReadonlyMap<string, unknown>, key: string): unknown {
  const value = input.get(key.toLowerCase());
  return value === null ? undefined : value;
}

/** CFML struct assignment: an existing key in another casing keeps its spelling and takes the value. */
function setCi<V>(target: Record<string, V>, spellings: Map<string, string>, key: string, value: V): void {
  const lower = key.toLowerCase();
  const spelling = spellings.get(lower) ?? key;
  spellings.set(lower, spelling);
  // Defined, not assigned, so an attribute named `__proto__` stays a data key.
  Object.defineProperty(target, spelling, { value, writable: true, enumerable: true, configurable: true });
}

function isFileAttribute(attribute: Pick<ExtendedAttribute, 'type'>): boolean {
  return sqlEq(attribute.type, 'File');
}

function inSets(attribute: Pick<ExtendedAttribute, 'extendSetId'>, setIds: readonly string[]): boolean {
  return setIds.some((id) => sqlEq(attribute.extendSetId, id));
}

/** The `extendsetid` items of the input; none when the key is absent or empty. */
function submittedSetIds(input: ReadonlyMap<string, unknown>): string[] {
  const setIds = lookup(input, 'extendsetid');
  return setIds === undefined ? [] : cfList(cfText(setIds));
}

/** The value validate and save read: a non-empty `ext<attributeID>`, else a non-empty `<name>`, else ''; undefined when neither key exists. */
function postedValue(attribute: ExtendedAttribute, input: ReadonlyMap<string, unknown>): unknown {
  const byId = lookup(input, `ext${attribute.attributeId}`);
  const byName = lookup(input, attribute.name);
  if (byId === undefined && byName === undefined) return undefined;
  if (byId !== undefined && cfText(byId) !== '') return byId;
  if (byName !== undefined && cfText(byName) !== '') return byName;
  return '';
}

/** `lsIsDate(value) or isDate(value)` in the request locale. */
function isDateValue(value: unknown, locale: string): boolean {
  if (cfIsDate(value)) return true;
  const text = cfText(value);
  return cfLsIsDate(text, locale) || cfIsDateText(text);
}

/** resourceBundle.messageFormat with one argument, which listToArray splits on commas: `{1}` is its first non-empty item. */
function messageFormat(pattern: string, argument: string): string {
  const args = ['', ...cfList(argument)];
  return pattern.replace(/\{(\d+)\}/g, (token, index: string) => args[Number(index)] ?? token);
}

/** saveExtendedData's coercion of a found value (extendManager.cfc:507-523): date text parsed, non-numeric Numeric values emptied. */
function savedValue(value: unknown, validation: string, locale: string): unknown {
  if (cfText(value) === '') return value;
  if (DATE_VALIDATIONS.has(validation)) {
    if (cfIsDate(value)) return value;
    const text = cfText(value);
    if (cfLsIsDate(text, locale)) {
      try {
        return cfLsParseDateTime(text, locale);
      } catch {
        return cfParseDateTimeText(text);
      }
    }
    // Other text stays text, which the cf_sql_timestamp binding of extendValues refuses as legacy's does.
    return cfIsDateText(text) ? cfParseDateTimeText(text) : value;
  }
  return validation === 'numeric' && !cfIsNumeric(value) ? '' : value;
}

/** A numeric value as `cf_sql_numeric` without a scale binds it: rounded half up to an integer, decimal text exactly. */
function numericParam(value: unknown): number {
  const number = cfToNumber(value);
  const parts = typeof value === 'string' ? DECIMAL_TEXT.exec(javaTrim(value)) : null;
  if (parts === null) return Math.sign(number) * Math.round(Math.abs(number)) || 0;
  const [, sign, whole = '', fraction = '', exponent = '0'] = parts;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  const integer = point <= 0 ? 0n : BigInt(digits.slice(0, point).padEnd(point, '0') || '0');
  const roundsUp = point >= 0 && (digits[point] ?? '0') >= '5';
  const magnitude = Number(integer + (roundsUp ? 1n : 0n));
  return sign === '-' ? -magnitude || 0 : magnitude;
}

/** The value columns saveExtendedData inserts (extendManager.cfc:527-556); NULL value columns for an empty value. */
function extendValues(value: unknown, validation: string, siteId: string, remoteId: string): ExtendDataValues {
  const text = cfText(value);
  const common = { siteid: siteId, stringvalue: text.slice(0, STRINGVALUE_WIDTH), remoteid: remoteId };
  if (text === '') return { ...common, attributevalue: null, datetimevalue: null, numericvalue: null };
  return {
    ...common,
    attributevalue: text,
    datetimevalue: DATE_VALIDATIONS.has(validation) ? sqlServerDatetime(cfTimestampParam(value)) : null,
    numericvalue: validation === 'numeric' ? numericParam(value) : null,
  };
}

/**
 * The file id the File-attribute loop of saveExtendedData inserts (extendManager.cfc:562-640), or null when it inserts
 * none; throws UnsupportedBranchError where that loop reaches fileManager or keeps rows the repository would replace.
 */
function fileAttributeId(attribute: ExtendedAttribute, input: ReadonlyMap<string, unknown>, stored: readonly ExtendDataRow[]): string | null {
  const byId = lookup(input, `ext${attribute.attributeId}`);
  const byName = lookup(input, attribute.name);
  const idPosted = byId !== undefined && cfText(byId) !== '';
  const namePosted = byName !== undefined && cfText(byName) !== '';
  const deleteKey = lookup(input, `extDelete${attribute.attributeId}`) !== undefined || lookup(input, `extDelete${attribute.name}`) !== undefined;
  const rows = stored.filter((row) => row.attributeid === attribute.attributeId);
  if ((idPosted || namePosted || deleteKey) && rows.some((row) => (row.attributevalue ?? '') !== '')) {
    throw new UnsupportedBranchError(attribute.attributeId, 'replaces a stored file, which fileManager.deleteIfNotUsed removes from tfiles');
  }
  // CFML `A or B and not C` groups as `A or (B and not C)`, so ext<id> saves even beside a delete key.
  if (!(idPosted || (namePosted && !deleteKey))) return null;
  const value = cfText(idPosted ? byId : byName);
  if (!isCfUuid(value)) {
    throw new UnsupportedBranchError(attribute.attributeId, 'uploads a file through fileManager.process and fileManager.create');
  }
  // Legacy inserts beside stored empty rows without deleting them; replaceExtendData always replaces them.
  if (rows.length > 0) {
    throw new UnsupportedBranchError(attribute.attributeId, 'adds a file id beside stored rows legacy keeps');
  }
  return value;
}

/** contentRenderer.setDynamicContent of an attribute default; Mura tags are CFML only the legacy renderer evaluates. */
function dynamicDefault(defaultValue: string | null): string {
  const value = defaultValue ?? '';
  if (DYNAMIC_CONTENT.test(value)) {
    throw new LegacyServiceUnavailableError('An extended attribute default holds Mura tags only the legacy renderer evaluates', 'auto', 'extend-dynamic-default');
  }
  return value;
}

/** A stored value as convertDataToStruct reads it (extendData.cfc:413-429): date attributes as their timestamp or parsed text. */
function storedValue(row: ExtendDataRow, attribute: ExtendAttributeRow): ExtendValue {
  const text = row.attributevalue ?? '';
  if (!DATE_VALIDATIONS.has((attribute.validation ?? '').toLowerCase()) || (text === '' && row.datetimevalue === null)) return text;
  if (row.datetimevalue !== null) return row.datetimevalue;
  try {
    return cfParseDateTimeText(text);
  } catch {
    return text;
  }
}

/** NULL sorts first, as in SQL Server. */
function compareOrder(a: number | null, b: number | null): number {
  return (a ?? Number.NEGATIVE_INFINITY) - (b ?? Number.NEGATIVE_INFINITY) || 0;
}

/**
 * The non-NULL-typed attributes of the `extendsetid` list, by attribute id: every site's for validation
 * (extendManager.cfc:381-388), only `siteId`'s with `forSave` (extendManager.cfc:487-494).
 */
export async function loadSubmittedAttributes(
  repo: PeopleRepository,
  tx: TenantTx,
  extendSetIds: string,
  siteId: string,
  opts: { forSave: boolean },
): Promise<ExtendedAttribute[]> {
  const setIds = cfList(extendSetIds);
  if (setIds.length === 0) return [];
  // Read unfiltered and matched here: SQL Server compares the inlined ids and the site case-insensitively.
  const rows = await repo.listExtendAttributes(tx, {});
  return rows
    .filter((row) => row.type !== null && setIds.some((id) => sqlEq(row.extendsetid, id)) && (!opts.forSave || sqlEq(row.siteid, siteId)))
    .sort((a, b) => a.attributeid - b.attributeid)
    .map(toExtendedAttribute);
}

/**
 * getAllExtendSetData of `baseId` (extendData.cfc:218-440): its stored values joined to their attributes, plus, when
 * `scope` names a site, type and subtype, the defaults of that subtype's unstored attributes.
 */
export async function extendSetData(
  repo: PeopleRepository,
  tx: TenantTx,
  baseId: string,
  scope?: ExtendDataScope,
  config: Pick<ExtendConfig, 'saveEmptyExtendedValues'> = EXTEND_CONFIG_DEFAULTS,
): Promise<ExtendSetData> {
  const siteId = scope?.siteId ?? '';
  const stored = await repo.listExtendData(tx, [baseId]);
  const attributes = await repo.listExtendAttributes(tx, {});
  const byId = new Map(attributes.map((attribute) => [attribute.attributeid, attribute]));
  const rows: { name: string; extendSetId: string; value: ExtendValue }[] = [];
  const storedIds = new Set<number>();
  for (const row of stored) {
    const attribute = byId.get(row.attributeid);
    if (attribute === undefined || (siteId !== '' && !sqlEq(attribute.siteid, siteId))) continue;
    if (!config.saveEmptyExtendedValues && row.attributevalue === null) continue;
    storedIds.add(row.attributeid);
    rows.push({ name: attribute.name ?? '', extendSetId: attribute.extendsetid ?? '', value: storedValue(row, attribute) });
  }
  if (scope !== undefined && siteId !== '' && scope.type !== '' && scope.subtype !== '') {
    for (const { set, attribute } of await definitionRows(repo, tx, scope, attributes)) {
      if (storedIds.has(attribute.attributeid)) continue;
      rows.push({ name: attribute.name ?? '', extendSetId: set.extendsetid, value: dynamicDefault(attribute.defaultvalue) });
    }
  }
  const data: Record<string, ExtendValue> = Object.create(null) as Record<string, ExtendValue>;
  const spellings = new Map<string, string>();
  const entries: Array<readonly [string, ExtendValue]> = [];
  for (const row of rows) {
    entries.push([row.name, row.value]);
    setCi(data, spellings, row.name, row.value);
  }
  return { data, entries, extendSetId: rows.map((row) => row.extendSetId).join(',') };
}

/**
 * The rsDefinitions rows loadData unions in, in its `siteID, type, subtype, set orderno, attribute orderno` order; the
 * query-of-queries filters compare case-sensitively (extendData.cfc:306-331).
 */
async function definitionRows(
  repo: PeopleRepository,
  tx: TenantTx,
  scope: ExtendDataScope,
  attributes: readonly ExtendAttributeRow[],
): Promise<{ subtype: ExtendSubtypeRow; set: ExtendSetRow; attribute: ExtendAttributeRow }[]> {
  const withBase = !NON_BASE_TYPES.includes(scope.type.toLowerCase());
  const ownSubtype = scope.subtype.toLowerCase() !== 'default';
  // listExtendSubtypes matches siteid exactly, as the query of queries does.
  const subtypes = (await repo.listExtendSubtypes(tx, { siteId: scope.siteId })).filter(
    (row) =>
      (row.type === scope.type || (withBase && row.type === 'Base')) && ((ownSubtype && row.subtype === scope.subtype) || row.subtype === 'Default'),
  );
  const sets = await repo.listExtendSets(tx, subtypes.map((row) => row.subtypeid));
  const joined: { rank: number; subtype: ExtendSubtypeRow; set: ExtendSetRow; attribute: ExtendAttributeRow }[] = [];
  // listExtendSubtypes already returns type then subtype order, so a subtype's position stands for those two keys.
  for (const [rank, subtype] of subtypes.entries()) {
    for (const set of sets.filter((row) => row.subtypeid === subtype.subtypeid)) {
      for (const attribute of attributes.filter((row) => sqlEq(row.extendsetid, set.extendsetid))) joined.push({ rank, subtype, set, attribute });
    }
  }
  return joined.sort(
    (a, b) => a.rank - b.rank || compareOrder(a.set.orderno, b.set.orderno) || compareOrder(a.attribute.orderno, b.attribute.orderno),
  );
}

/** getCastString (extendManager.cfc:1147-1184): the typed column of an attribute when `strictExtendedData`, else `stringvalue`. */
export function castColumnFor(attribute: Pick<ExtendedAttribute, 'validation'>, config: Pick<ExtendConfig, 'strictExtendedData'>): CastColumn {
  if (!config.strictExtendedData) return 'stringvalue';
  switch (attribute.validation.toLowerCase()) {
    case 'numeric':
      return 'numericvalue';
    case 'date':
    case 'datetime':
    case 'timestamp':
      return 'datetimevalue';
    default:
      return 'stringvalue';
  }
}

/**
 * validateExtendedData (extendManager.cfc:362-437) for the non-File attributes of the input's `extendsetid`; `input`
 * is keyed by lower-cased names. Only non-empty values are checked; error keys follow CFML struct casing.
 */
export function validateExtendedData(
  attributes: readonly ExtendedAttribute[],
  input: ReadonlyMap<string, unknown>,
  config: Pick<ExtendConfig, 'stricthtml' | 'stricthtmlexclude'>,
  locale: string = DEFAULT_LOCALE,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const spellings = new Map<string, string>();
  const setIds = submittedSetIds(input);
  const excluded = cfList(config.stricthtmlexclude);
  for (const attribute of attributes) {
    if (isFileAttribute(attribute) || !inSets(attribute, setIds)) continue;
    const value = postedValue(attribute, input);
    if (value === undefined || cfText(value) === '') continue;
    const validation = attribute.validation.toLowerCase();
    let failed: keyof typeof EXTEND_MESSAGES | undefined;
    if (DATE_VALIDATIONS.has(validation)) {
      if (!isDateValue(value, locale)) failed = 'errordate';
    } else if (validation === 'numeric') {
      if (!cfIsNumeric(value)) failed = 'errornumeric';
    } else if (validation === 'email') {
      if (!EMAIL.test(javaTrim(cfText(value)))) failed = 'erroremail';
    } else if (config.stricthtml && !sqlEq(attribute.type, 'HTMLEditor') && !excluded.includes(attribute.name) && HTML_TAG.test(cfText(value))) {
      setCi(errors, spellings, `${attribute.name}encoding`, `The field '${attribute.name}' contains invalid characters.`);
    }
    if (failed !== undefined) {
      const message = attribute.message !== '' ? attribute.message : messageFormat(EXTEND_MESSAGES[failed], attribute.name.toUpperCase());
      setCi(errors, spellings, attribute.name, message);
    }
  }
  return errors;
}

/**
 * Throws UnsupportedBranchError, before any write, where saveExtendedData's File-attribute loop would reach
 * fileManager: a posted value or delete key replacing a stored file, or a posted value that is not an existing file id.
 * `stored` holds the base's stored rows; a posted CF UUID with none stored is saved as a plain row.
 */
export function assertNoFileAttributeWrites(
  attributes: readonly ExtendedAttribute[],
  input: ReadonlyMap<string, unknown>,
  stored: readonly ExtendDataRow[] = [],
): void {
  const setIds = submittedSetIds(input);
  for (const attribute of attributes) {
    if (isFileAttribute(attribute) && inSets(attribute, setIds)) fileAttributeId(attribute, input, stored);
  }
}

/**
 * Whether a caller saves extended data: user saves need a non-empty `extendsetid` (userManager.cfc:490-492, 645-647),
 * address saves only the key (userManager.cfc:888-891, 929-932).
 */
export function extendedDataRequested(input: ReadonlyMap<string, unknown>, opts: { requireNonEmptySetIds: boolean }): boolean {
  const setIds = lookup(input, 'extendsetid');
  if (setIds === undefined) return false;
  return !opts.requireNonEmptySetIds || cfText(setIds) !== '';
}

/**
 * saveExtendedData(baseID, data, 'tclassextenddatauseractivity') (extendManager.cfc:439-640) in the caller's
 * transaction: per attribute found in `input`, its rows are deleted and the new row inserted through the repository.
 * File attributes refuse as assertNoFileAttributeWrites does, before any write. Returns the inserted rows.
 */
export async function saveExtendedData(
  repo: PeopleRepository,
  tx: TenantTx,
  baseId: string,
  input: ReadonlyMap<string, unknown>,
  ctx: ExtendSaveContext,
): Promise<ExtendDataRow[]> {
  const setIds = submittedSetIds(input);
  if (setIds.length === 0) return [];
  const locale = ctx.locale ?? DEFAULT_LOCALE;
  const attributes = await loadSubmittedAttributes(repo, tx, setIds.join(','), ctx.siteId, { forSave: true });
  const files = attributes.filter(isFileAttribute);
  const stored = files.length === 0 ? [] : await repo.listExtendData(tx, [baseId]);
  const fileIds = files.map((attribute) => ({ attribute, fileId: fileAttributeId(attribute, input, stored) }));
  const remote = lookup(input, 'remoteid');
  const remoteId = remote === undefined ? '' : cfText(remote).slice(0, REMOTE_ID_WIDTH);
  const entries: ExtendDataReplacement[] = [];
  for (const attribute of attributes) {
    if (isFileAttribute(attribute)) continue;
    const posted = postedValue(attribute, input);
    if (posted === undefined) continue;
    const validation = attribute.validation.toLowerCase();
    const value = savedValue(posted, validation, locale);
    const keep = cfText(value) !== '' || ctx.config.saveEmptyExtendedValues;
    entries.push({ attributeId: attribute.attributeId, row: keep ? extendValues(value, validation, ctx.siteId, remoteId) : null });
  }
  for (const { attribute, fileId } of fileIds) {
    if (fileId === null) continue;
    const row: ExtendDataValues = { siteid: ctx.siteId, attributevalue: fileId, stringvalue: fileId, remoteid: remoteId, datetimevalue: null, numericvalue: null };
    entries.push({ attributeId: attribute.attributeId, row });
  }
  return entries.length === 0 ? [] : repo.replaceExtendData(tx, baseId, entries, ctx.write);
}

/**
 * deleteExtendedData(baseID, 'tclassextenddatauseractivity') (extendManager.cfc:1060-1091, userDAO.cfc:389-393): every
 * stored value of the base; returns the number deleted. Throws UnsupportedBranchError, deleting nothing, while a File
 * attribute holds a file id, which legacy passes to fileManager.deleteIfNotUsed.
 */
export async function deleteExtendedData(
  repo: PeopleRepository,
  tx: TenantTx,
  baseId: string,
  ctx: Pick<ExtendSaveContext, 'write'>,
): Promise<number> {
  const valued = (await repo.listExtendData(tx, [baseId])).filter((row) => (row.attributevalue ?? '') !== '');
  if (valued.length > 0) {
    const attributeIds = [...new Set(valued.map((row) => row.attributeid))];
    const files = new Set(
      (await repo.listExtendAttributes(tx, { attributeIds })).filter((row) => sqlEq(row.type, 'File')).map((row) => row.attributeid),
    );
    const file = valued.find((row) => files.has(row.attributeid));
    if (file !== undefined) {
      throw new UnsupportedBranchError(file.attributeid, 'holds a stored file, which fileManager.deleteIfNotUsed removes from tfiles');
    }
  }
  return repo.deleteExtendDataForBase(tx, baseId, ctx.write);
}
