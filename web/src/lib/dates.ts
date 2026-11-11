// The admin session date key (session.dateKey, session.dateKeyFormat) and legacy date field values (server-only).
import { cfDateAdd, cfEq, cfListToArray, cfLsDateFormat, cfLsTimeFormat } from '@opt2/platform/legacy-compat';
import { raw, type SafeHtml } from './html';

/** Date validation key of a session locale, as resourceBundle utils.setJSDateKeys builds it. */
export interface DateKey {
  /** The locale with its first `_` replaced by `-` (dtLocale). */
  readonly locale: string;
  /** Date separator. */
  readonly dtCh: string;
  /** Comma list of the zero-based month, day and year positions. */
  readonly dtFormat: string;
  /** LSDateFormat mask of admin date fields (session.dateKeyFormat). */
  readonly dateKeyFormat: string;
  /** 2024-11-10 rendered with dateKeyFormat. */
  readonly dtExample: string;
  /** Inline script the admin layouts print as session.dateKey. */
  readonly script: SafeHtml;
  /** The same keys as object members joined by `,` and CRLF (settingsBean jsDateKeyObjInc). */
  readonly objInc: string;
}

interface LocaleKey {
  readonly dtCh: string;
  readonly dtFormat: string;
  readonly dateKeyFormat: string;
}

/** Map keyed by lower-cased name, read case-insensitively as CFML struct keys and ACF locale names are. */
function byLowerCaseName<V>(entries: ReadonlyArray<readonly [string, V]>): ReadonlyMap<string, V> {
  return new Map(entries.map(([name, value]) => [name.toLowerCase(), value]));
}

/** Fixed keys for locales whose short date format uses non-ASCII text. */
const LOCALE_LOOKUP = byLowerCaseName<LocaleKey>([
  ['zh-HK', { dtCh: '-', dtFormat: '1,0,2', dateKeyFormat: 'dd-mm-yyyy' }],
  ['zh-TW', { dtCh: '/', dtFormat: '2,0,1', dateKeyFormat: 'yyyy/mm/dd' }],
  ['ru', { dtCh: '.', dtFormat: '1,0,2', dateKeyFormat: 'dd.mm.yyyy' }],
  ['tr', { dtCh: '.', dtFormat: '1,0,2', dateKeyFormat: 'dd.mm.yyyy' }],
  ['uk', { dtCh: '/', dtFormat: '1,0,2', dateKeyFormat: 'dd/mm/yyyy' }],
]);

/** Java 17 DateFormat SHORT of 2024-11-10 and MEDIUM of 00:00:00 for the locales Masa ships bundles for. */
const JAVA_FORMATS = byLowerCaseName<readonly [shortDate: string, mediumMidnight: string]>([
  ['en_US', ['11/10/24', '12:00:00 AM']],
  ['en_GB', ['10/11/2024', '00:00:00']],
  ['de_DE', ['10.11.24', '00:00:00']],
  ['fr_FR', ['10/11/2024', '00:00:00']],
  ['es_ES', ['10/11/24', '0:00:00']],
  ['it_IT', ['10/11/24', '00:00:00']],
  ['nl_NL', ['10-11-2024', '00:00:00']],
  ['pl_PL', ['10.11.2024', '00:00:00']],
  ['pt_BR', ['10/11/2024', '00:00:00']],
  ['pt_PT', ['10/11/24', '00:00:00']],
  ['hu_HU', ['2024. 11. 10.', '0:00:00']],
  ['da_DK', ['10.11.2024', '00.00.00']],
  ['id_ID', ['10/11/24', '00.00.00']],
  ['fil_PH', ['11/10/24', '12:00:00 AM']],
  ['zh_CN', ['2024/11/10', '\u4e0a\u534812:00:00']],
  ['ru_RU', ['10.11.2024', '00:00:00']],
  ['tr_TR', ['10.11.2024', '00:00:00']],
]);

/** createDate(2024,11,10), the sample date of the key; never mutated. */
const KEY_DATE = new Date(2024, 10, 10);

const languageTag = (javaLocale: string): string => javaLocale.replaceAll('_', '-');

/** The locale's Java SHORT date of 2024-11-10, as LSDateFormat(createDate(2024,11,10),'short') prints it. */
export function shortDatePattern(javaLocale: string): string {
  const known = JAVA_FORMATS.get(javaLocale.toLowerCase());
  if (known) return known[0];
  return new Intl.DateTimeFormat(languageTag(javaLocale), { dateStyle: 'short', calendar: 'gregory' }).format(KEY_DATE);
}

/** Whether the locale's medium time of 00:00:00 contains AM (session.localeHasDayParts). */
export function localeHasDayParts(javaLocale: string): boolean {
  const medium =
    JAVA_FORMATS.get(javaLocale.toLowerCase())?.[1] ??
    new Intl.DateTimeFormat(languageTag(javaLocale), { timeStyle: 'medium' }).format(KEY_DATE);
  return /am/i.test(medium);
}

/** Separator, field positions and mask read from a short date of 2024-11-10. */
function keyFromShortDate(formatTest: string): LocaleKey {
  const dtCh = formatTest.includes('.') ? '.' : formatTest.includes('-') ? '-' : '/';
  const items = cfListToArray(formatTest, dtCh);
  const listFind = (value: string): number => items.indexOf(value) + 1;
  const year = listFind('2024') || listFind('24');
  const positions = [listFind('11') - 1, listFind('10') - 1, ...(year ? [year - 1] : [])];
  const fields = items.map((f) => (f === '2024' || f === '24' ? 'YYYY' : cfEq(f, '11') ? 'MM' : 'DD'));
  return { dtCh, dtFormat: positions.join(','), dateKeyFormat: fields.join(dtCh) };
}

function buildDateKey(javaLocale: string): DateKey {
  const locale = javaLocale.replace('_', '-');
  const { dtCh, dtFormat, dateKeyFormat } =
    LOCALE_LOOKUP.get(locale.toLowerCase()) ?? keyFromShortDate(shortDatePattern(javaLocale));
  const dtExample = cfLsDateFormat(KEY_DATE, dateKeyFormat);
  return Object.freeze({
    locale,
    dtCh,
    dtFormat,
    dateKeyFormat,
    dtExample,
    script: raw(
      `<script type="text/javascript">var dtExample="${dtExample}", dtCh="${dtCh}", dtFormat =[${dtFormat}], dtLocale="${locale}";</script>`,
    ),
    objInc: [`dtExample:"${dtExample}"`, `dtCh:"${dtCh}"`, `dtFormat:[${dtFormat}]`, `dtLocale:"${locale}"`].join(',\r\n'),
  });
}

const dateKeys = new Map<string, DateKey>();

/** session.dateKey and its parts for a Java locale name such as en_US; memoised per locale. */
export function dateKeyFor(javaLocale: string): DateKey {
  let key = dateKeys.get(javaLocale);
  if (!key) {
    key = buildDateKey(javaLocale);
    dateKeys.set(javaLocale, key);
  }
  return key;
}

const ODBC_TIMESTAMP = /^\{ts '([^']*)'\}$/;
const LEGACY_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/;

function daysInMonth(year: number, month: number): number {
  const last = new Date(0);
  last.setUTCFullYear(year, month, 0);
  return last.getUTCDate();
}

/** A valid Date as given, or a `{ts '…'}` / yyyy-mm-dd[THH:mm[:ss[.SSS]]] string in local time; null when empty or unparsable. */
export function parseLegacyDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined) return null;
  const text = value.trim();
  const m = LEGACY_DATE.exec(ODBC_TIMESTAMP.exec(text)?.[1] ?? text);
  if (!m) return null;
  const field = (i: number): number => Number(m[i] ?? '0');
  const [year, month, day, hour, minute, second] = [field(1), field(2), field(3), field(4), field(5), field(6)];
  const ms = Number((m[7] ?? '0').padEnd(3, '0'));
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, second, ms);
  if (year < 100) date.setFullYear(year, month - 1, day);
  return date;
}

/** The text of a cf_datetimeselector date input: '' when empty, unparsable or more than 50 years after `now`. */
export function formatDateField(
  value: Date | string | null | undefined,
  dateKeyFormat: string,
  now: Date = new Date(),
): string {
  const date = parseLegacyDate(value);
  if (!date || cfDateAdd('yyyy', 51, now).getTime() <= date.getTime()) return '';
  return cfLsDateFormat(date, dateKeyFormat);
}

/** `LSDateFormat(value, dateKeyFormat) LSTimeFormat(value, 'short')` under the session locale; ' ' when empty, RangeError when unparsable. */
export function formatDateTimeShort(
  value: Date | string | null | undefined,
  dateKeyFormat: string,
  javaLocale: string,
): string {
  if (value === null || value === undefined || value === '') return ' ';
  const date = parseLegacyDate(value);
  if (!date) throw new RangeError(`The value ${String(value)} cannot be converted to a date.`);
  return `${cfLsDateFormat(date, dateKeyFormat)} ${cfLsTimeFormat(date, 'short', javaLocale)}`;
}
