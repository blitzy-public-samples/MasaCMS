// Masa's validation of a Type=2 user save on people's side (userBean.validate, addressBean.validate and
// fileManager.requestHasRestrictedFiles) and its merge with identity's prepare errors into legacy's errors struct.
import { domainToASCII } from 'node:url';
import { cfEq, cfHash, cfNumberString, cfToBoolean, javaTrim } from '@opt2/platform/legacy-compat';
import { EN_PEOPLE_MESSAGES, enPeopleMessages, type PeopleMessages } from './messages.js';
import type { UserValues } from './person.js';

/**
 * English texts (the default site locale) of `user.emailrequired`, `captcha.error`, `captcha.spam`,
 * `sitemanager.requesthasrestrictedfiles` and userBean's literal blank-site message (userBean.cfc:508).
 */
export const PEOPLE_MESSAGES = Object.freeze({
  emailRequired: EN_PEOPLE_MESSAGES['user.emailrequired'],
  captchaError: EN_PEOPLE_MESSAGES['captcha.error'],
  captchaSpam: EN_PEOPLE_MESSAGES['captcha.spam'],
  restrictedFiles: EN_PEOPLE_MESSAGES['sitemanager.requesthasrestrictedfiles'],
  siteIdMissing: "The 'SiteID' variable is missing.",
});

/** configBean `FMAllowedExtensions` default (configBean.cfc:226), checked on user create. */
export const FM_ALLOWED_EXTENSIONS =
  '7z,aiff,asf,avi,bmp,csv,doc,docx,eps,fla,flv,gif,gz,gzip,ics,jpeg,jpg,json,key,keynote,mid,mov,mp3,mp4,mpc,mpeg,mpg,' +
  'numbers,ods,odt,pages,pdf,png,ppt,pptx,ppsx,pxd,qt,ram,rar,rm,rmi,rmvb,rtf,sdc,sitd,swf,sxc,sxw,svg,tar,tgz,tif,tiff,' +
  'txt,vsd,wav,wma,wmv,xls,xlsx,xml,zip,m4v,less';

/** configBean `FMPublicAllowedExtensions` default (configBean.cfc:227), checked on user update. */
export const FM_PUBLIC_ALLOWED_EXTENSIONS = FM_ALLOWED_EXTENSIONS;

/** The configBean extension lists a site may override. */
export interface FileExtensionConfig {
  allowed: string;
  publicAllowed: string;
}

/** A legacy errors struct: field name to message, or to a nested struct. */
export type LegacyErrors = { [key: string]: string | LegacyErrors };

// ---------------------------------------------------------------------------------------------------------------
// ACF struct iteration order. A CFML struct is a java.util.concurrent.ConcurrentHashMap keyed by the upper-cased
// name, so legacy iterates (and serializes) keys in hash-bin order, not in the order they were set.

interface StructNode<V> {
  key: string;
  upper: string;
  hash: number;
  value: V;
}

/** ConcurrentHashMap.spread of Java's String.hashCode of the upper-cased key (coldfusion.util.Key). */
function structHash(upper: string): number {
  let h = 0;
  for (let i = 0; i < upper.length; i++) h = (Math.imul(31, h) + upper.charCodeAt(i)) | 0;
  return (h ^ (h >>> 16)) & 0x7fffffff;
}

/** ConcurrentHashMap.transfer into a table twice the size: nodes before a bin's last run are prepended. */
function doubleTable<V>(table: StructNode<V>[][]): StructNode<V>[][] {
  const n = table.length;
  const next: StructNode<V>[][] = Array.from({ length: n * 2 }, () => []);
  table.forEach((bin, i) => {
    if (bin.length === 0) return;
    let runBit = bin[0]!.hash & n;
    let lastRun = 0;
    for (let j = 1; j < bin.length; j++) {
      const bit = bin[j]!.hash & n;
      if (bit !== runBit) {
        runBit = bit;
        lastRun = j;
      }
    }
    const low = runBit === 0 ? bin.slice(lastRun) : [];
    const high = runBit === 0 ? [] : bin.slice(lastRun);
    for (let j = 0; j < lastRun; j++) {
      const node = bin[j]!;
      ((node.hash & n) === 0 ? low : high).unshift(node);
    }
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/**
 * The order an ACF struct built by setting `entries` in sequence iterates them: a key set again in another casing
 * keeps its first spelling and position and takes the new value.
 */
function acfStructOrder<V>(entries: Iterable<readonly [string, V]>): Array<[string, V]> {
  let table: StructNode<V>[][] = Array.from({ length: 16 }, () => []);
  let count = 0;
  for (const [key, value] of entries) {
    const upper = key.toUpperCase();
    const hash = structHash(upper);
    const bin = table[hash & (table.length - 1)]!;
    const existing = bin.find((node) => node.upper === upper);
    if (existing !== undefined) {
      existing.value = value;
      continue;
    }
    bin.push({ key, upper, hash, value });
    count += 1;
    // Not modelled: ConcurrentHashMap treeifies a bin once eight keys collide in it.
    if (count >= table.length - (table.length >>> 2)) table = doubleTable(table);
  }
  return table.flat().map((node) => [node.key, node.value]);
}

/** A plain object holding `entries` in their order; defined, not assigned, so a `__proto__` key stays data. */
function errorsObject(entries: Iterable<readonly [string, string | LegacyErrors]>): LegacyErrors {
  const errors: LegacyErrors = {};
  for (const [key, value] of entries) {
    Object.defineProperty(errors, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// ACF isValid('url'): mailto: through javax.mail, values holding '[' and ']' through CFURLIPV6Validator's pattern,
// others through CFURLValidator, which parses ASCII and news: values with JDK 17's java.net.URI and the rest with
// java.net.URL and IDNA.

/** A java.net.URI character class: its ASCII members, and whether %XX escapes and visible non-ASCII chars pass. */
interface UriClass {
  readonly chars: string;
  readonly escaped: boolean;
}

const DIGIT = '0123456789';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ALPHANUM = DIGIT + ALPHA;
const UNRESERVED = `${ALPHANUM}-_.!~*'()`;
const uriClass = (chars: string, escaped = false): UriClass => ({ chars, escaped });
const URI_CLASS = {
  digit: uriClass(DIGIT),
  hex: uriClass(`${DIGIT}ABCDEFabcdef`),
  alpha: uriClass(ALPHA),
  alphanum: uriClass(ALPHANUM),
  alphanumDash: uriClass(`${ALPHANUM}-`),
  digitDot: uriClass(`${DIGIT}.`),
  uric: uriClass(`${UNRESERVED};/?:@&=+$,[]`, true),
  path: uriClass(`${UNRESERVED}:@&=+$,;/`, true),
  userInfo: uriClass(`${UNRESERVED};:&=+$,`, true),
  regName: uriClass(`${UNRESERVED}$,;:@&=+`, true),
  // parseAuthority's '%'-free variant applies only to an authority starting with ']', which never parses as a server.
  server: uriClass(`${UNRESERVED};:&=+$,@[]%`, true),
} as const;

const SPACE_CHAR = /[\p{Zs}\p{Zl}\p{Zp}]/u;

function inClass(c: number, cls: UriClass): boolean {
  return c > 0 && c < 128 && cls.chars.includes(String.fromCharCode(c));
}

/** Java's Character.isSpaceChar or isISOControl of a UTF-16 unit. */
function isSpaceOrControl(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || SPACE_CHAR.test(String.fromCharCode(c));
}

class UriSyntaxError extends Error {}

/** java.net.URI's parser (URI$Parser) over one input; `host` is null without a server-based authority. */
class JavaUriParser {
  host: string | null = null;

  constructor(
    private readonly input: string,
    private readonly requireServerAuthority: boolean,
  ) {}

  /** `new URI(input)` for an input opening with one of the validator's schemes, all valid scheme names. */
  parseUri(): void {
    const n = this.input.length;
    let p = this.input.indexOf(':') + 1;
    if (this.at(p, n, '/')) {
      p = this.parseHierarchical(p, n);
    } else {
      const q = this.scanUntil(p, n, '#');
      if (q <= p) this.fail();
      this.checkChars(p, q, URI_CLASS.uric);
      p = q;
    }
    if (this.at(p, n, '#')) this.checkChars(p + 1, n, URI_CLASS.uric);
  }

  /** The whole input as the authority of `new URI(scheme, userInfo, host, port, …)`. */
  parseServerAuthority(): void {
    this.parseAuthority(0, this.input.length);
  }

  private fail(): never {
    throw new UriSyntaxError(this.input);
  }

  private at(p: number, n: number, s: string): boolean {
    return p + s.length <= n && this.input.startsWith(s, p);
  }

  private scanUntil(start: number, n: number, stop: string): number {
    let p = start;
    while (p < n && !stop.includes(this.input[p]!)) p++;
    return p;
  }

  private scanEscape(p: number, n: number, c: number): number {
    if (c === 0x25) {
      const hex = (i: number): boolean => inClass(this.input.charCodeAt(i), URI_CLASS.hex);
      if (p + 3 <= n && hex(p + 1) && hex(p + 2)) return p + 3;
      this.fail();
    }
    return c > 128 && !isSpaceOrControl(c) ? p + 1 : p;
  }

  private scanClass(start: number, n: number, cls: UriClass): number {
    let p = start;
    while (p < n) {
      const c = this.input.charCodeAt(p);
      if (inClass(c, cls)) {
        p++;
        continue;
      }
      if (cls.escaped) {
        const q = this.scanEscape(p, n, c);
        if (q > p) {
          p = q;
          continue;
        }
      }
      break;
    }
    return p;
  }

  private checkChars(start: number, end: number, cls: UriClass): void {
    if (this.scanClass(start, end, cls) < end) this.fail();
  }

  private parseHierarchical(start: number, n: number): number {
    let p = start;
    if (this.at(p, n, '//')) {
      p += 2;
      const q = this.scanUntil(p, n, '/?#');
      if (q > p) p = this.parseAuthority(p, q);
      else if (q >= n) this.fail();
    }
    let q = this.scanUntil(p, n, '?#');
    this.checkChars(p, q, URI_CLASS.path);
    p = q;
    if (this.at(p, n, '?')) {
      p++;
      q = this.scanUntil(p, n, '#');
      this.checkChars(p, q, URI_CLASS.uric);
      p = q;
    }
    return p;
  }

  private parseAuthority(start: number, n: number): number {
    const serverChars = this.scanClass(start, n, URI_CLASS.server) === n;
    const regChars = this.scanClass(start, n, URI_CLASS.regName) === n;
    let error: UriSyntaxError | undefined;
    if (serverChars) {
      try {
        if (this.parseServer(start, n, !this.requireServerAuthority && regChars) === n) return n;
        // A lenient parse that stops short leaves the authority registry-based.
        this.host = null;
      } catch (e) {
        if (!(e instanceof UriSyntaxError)) throw e;
        this.host = null;
        if (this.requireServerAuthority) throw e;
        error = e;
      }
    }
    // A registry-based authority leaves the host null.
    if (!regChars) throw error ?? new UriSyntaxError(this.input);
    return n;
  }

  /** The end of `[userinfo@]host[:port]`; a strict parse fails rather than stop short of `n`. */
  private parseServer(start: number, n: number, lenient: boolean): number {
    let p = start;
    const at = this.scanUntil(p, n, '@');
    if (at < n) {
      this.checkChars(p, at, URI_CLASS.userInfo);
      p = at + 1;
    }
    // ACF validates a value holding both '[' and ']' by pattern instead, so an IPv6 literal here lacks its ']'.
    if (this.at(p, n, '[')) this.fail();
    const q = this.parseIPv4Address(p, n);
    p = q > p ? q : this.parseHostname(p, n, lenient);
    if (!this.at(p, n, ':')) return p;
    this.checkChars(p + 1, n, URI_CLASS.digit);
    // Integer.parseInt overflow.
    if (Number(this.input.slice(p + 1, n)) > 0x7fffffff) this.fail();
    return n;
  }

  private scanByte(start: number, n: number): number {
    const q = this.scanClass(start, n, URI_CLASS.digit);
    if (q <= start) return q;
    return Number(this.input.slice(start, q)) > 255 ? start : q;
  }

  /** The end of four dotted bytes that close the run of digits and dots at `start`, else -1. */
  private scanIPv4Address(start: number, n: number): number {
    const m = this.scanClass(start, n, URI_CLASS.digitDot);
    if (m <= start) return -1;
    let p = start;
    for (let part = 0; part < 4; part++) {
      if (part > 0) {
        if (!this.at(p, m, '.')) return -1;
        p++;
      }
      const q = this.scanByte(p, m);
      if (q <= p) return -1;
      p = q;
    }
    return p < m ? -1 : p;
  }

  private parseIPv4Address(start: number, n: number): number {
    let p = this.scanIPv4Address(start, n);
    if (p > start && p < n && this.input[p] !== ':') p = -1;
    if (p > start) this.host = this.input.substring(start, p);
    return p;
  }

  private parseHostname(start: number, n: number, lenient: boolean): number {
    let p = start;
    let l = -1;
    do {
      let q = this.scanClass(p, n, URI_CLASS.alphanum);
      if (q <= p) break;
      l = p;
      p = q;
      q = this.scanClass(p, n, URI_CLASS.alphanumDash);
      if (q > p) {
        if (this.input[q - 1] === '-') this.fail();
        p = q;
      }
      if (!this.at(p, n, '.')) break;
      p++;
    } while (p < n);
    if (p < n && !this.at(p, n, ':')) {
      if (lenient) return p;
      this.fail();
    }
    if (l < 0) this.fail();
    // The rightmost label of a dotted name starts with a letter.
    if (l > start && !inClass(this.input.charCodeAt(l), URI_CLASS.alpha)) this.fail();
    this.host = this.input.substring(start, p);
    return p;
  }
}

// CFURLIPV6Validator's pattern (ORO exact match), which ACF applies instead to a value holding both '[' and ']'.
const CF_URL_IPV6 = new RegExp(
  String.raw`^(?:(?:http|https|ftp|file):\/\/(?:[a-zA-Z0]*:[a-zA-Z0]*@)?\[?[a-zA-Z0-9\-.:]+\]?(?:\.[a-zA-Z]{2,3})?` +
    String.raw`(?::[a-zA-Z0-9]*)?\/?(?:[a-zA-Z0-9\-._?,'\/+&amp;:@$#=~*!()]|%[a-f0-9]{2})*|news:[a-zA-Z0-9.]*)$`,
);
const ACE_PREFIX = 'xn--';
const URL_PREFIXES: readonly string[] = ['http://', 'https://', 'ftp://', 'file://', 'news:'];
const HOST_SCHEMES: readonly string[] = ['http', 'https', 'ftp', 'file'];

function isAllAscii(s: string): boolean {
  return /^[\x00-\x7f]*$/.test(s);
}

const DECIMAL_DIGIT = /\p{Nd}/u;

/** Java's Character.digit(c, 10) of a UTF-16 unit: every BMP run of decimal digits is ten long, zero first. */
function javaDigit(c: string): number {
  if (!DECIMAL_DIGIT.test(c)) return -1;
  const code = c.charCodeAt(0);
  let zero = code;
  while (code - zero < 9 && DECIMAL_DIGIT.test(String.fromCharCode(zero - 1))) zero--;
  return code - zero;
}

/** Java's Integer.parseInt(s, 10) of non-empty text: optionally signed decimal digits; undefined where it throws. */
function javaParseInt(text: string): number | undefined {
  const signed = text.length > 1 && (text.startsWith('-') || text.startsWith('+'));
  let value = 0;
  for (let i = signed ? 1 : 0; i < text.length; i++) {
    const digit = javaDigit(text[i]!);
    if (digit < 0) return undefined;
    value = value * 10 + digit;
  }
  const result = signed && text.startsWith('-') ? -value : value;
  return result > 0x7fffffff || result < -0x80000000 ? undefined : result;
}

/**
 * ICU's IDNA nameToASCII of a java.net.URL host; undefined where no URI host can result. Node's UTS #46
 * (nontransitional, as ACF configures ICU) stands in for ICU and yields '' where ICU flags a label error.
 */
function idnaHost(host: string): string | undefined {
  if (host === '') return undefined;
  // ICU keeps '%', which no URI hostname accepts; node would decode the escape.
  if (host.includes('%')) return undefined;
  // ICU decodes a bare "xn--" label to an empty one.
  const labels = host.split('.').map((label) => (label === ACE_PREFIX ? '' : label));
  if (!isAllAscii(host)) return domainToASCII(labels.join('.')) || undefined;
  // ICU marks an undecodable ACE label with U+FFFD; node's parse of the label alone finds the same labels.
  const decodable = labels.every((label) => !label.startsWith(ACE_PREFIX) || domainToASCII(label) !== '');
  return decodable ? labels.join('.') : undefined;
}

/**
 * The validator's branch for http, https, ftp and file values with non-ASCII chars: java.net.URL's authority split,
 * the IDNA host, then the server-authority parse of `new URI(scheme, userInfo, host, port, path, query, fragment)`,
 * which quotes everything else (the quoted user info always parses, so only its presence is kept).
 */
function isValidNonAsciiUrl(s: string): boolean {
  const start = s.indexOf(':') + 1;
  let limit = s.indexOf('#', start);
  if (limit < 0) limit = s.length;
  const query = s.indexOf('?');
  if (query >= 0 && query < limit) limit = query;
  // A UNC-style "////" leaves URL without an authority, so with an empty host.
  if (start <= limit - 4 && s.startsWith('////', start)) return false;
  const authorityStart = start + 2;
  const slash = s.indexOf('/', authorityStart);
  const authority = s.slice(authorityStart, slash >= 0 && slash < limit ? slash : limit);
  const at = authority.indexOf('@');
  // A second '@' makes URL treat the authority as registry-based: no host.
  if (at !== authority.lastIndexOf('@')) return false;
  let host = authority.slice(at + 1);
  // With no ']' in the value (see CF_URL_IPV6), URL rejects a host opening an IPv6 literal.
  if (host.startsWith('[')) return false;
  let port: number | undefined = -1;
  const colon = host.indexOf(':');
  if (colon >= 0) {
    if (host.length > colon + 1) port = javaParseInt(host.slice(colon + 1));
    host = host.slice(0, colon);
  }
  if (port === undefined || port < -1) return false;
  const asciiHost = idnaHost(host);
  if (asciiHost === undefined) return false;
  const parser = new JavaUriParser(`${at < 0 ? '' : '@'}${asciiHost}${port === -1 ? '' : `:${port}`}`, true);
  try {
    parser.parseServerAuthority();
  } catch (e) {
    if (e instanceof UriSyntaxError) return false;
    throw e;
  }
  return parser.host !== null;
}

class AddressError extends Error {}

const RFC822_SPECIALS_NO_DOT = '()<>,;:\\"[]@';
const LETTER_OR_DIGIT = /[\p{L}\p{Nd}]/u;
const BACKSLASH = 0x5c;

function indexOfAny(s: string, chars: string, start: number): number {
  for (let i = start; i < s.length; i++) if (chars.includes(s[i]!)) return i;
  return -1;
}

/** javax.mail InternetAddress.checkAddress (JavaMail 1.6.7); throws AddressError. */
function checkAddress(addr: string, routeAddr: boolean, validate: boolean): void {
  const fail = (): never => {
    throw new AddressError(addr);
  };
  const len = addr.length;
  if (len === 0) fail();
  let start = 0;
  if (routeAddr && addr.startsWith('@')) {
    // A route-addr: [@domain[,@domain ...]:]local@domain.
    for (;;) {
      const i = indexOfAny(addr, ',:', start);
      if (i < 0) break;
      if (addr[start] !== '@') fail();
      start = i + 1;
      if (addr[i] === ':') break;
    }
  }
  let c = 0xffff;
  let lastc = 0xffff;
  let inQuote = false;
  let i = start;
  for (; i < len; i++) {
    lastc = c;
    c = addr.charCodeAt(i);
    // A quoted pair outside a quoted string is tolerated.
    if (c === BACKSLASH || lastc === BACKSLASH) continue;
    if (c === 0x22) {
      if (inQuote) {
        if (validate && i + 1 < len && addr[i + 1] !== '@') fail();
        inQuote = false;
      } else {
        if (validate && i !== 0) fail();
        inQuote = true;
      }
      continue;
    }
    if (c === 0x0d && i + 1 < len && addr[i + 1] !== '\n') fail();
    if (c === 0x0a && i + 1 < len && addr[i + 1] !== ' ' && addr[i + 1] !== '\t') fail();
    if (inQuote) continue;
    if (c === 0x2e && (i === start || lastc === 0x2e)) fail();
    if (c === 0x40) {
      if (i === 0 || lastc === 0x2e) fail();
      break;
    }
    if (c <= 0x20 || c === 0x7f || RFC822_SPECIALS_NO_DOT.includes(String.fromCharCode(c))) fail();
  }
  if (inQuote) fail();
  if (c !== 0x40) {
    if (validate) fail();
    return;
  }
  start = i + 1;
  if (start >= len || addr[start] === '.') fail();
  let inLiteral = false;
  for (i = start; i < len; i++) {
    c = addr.charCodeAt(i);
    if (c === 0x5b) {
      if (i !== start) fail();
      inLiteral = true;
    } else if (c === 0x5d) {
      if (i !== len - 1) fail();
      inLiteral = false;
    } else if (c <= 0x20 || c === 0x7f) {
      fail();
    } else if (!inLiteral) {
      if (!(LETTER_OR_DIGIT.test(String.fromCharCode(c)) || c === 0x2d || c === 0x2e)) fail();
      if (c === 0x2e && lastc === 0x2e) fail();
    }
    lastc = c;
  }
  if (lastc === 0x2e) fail();
}

/** javax.mail InternetAddress.parse(text, strict = true): each address text; throws AddressError. */
function parseStrictAddresses(text: string): string[] {
  const fail = (): never => {
    throw new AddressError(text);
  };
  const addresses: string[] = [];
  const length = text.length;
  let start = -1;
  let end = -1;
  let inGroup = false;
  let routeAddr = false;
  const take = (): void => {
    const address = javaTrim(text.substring(start, end));
    checkAddress(address, routeAddr, false);
    addresses.push(address);
  };
  for (let index = 0; index < length; index++) {
    const c = text[index]!;
    switch (c) {
      case '(': {
        if (start >= 0 && end === -1) end = index;
        let nesting = 1;
        for (index++; index < length && nesting > 0; index++) {
          const d = text[index];
          if (d === '\\') index++;
          else if (d === '(') nesting++;
          else if (d === ')') nesting--;
        }
        if (nesting > 0) fail();
        index--;
        break;
      }
      case '<': {
        if (routeAddr) fail();
        const open = index;
        let inQuote = false;
        for (index++; index < length; index++) {
          const d = text[index];
          if (d === '\\') index++;
          else if (d === '"') inQuote = !inQuote;
          else if (d === '>' && !inQuote) break;
        }
        if (inQuote || index >= length) fail();
        if (!inGroup) start = open + 1;
        end = index;
        routeAddr = true;
        break;
      }
      case '"':
      case '[': {
        if (start === -1) start = index;
        const close = c === '"' ? '"' : ']';
        for (index++; index < length; index++) {
          const d = text[index];
          if (d === '\\') index++;
          else if (d === close) break;
        }
        if (index >= length) fail();
        break;
      }
      case ';':
        if (start === -1) {
          routeAddr = false;
          end = -1;
          break;
        }
        if (!inGroup) fail();
        inGroup = false;
        addresses.push(javaTrim(text.substring(start, index + 1)));
        routeAddr = false;
        start = end = -1;
        break;
      case ',':
        if (start === -1) {
          routeAddr = false;
          end = -1;
          break;
        }
        if (inGroup) {
          routeAddr = false;
          break;
        }
        if (end === -1) end = index;
        take();
        routeAddr = false;
        start = end = -1;
        break;
      case ':':
        if (inGroup) fail();
        if (start === -1) start = index;
        inGroup = true;
        break;
      case ')':
      case '>':
        fail();
        break;
      case ' ':
      case '\t':
      case '\r':
      case '\n':
        break;
      default:
        if (start === -1) start = index;
    }
  }
  if (start >= 0) {
    if (end === -1) end = length;
    take();
  }
  return addresses;
}

/**
 * MailSpooler.validateEmail: `new InternetAddress(text).validate()`. Its java.net.IDN.toASCII step changes no
 * all-ASCII address; other text is checked as is.
 */
function isValidMailAddress(text: string): boolean {
  try {
    const addresses = parseStrictAddresses(text);
    if (addresses.length !== 1) return false;
    const address = addresses[0]!;
    const colon = address.indexOf(':');
    // A group validates its members as parseHeader does, without the final '@domain' rule.
    if (address.endsWith(';') && colon > 0) parseStrictAddresses(address.slice(colon + 1, -1));
    else checkAddress(address, true, true);
    return true;
  } catch (e) {
    if (e instanceof AddressError) return false;
    throw e;
  }
}

/** ACF isValid('url', value) of a string. */
function cfIsValidUrl(value: string): boolean {
  const s = javaTrim(value.toLowerCase());
  if (s.startsWith('mailto:')) {
    // ACF reads substring(8): a bare 'mailto:' throws, failing the legacy request with a server error.
    if (s.length < 8) throw new RangeError(`begin 8, end ${s.length}, length ${s.length}`);
    return isValidMailAddress(s.substring(8));
  }
  if (s.includes('[') && s.includes(']')) return CF_URL_IPV6.test(s);
  if (!URL_PREFIXES.some((prefix) => s.startsWith(prefix))) return false;
  if (!s.startsWith('news:') && !isAllAscii(s)) return isValidNonAsciiUrl(s);
  const parser = new JavaUriParser(s, false);
  try {
    parser.parseUri();
  } catch (e) {
    if (e instanceof UriSyntaxError) return false;
    throw e;
  }
  return parser.host !== null || !HOST_SCHEMES.includes(s.slice(0, s.indexOf(':')));
}

// ---------------------------------------------------------------------------------------------------------------
// The checks.

/** CFML list items over one delimiter char, empty items dropped. */
function cfListItems(list: string, delimiter: string): string[] {
  return list.split(delimiter).filter((item) => item !== '');
}

function cfListFirst(list: string, delimiter: string): string {
  return cfListItems(list, delimiter)[0] ?? '';
}

function cfListLast(list: string, delimiter: string): string {
  return cfListItems(list, delimiter).at(-1) ?? '';
}

function cfListFindNoCase(list: string, value: string): boolean {
  const wanted = value.toLowerCase();
  return cfListItems(list, ',').some((item) => item.toLowerCase() === wanted);
}

function isSimpleValue(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

/** getPostedClientFileName: the client file name of the first file part named `field`, ignoring case. */
function postedClientFileName(postedFiles: ReadonlyMap<string, string>, field: string): string | undefined {
  const name = field.toLowerCase();
  for (const [part, fileName] of postedFiles) if (part.toLowerCase() === name) return fileName;
  return undefined;
}

/**
 * People's part of userBean.validate (userBean.cfc:467-511), in the order it sets errors: `email`, `SecurityCode`
 * and `Spam`, or `siteid` alone for a blank site id. Identity's prepare answers the `password` and `username` checks.
 * `rb` gives the texts of the user's site bundle.
 */
export function validatePersonValues(
  values: Pick<UserValues, 'siteid' | 'type' | 'email' | 'hkey' | 'ukey' | 'passedprotect'>,
  rb: PeopleMessages = enPeopleMessages,
): LegacyErrors {
  if (javaTrim(values.siteid) === '') return { siteid: PEOPLE_MESSAGES.siteIdMissing };
  const errors: LegacyErrors = {};
  const type = typeof values.type === 'number' ? cfNumberString(values.type) : values.type;
  if (cfEq(type, '2') && cfEq(values.email, '')) errors.email = rb(values.siteid, 'user.emailrequired');
  // The captcha key is hashed with configBean's defaultHashAlgorithm, CFMX_COMPAT.
  if (values.hkey !== '' && !cfEq(values.hkey, cfHash(values.ukey, 'CFMX_COMPAT'))) {
    errors.SecurityCode = rb(values.siteid, 'captcha.error');
  }
  if (!cfToBoolean(values.passedprotect)) errors.Spam = rb(values.siteid, 'captcha.spam');
  return errors;
}

/**
 * addressBean.validate's errors (addressBean.cfc:229-240): validateExtendedData's errors appended to an empty struct,
 * in ACF order. Its geocoding sets no error and needs a site Google API key, which the registry does not carry.
 */
export function validateAddressValues(extErrors: Readonly<Record<string, string>>): LegacyErrors {
  return errorsObject(acfStructOrder(acfStructOrder(Object.entries(extErrors))));
}

/** Options of {@link requestHasRestrictedFiles}. */
export interface RestrictedFilesOptions {
  /** FM_PUBLIC_ALLOWED_EXTENSIONS for an update, FM_ALLOWED_EXTENSIONS for a create. */
  allowedExtensions: string;
  /** The site's File attribute names, matched case-sensitively as Masa's query of queries matches them. */
  fileAttributeNames: ReadonlySet<string>;
  /** The request's file parts, field name to client file name, in part order. */
  postedFiles: ReadonlyMap<string, string>;
}

/**
 * fileManager.requestHasRestrictedFiles (fileManager.cfc:656-725): whether a posted file, or a `newfile` or File
 * attribute URL, has an extension outside the list. `input` is the bean's values, scanned in legacy's struct order.
 */
export function requestHasRestrictedFiles(input: ReadonlyMap<string, unknown>, opts: RestrictedFilesOptions): boolean {
  if (opts.allowedExtensions === '') return false;
  // Legacy's struct also holds bean-internal keys, so ~40 extra fields can resize it elsewhere and reorder collisions.
  for (const [key, value] of acfStructOrder(input)) {
    if (!isSimpleValue(value)) continue;
    const clientFileName = postedClientFileName(opts.postedFiles, key);
    if (clientFileName !== undefined) {
      const ext = cfListLast(clientFileName, '.');
      if (ext.length > 0 && ext.length < 5 && !cfListFindNoCase(opts.allowedExtensions, ext)) return true;
    }
    if (typeof value !== 'string' || !cfIsValidUrl(value) || value.endsWith('/')) continue;
    // Masa breaks out of the whole scan at the first URL value that is neither `newfile` nor a File attribute.
    if (key.toLowerCase() !== 'newfile' && !opts.fileAttributeNames.has(key)) break;
    // reReplaceNoCase(v, '(http://||https://)', '') strips only a leading http://: the empty alternative matches first.
    const unprefixed = /^http:\/\//i.test(value) ? value.slice(7) : value;
    if (cfListItems(unprefixed, '/').length === 1) break;
    const ext = cfListLast(cfListLast(cfListFirst(value, '?'), '/'), '.');
    if (ext.length < 5 && !cfListFindNoCase(opts.allowedExtensions, ext)) return true;
  }
  return false;
}

/** The parts of a Type=2 save's errors struct, each in the order its producer set it. */
export interface UserErrorParts {
  /** validateExtendedData's errors. */
  extended: Readonly<LegacyErrors>;
  /** Identity's prepare errors (`password`, `username`, …), unchanged. */
  identity?: Readonly<LegacyErrors>;
  /** validatePersonValues' errors. */
  people: Readonly<LegacyErrors>;
  /** requestHasRestrictedFiles' answer. */
  restrictedFiles?: boolean;
  /** The user's site id, whose bundle gives the restricted-file message; '' when omitted. */
  siteId?: string;
}

/**
 * The errors struct of a Type=2 save, set in legacy's order (extended data, identity's checks, people's checks, the
 * restricted-file flag; userBean.cfc:458-511, userManager.cfc:476-479, 617-620) and keyed in ACF's iteration order.
 * `rb` gives the restricted-file text of the user's site bundle.
 */
export function mergeUserErrors(parts: UserErrorParts, rb: PeopleMessages = enPeopleMessages): LegacyErrors {
  const sequence: Array<[string, string | LegacyErrors]> = [
    ...acfStructOrder(Object.entries(parts.extended)),
    ...Object.entries(parts.identity ?? {}),
    ...Object.entries(parts.people),
  ];
  if (parts.restrictedFiles === true) {
    sequence.push(['requestHasRestrictedFiles', rb(parts.siteId ?? '', 'sitemanager.requesthasrestrictedfiles')]);
  }
  return errorsObject(acfStructOrder(sequence));
}

/** `not structIsEmpty(errors)`. */
export function hasErrors(errors: Readonly<LegacyErrors>): boolean {
  return Object.keys(errors).length > 0;
}

