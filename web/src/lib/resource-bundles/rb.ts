import { generatedBundles } from '@/generated/resource-bundles/index';
import { cfListFirst, cfListGetAt, cfListLen, cfListToArray } from './properties';

/** One bundle file: its sanitised, lower-cased entries, or the Java parse failure legacy hits on load. */
export type BundleData = { readonly entries: ReadonlyArray<readonly [string, string]> } | { readonly error: string };

/** The `.properties` files of one legacy directory, keyed by exact file base name (`en`, `zh_CN`). */
export type BundleDir = { readonly dir: string; readonly files: Readonly<Record<string, BundleData>> };

/** Build-time bundle data: the admin directory plus the optional core-assets and global layers. */
export type GeneratedBundles = {
  readonly admin: BundleDir;
  readonly coreAssets: BundleDir | null;
  readonly global: BundleDir | null;
};

export type MessageArg = string | number | null;
export type MessageFormatArgs = string | number | ReadonlyArray<MessageArg>;

/** Label lookup bound to one session locale (`session.rb`). */
export type RbLookup = {
  readonly locale: string;
  /** Returns the legacy label, or `<key>_missing` when no bundle of the chain holds the key. */
  rbKey(key: string): string;
  /** `messageFormat` in this locale, after loading the locale's bundle as legacy does. */
  messageFormat(pattern: string, args: MessageFormatArgs): string;
};

/** Admin chain (`application.rbFactory`) and site chain (`settingsBean.getRBFactory`) lookups. */
export type ResourceBundles = {
  rbFor(locale: string): RbLookup;
  siteRbFor(locale: string): RbLookup;
  /** Admin-chain label; `<key>_missing` when absent. */
  rbKey(locale: string, key: string): string;
};

/** Thrown by every lookup that reaches a bundle file Java could not parse. */
export class ResourceBundleLoadError extends Error {
  readonly dir: string;
  readonly file: string;

  constructor(dir: string, file: string, message: string) {
    super(message);
    this.name = 'ResourceBundleLoadError';
    this.dir = dir;
    this.file = file;
  }
}

/** Thrown where Java `MessageFormat` or the CFML float cast of an argument fails. */
export class MessageFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageFormatError';
  }
}

const data: GeneratedBundles = generatedBundles;

const SENTINEL = 'muraKeyEmpty';
const EN_US = 'en_US';
const SERVER_LOCALE = 'English (US)';
const EMPTY_BUNDLE: ReadonlyMap<string, string> = new Map();

type Factory = {
  bundle(locale: string): ReadonlyMap<string, string>;
  getKeyValue(locale: string, key: string, useMuraDefault: boolean): string;
};

function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function upperAsciiCase(text: string): string {
  return text.replace(/[a-z]+/g, (run) => run.toUpperCase());
}

/** CFML string `==`: case-insensitive. */
function cfEqualsNoCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Java `String.trim`: strips code units up to U+0020 from both ends. */
function javaTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

function createFactory(dir: BundleDir, parent: Factory | null): Factory {
  const loaded = new Map<string, ReadonlyMap<string, string>>();

  const bundle = (locale: string): ReadonlyMap<string, string> => {
    const base = Object.hasOwn(dir.files, locale) ? locale : cfListFirst(locale, '_');
    const file = Object.hasOwn(dir.files, base) ? dir.files[base] : undefined;
    if (file === undefined) return EMPTY_BUNDLE;
    if ('error' in file) throw new ResourceBundleLoadError(dir.dir, `${base}.properties`, file.error);
    let entries = loaded.get(base);
    if (entries === undefined) {
      entries = new Map(file.entries);
      loaded.set(base, entries);
    }
    return entries;
  };

  const bundleValue = (locale: string, key: string): string => {
    const value = bundle(locale).get(foldAsciiCase(key));
    return value === undefined ? SENTINEL : value.replaceAll("''", "'");
  };

  const found = (value: string): boolean => !cfEqualsNoCase(value, SENTINEL);

  // resourceBundleFactory.cfc getKeyValue: the parent is asked again, with the original locale, after the en_US step.
  const getKeyValue = (locale: string, key: string, useMuraDefault: boolean): string => {
    let value = bundleValue(locale, key);
    if (found(value)) return value;
    if (parent !== null) {
      value = parent.getKeyValue(locale, key, true);
      if (found(value)) return value;
    }
    if (!cfEqualsNoCase(locale, EN_US)) {
      value = bundleValue(EN_US, key);
      if (found(value)) return value;
      if (parent !== null) {
        value = parent.getKeyValue(locale, key, true);
        if (found(value)) return value;
      }
    }
    return useMuraDefault ? SENTINEL : `${key}_missing`;
  };

  return { bundle, getKeyValue };
}

function createLookups(factory: Factory): (locale: string) => RbLookup {
  const lookups = new Map<string, RbLookup>();
  return (locale) => {
    let lookup = lookups.get(locale);
    if (lookup === undefined) {
      lookup = Object.freeze({
        locale,
        rbKey: (key: string) => factory.getKeyValue(locale, key, false),
        messageFormat: (pattern: string, args: MessageFormatArgs) => {
          // Legacy formats through getResourceBundle(locale), which fails first on a broken bundle file.
          factory.bundle(locale);
          return messageFormat(pattern, args, locale);
        },
      });
      lookups.set(locale, lookup);
    }
    return lookup;
  };
}

/** Builds the admin chain and the site chain (admin, then core assets, then global) over `bundles`. */
export function createResourceBundles(bundles: GeneratedBundles): ResourceBundles {
  const admin = createFactory(bundles.admin, null);
  const coreAssets = bundles.coreAssets === null ? admin : createFactory(bundles.coreAssets, admin);
  const site = bundles.global === null ? coreAssets : createFactory(bundles.global, coreAssets);
  const rbFor = createLookups(admin);
  return { rbFor, siteRbFor: createLookups(site), rbKey: (locale, key) => rbFor(locale).rbKey(key) };
}

type NumberStyle = 'number' | 'integer';
type PatternElement = { readonly offset: number; readonly argument: number; readonly style: NumberStyle | null };
type CompiledPattern = { readonly text: string; readonly elements: readonly PatternElement[] };
type Segments = [raw: string, index: string, type: string, modifier: string];
type SegmentPart = 0 | 1 | 2 | 3;

const SEG_RAW = 0;
const SEG_INDEX = 1;
const SEG_TYPE = 2;
const SEG_MODIFIER = 3;
const MAX_ARGUMENT_INDEX = 10000;
const TYPE_KEYWORDS: readonly string[] = ['', 'number', 'date', 'time', 'choice'];
const NUMBER_MODIFIER_KEYWORDS: readonly string[] = ['', 'currency', 'percent', 'integer'];
const JAVA_INT = /^[+-]?[0-9]+$/;
const CF_NUMERIC = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
// Java's `.` excludes U+0085, which JavaScript's `.` matches; the non-`u` `i` flag folds ASCII only, as Java does.
const NUMBER_ELEMENT = /\{[0-9]{1,},number[^\n\r\u0085\u2028\u2029]*?\}/gi;
const JAVA_LANGUAGE = /^(?:[a-z]{2,3}|[a-z]{5,8})$/;
const JAVA_COUNTRY = /^(?:[A-Z]{2}|[0-9]{3})$/;
// Java's root locale formats numbers as en-US does; Intl's `und` would resolve to the host default instead.
const ROOT_LOCALE_TAG = 'en-US';
// Grouping separators of Java 17's CLDR 39 where Node's newer CLDR differs.
const JAVA_GROUP_SEPARATORS: ReadonlyMap<string, string> = new Map([
  ['de-CH', '\u2019'],
  ['de-LI', '\u2019'],
  ['en-CH', '\u2019'],
  ['it-CH', '\u2019'],
  ['fr-CH', '\u202f'],
]);
const numberFormats = new Map<string, Intl.NumberFormat>();

function isArgList(args: MessageFormatArgs): args is ReadonlyArray<MessageArg> {
  return Array.isArray(args);
}

/** Java `Integer.parseInt` over ASCII digits; `null` where Java throws. */
function parseJavaInt(text: string): number | null {
  if (!JAVA_INT.test(text)) return null;
  const value = Number(text);
  return value >= -2147483648 && value <= 2147483647 ? value : null;
}

/** `MessageFormat.findKeyword`: exact match, then trimmed lower-case match. */
function findKeyword(segment: string, keywords: readonly string[]): number {
  const exact = keywords.indexOf(segment);
  return exact === -1 ? keywords.indexOf(javaTrim(segment).toLowerCase()) : exact;
}

/** `MessageFormat.makeFormat` for the formats the legacy bundles can reach. */
function compileElement(segments: Readonly<Segments>): PatternElement {
  const [raw, index, type, modifier] = segments;
  const offset = raw.length;
  const argument = parseJavaInt(index);
  if (argument === null) throw new MessageFormatError(`can't parse argument number: ${index}`);
  if (argument < 0) throw new MessageFormatError(`negative argument number: ${argument}`);
  if (argument >= MAX_ARGUMENT_INDEX) {
    throw new MessageFormatError(`${argument} exceeds the ArgumentIndex implementation limit`);
  }
  if (type === '') return { offset, argument, style: null };
  const typeKeyword = findKeyword(type, TYPE_KEYWORDS);
  if (typeKeyword === 0) return { offset, argument, style: null };
  if (typeKeyword === -1) throw new MessageFormatError(`unknown format type: ${type}`);
  const styleKeyword = typeKeyword === 1 ? findKeyword(modifier, NUMBER_MODIFIER_KEYWORDS) : -1;
  if (styleKeyword === 0) return { offset, argument, style: 'number' };
  if (styleKeyword === 3) return { offset, argument, style: 'integer' };
  throw new MessageFormatError(`unsupported format: ${type}${modifier === '' ? '' : `,${modifier}`}`);
}

/** Java 17 `MessageFormat.applyPattern`. */
function compilePattern(pattern: string): CompiledPattern {
  const segments: Segments = ['', '', '', ''];
  const elements: PatternElement[] = [];
  let part: SegmentPart = SEG_RAW;
  let inQuote = false;
  let braceStack = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (part === SEG_RAW) {
      if (ch === "'") {
        if (pattern.charAt(i + 1) === "'") {
          segments[SEG_RAW] += ch;
          i++;
        } else {
          inQuote = !inQuote;
        }
      } else if (ch === '{' && !inQuote) {
        part = SEG_INDEX;
      } else {
        segments[SEG_RAW] += ch;
      }
      continue;
    }
    if (inQuote) {
      segments[part] += ch;
      if (ch === "'") inQuote = false;
      continue;
    }
    switch (ch) {
      case ',':
        if (part === SEG_MODIFIER) segments[part] += ch;
        else part = part === SEG_INDEX ? SEG_TYPE : SEG_MODIFIER;
        break;
      case '{':
        braceStack++;
        segments[part] += ch;
        break;
      case '}':
        if (braceStack === 0) {
          elements.push(compileElement(segments));
          part = SEG_RAW;
          segments[SEG_INDEX] = '';
          segments[SEG_TYPE] = '';
          segments[SEG_MODIFIER] = '';
        } else {
          braceStack--;
          segments[part] += ch;
        }
        break;
      case ' ':
        if (part !== SEG_TYPE || segments[SEG_TYPE] !== '') segments[part] += ch;
        break;
      case "'":
        inQuote = true;
        segments[part] += ch;
        break;
      default:
        segments[part] += ch;
    }
  }
  // Java throws only when no nested brace is open; otherwise the unfinished element is dropped.
  if (braceStack === 0 && part !== SEG_RAW) throw new MessageFormatError('Unmatched braces in the pattern.');
  return { text: segments[SEG_RAW], elements };
}

/** BCP 47 tag for the `java.util.Locale` that `resourceBundle.cfc init` builds from `locale`. */
function javaLocaleTag(locale: string): string {
  const language = foldAsciiCase(cfListFirst(locale, '_'));
  const parts = cfListLen(locale, '_');
  const country = parts > 1 ? upperAsciiCase(cfListGetAt(locale, 2, '_')) : '';
  const variant = parts > 1 ? cfListGetAt(locale, parts, '_') : '';
  if (!JAVA_LANGUAGE.test(language)) return ROOT_LOCALE_TAG;
  // Java maps Locale("th", "TH", "TH") to th-TH-u-nu-thai, which formats with Thai digits.
  if (language === 'th' && country === 'TH' && variant === 'TH') return 'th-TH-u-nu-thai';
  const candidates = JAVA_COUNTRY.test(country) ? [`${language}-${country}`, language] : [language];
  return candidates.find((tag) => Intl.NumberFormat.supportedLocalesOf(tag).length > 0) ?? ROOT_LOCALE_TAG;
}

/** `NumberFormat.getInstance` / `getIntegerInstance`: grouping, half-even, up to 3 or 0 fraction digits. */
function numberFormat(tag: string, style: NumberStyle): Intl.NumberFormat {
  const id = `${style}|${tag}`;
  let format = numberFormats.get(id);
  if (format === undefined) {
    format = new Intl.NumberFormat(tag, {
      maximumFractionDigits: style === 'integer' ? 0 : 3,
      roundingMode: 'halfEven',
      useGrouping: true,
    });
    numberFormats.set(id, format);
  }
  return format;
}

/** Inserts `separator` every three digits from the right, as Java `DecimalFormat` groups. */
function groupDigits(digits: string, separator: string): string {
  const chars = Array.from(digits);
  return chars.map((digit, i) => (i > 0 && (chars.length - i) % 3 === 0 ? separator + digit : digit)).join('');
}

/** Formats as Java `NumberFormat` does; Java ignores CLDR's secondary grouping size (`12,34,567`). */
function formatJavaNumber(tag: string, style: NumberStyle, value: number): string {
  const parts = numberFormat(tag, style).formatToParts(value);
  const group = parts.find((part) => part.type === 'group');
  if (group === undefined) return parts.map((part) => part.value).join('');
  const separator = JAVA_GROUP_SEPARATORS.get(tag) ?? group.value;
  const integer = parts.filter((part) => part.type === 'integer').map((part) => part.value).join('');
  let result = '';
  let integerDone = false;
  for (const part of parts) {
    if (part.type !== 'integer' && part.type !== 'group') {
      result += part.value;
    } else if (!integerDone) {
      result += groupDigits(integer, separator);
      integerDone = true;
    }
  }
  return result;
}

/** CFML `javacast("float", args[position])` with a 1-based position. */
function toJavaFloat(args: readonly MessageArg[], position: number): number {
  if (position < 1 || position > args.length) {
    throw new MessageFormatError(`The element at position ${position} of the message arguments cannot be found.`);
  }
  const value = args[position - 1] ?? null;
  if (typeof value === 'number') return Math.fround(value);
  const text = value === null ? '' : javaTrim(value);
  if (!CF_NUMERIC.test(text)) throw new MessageFormatError(`The value ${String(value)} cannot be converted to a float.`);
  return Math.fround(Number(text));
}

/** Java 17 `MessageFormat.format` over the compiled pattern. */
function formatPattern(compiled: CompiledPattern, args: readonly MessageArg[], tag: string): string {
  let result = '';
  let last = 0;
  for (const element of compiled.elements) {
    result += compiled.text.slice(last, element.offset);
    last = element.offset;
    if (element.argument >= args.length) {
      result += `{${element.argument}}`;
      continue;
    }
    const value = args[element.argument] ?? null;
    if (value === null) result += 'null';
    else if (typeof value === 'number') result += formatJavaNumber(tag, element.style ?? 'number', value);
    else if (element.style === null) result += value;
    else throw new MessageFormatError('Cannot format given Object as a Number');
  }
  return result + compiled.text.slice(last);
}

/**
 * `resourceBundle.cfc messageFormat`: a non-array `args` is split as a comma list, `{0}` is empty and `{1}` is the
 * first argument, and apostrophes stay literal.
 */
export function messageFormat(pattern: string, args: MessageFormatArgs, locale: string): string {
  const values: MessageArg[] = isArgList(args) ? [...args] : cfListToArray(String(args), ',');
  const compiled = compilePattern(pattern.replaceAll("'", "''"));
  for (const match of pattern.matchAll(NUMBER_ELEMENT)) {
    const position = Number(cfListFirst(match[0].replace('{', ''), ','));
    values[position - 1] = toJavaFloat(values, position);
  }
  return formatPattern(compiled, ['', ...values], javaLocaleTag(locale));
}

/** `resourceBundleFactory.cfc CF2Java` case labels, lower-cased (the CFML `switch` is case-insensitive). */
const CF_TO_JAVA: Readonly<Record<string, string>> = Object.freeze({
  'dutch (belgian)': 'nl_BE',
  'dutch (standard)': 'nl_NL',
  'english (australian)': 'en_AU',
  'english (canadian)': 'en_CA',
  'english (uk)': 'en_GB',
  'english (new zealand)': 'en_NZ',
  'english (us)': 'en_US',
  'french (belgian)': 'fr_BE',
  'french (canadian)': 'fr_CA',
  'french (standard)': 'fr_FR',
  'french (swiss)': 'fr_CH',
  'german (austrian)': 'de_AT',
  'german (standard)': 'de_DE',
  'german (swiss)': 'de_CH',
  'italian (standard)': 'it_IT',
  'italian (swiss)': 'it_CH',
  'norwegian (bokmal)': 'no_NO',
  'norwegian (nynorsk)': 'no_NO',
  'portuguese (brazilian)': 'pt_BR',
  'portuguese (standard)': 'pt_PT',
  'spanish (mexican)': 'es_MX',
  'spanish (modern)': 'es_ES',
  'spanish (united states)': 'es_US',
  'spanish (standard)': 'es_ES',
  'swedish': 'sv_SE',
  'japanese': 'ja_JP',
  'korean': 'ko_KR',
  'chinese (china)': 'zh_CN',
  'chinese (hong kong)': 'zh_HK',
  'chinese (taiwan)': 'zh_TW',
  'arabic': 'ar',
  'arabic (united arab emirates)': 'ar',
  'arabic (bahrain)': 'ar',
  'arabic (algeria)': 'ar',
  'arabic (egypt)': 'ar',
  'arabic (iraq)': 'ar',
  'arabic (jordan)': 'ar',
  'arabic (kuwait)': 'ar',
  'arabic (lebanon)': 'ar',
  'arabic (libya)': 'ar',
  'arabic (morocco)': 'ar',
  'arabic (oman)': 'ar',
  'arabic (qatar)': 'ar',
  'arabic (saudi arabia)': 'ar',
  'arabic (sudan)': 'ar',
  'arabic (syria)': 'ar',
  'arabic (tunisia)': 'ar',
  'arabic (yemen)': 'ar',
  'hindi (india)': 'hi_IN',
  'hebrew': 'iw_IL',
  'hebrew (israel)': 'iw_IL',
  'japanese (japan)': 'ja_JP',
  'korean (south korea)': 'ko_KY',
  'thai': 'vi_VN',
  'thai (thailand)': 'vi_VN',
  'vietnamese': 'vi_VN',
  'vietnamese (vietnam)': 'vi_VN',
  'chinese': 'ch_CN',
  'belarusian': 'be_BY',
  'belarusian (belarus)': 'be_BY',
  'bulgarian': 'bg_BG',
  'bulgarian (bulgaria)': 'bg_BG',
  'catalan': 'ca_ES',
  'catalan (spain)': 'ca_ES',
  'czech': 'cs_CZ',
  'czech (czech republic)': 'cs_CZ',
  'danish': 'da_DK',
  'danish (denmark)': 'da_DK',
  'german': 'de_DE',
  'german (austria)': 'de_AT',
  'german (switzerland)': 'de_CH',
  'german (germany)': 'de_DE',
  'german (luxembourg)': 'de_LU',
  'greek': 'el_GR',
  'greek (greece)': 'el_GR',
  'english (australia)': 'en_AU',
  'english (canada)': 'en_CA',
  'english (united kingdom)': 'en_GB',
  'english (ireland)': 'en_IE',
  'english (india)': 'en_IN',
  'english (south africa)': 'en_ZA',
  'spanish': 'es_ES',
  'spanish (argentina)': 'es_BO',
  'spanish (bolivia)': 'es_UY',
  'spanish (chile)': 'es_CL',
  'spanish (colombia)': 'es_CO',
  'spanish (costa rica)': 'es_CR',
  'spanish (dominican republic)': 'es_DO',
  'spanish (ecuador)': 'es_EC',
  'spanish (spain)': 'es_ES',
  'spanish (guatemala)': 'es_GT',
  'spanish (honduras)': 'es_HN',
  'spanish (mexico)': 'es_MX',
  'spanish (nicaragua)': 'es_NI',
  'spanish (panama)': 'es_PA',
  'spanish (peru)': 'es_PE',
  'spanish (puerto rico)': 'es_PR',
  'spanish (paraguay)': 'es_PY',
  'spanish (el salvador)': 'es_SV',
  'spanish (uruguay)': 'es_UY',
  'spanish (venezuela)': 'es_VE',
  'estonian': 'et_EE',
  'estonian (estonia)': 'et_EE',
  'finnish': 'fi_FI',
  'finnish (finland)': 'fi_FI',
  'french': 'fr_FR',
  'french (belgium)': 'fr_BE',
  'french (canada)': 'fr_CA',
  'french (switzerland)': 'fr_CH',
  'french (france)': 'fr_FR',
  'french (luxembourg)': 'fr_LU',
  'croatian': 'hr_HR',
  'croatian (croatia)': 'hr_HR',
  'hungarian': 'hu_HU',
  'hungarian (hungary)': 'hu_HU',
  'icelandic': 'is_IS',
  'icelandic (iceland)': 'is_IS',
  'italian': 'it_IT',
  'italian (switzerland)': 'it_CH',
  'italian (italy)': 'it_IT',
  'lithuanian': 'lt_LT',
  'lithuanian (lithuania)': 'lt_LT',
  'latvian': 'lv_LV',
  'latvian (latvia)': 'lv_LV',
  'macedonian': 'mk_MK',
  'macedonian (macedonia)': 'mk_MK',
  'dutch': 'nl_NL',
  'dutch (belgium)': 'nl_BE',
  'dutch (netherlands)': 'nl_NL',
  'norwegian': 'no_NO',
  'norwegian (norway)': 'no_NO',
  'polish': 'pl_PL',
  'polish (poland)': 'pl_PL',
  'portuguese': 'pt_PT',
  'portuguese (brazil)': 'pt_BR',
  'portuguese (portugal)': 'pt_PT',
  'romanian': 'ro_RO',
  'romanian (romania)': 'ro_RO',
  'russian': 'ru_RU',
  'russian (russia)': 'ru_RU',
  'slovak': 'sk_SK',
  'slovak (slovakia)': 'sk_SK',
  'slovenian': 'sl_SI',
  'slovenian (slovenia)': 'sl_SI',
  'albanian': 'sq_AL',
  'albanian (albania)': 'sq_AL',
  'serbian': 'sh_YU',
  'serbian (bosnia and herzegovina)': 'sh_YU',
  'serbian (serbia and montenegro)': 'sh_YU',
  'swedish (sweden)': 'sv_SE',
  'swiss german (switzerland)': 'de_CH',
  'turkish': 'tr_TR',
  'turkish (turkey)': 'tr_TR',
  'ukrainian': 'uk_UA',
  'ukrainian (ukraine)': 'uk_UA',
  'english (united states)': 'en_US',
  'english': 'en_US',
});

/** ColdFusion locale name to Java locale; an unknown name passes through and an empty one gives `serverLocale`. */
export function cf2Java(cflocale: string, serverLocale = SERVER_LOCALE): string {
  let locale = javaTrim(cflocale);
  if (cfEqualsNoCase(locale, 'Server')) locale = serverLocale;
  const key = locale.toLowerCase();
  const java = Object.hasOwn(CF_TO_JAVA, key) ? CF_TO_JAVA[key] : undefined;
  if (java !== undefined) return java;
  return locale === '' ? serverLocale : locale;
}

/** True when `cf2Java(locale)` is a `ll_CC` Java locale. */
export function isSupportedLocale(locale: string): boolean {
  const translation = cf2Java(locale);
  return translation.length === 5 && cfListLen(translation, '_') === 2;
}

/** Default chains over the build-time bundles. */
export const { rbFor, siteRbFor, rbKey } = createResourceBundles(data);
