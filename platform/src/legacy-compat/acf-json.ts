// ACF 2023 isJSON, deserializeJSON and serializeJSON as Masa's Portcullis stripMSWord round-trips a url or form value.
import { javaDoubleToString } from './java-double.js';
import { javaTrim, jsonString } from './serializer.js';

/** A deserialized JSON value: a Java long as bigint, a Java double as number, a struct, an array, text, a boolean or null. */
export type AcfJsonValue = string | boolean | bigint | number | null | AcfBigDecimal | AcfJsonValue[] | AcfStruct;

/** A number beyond the double range, which deserializeJSON keeps as written (coldfusion.runtime.CFBigDecimal). */
export class AcfBigDecimal {
  constructor(readonly text: string) {}
}

/** Java String.hashCode. */
function javaHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

type Bin = Array<readonly [key: string, hash: number]>;

/** ConcurrentHashMap.transfer for one thread: each bin splits into its low and high halves. */
function transfer(bins: readonly Bin[], n: number): Bin[] {
  const next: Bin[] = Array.from({ length: n * 2 }, () => []);
  bins.forEach((bin, i) => {
    const first = bin[0];
    if (first === undefined) return;
    // The trailing run of nodes bound for one half moves as is; the nodes before it are prepended in turn.
    let runBit = first[1] & n;
    let lastRun = 0;
    bin.forEach(([, hash], p) => {
      if ((hash & n) !== runBit) {
        runBit = hash & n;
        lastRun = p;
      }
    });
    let low: Bin = runBit === 0 ? bin.slice(lastRun) : [];
    let high: Bin = runBit === 0 ? [] : bin.slice(lastRun);
    for (const node of bin.slice(0, lastRun)) {
      if ((node[1] & n) === 0) low = [node, ...low];
      else high = [node, ...high];
    }
    next[i] = low;
    next[i + n] = high;
  });
  return next;
}

/** ACF 2023 struct iteration order for keys assigned in `keys` order (ConcurrentHashMap of upper-cased names, 16 bins, 0.75 load). */
export function acfStructKeyOrder(keys: readonly string[]): string[] {
  let size = 16;
  let bins: Bin[] = Array.from({ length: size }, () => []);
  const seen = new Set<string>();
  for (const key of keys) {
    const upper = key.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    const h = javaHash(upper);
    const hash = (h ^ (h >>> 16)) & 0x7fffffff;
    (bins[hash & (size - 1)] as Bin).push([key, hash]);
    if (seen.size >= size - (size >>> 2)) {
      bins = transfer(bins, size);
      size *= 2;
    }
  }
  return bins.flat().map(([key]) => key);
}

/** A struct deserializeJSON builds: keys match ignoring case, keep their first spelling and take the last value. */
export class AcfStruct {
  readonly #entries = new Map<string, { key: string; value: AcfJsonValue }>();

  set(key: string, value: AcfJsonValue): void {
    const upper = key.toUpperCase();
    const entry = this.#entries.get(upper);
    if (entry === undefined) this.#entries.set(upper, { key, value });
    else entry.value = value;
  }

  /** Entries in ACF's struct iteration order. */
  entries(): Array<[key: string, value: AcfJsonValue]> {
    return acfStructKeyOrder([...this.#entries.values()].map(({ key }) => key)).map((key) => [
      key,
      (this.#entries.get(key.toUpperCase()) as { value: AcfJsonValue }).value,
    ]);
  }
}

/** Text deserializeJSON cannot read although isJSON accepts it: a number whose exponent has no digits, such as `1e`. */
export const UNREADABLE_JSON: unique symbol = Symbol('acf-json.unreadable');

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
/** The largest exponent BigDecimal reads. */
const BIG_DECIMAL_EXPONENT_MAX = 2n ** 31n - 1n;
/** The JSON number syntax isJSON accepts: leading zeros, `-.5`, and an exponent without digits. */
const NUMBER_TOKEN = /(?:-?\d+(?:\.\d+)?|-\.\d+)(?:[eE]([+-]?)(\d*))?/y;
const INTEGER_TOKEN = /^-?\d+$/;
const TEXT_RUN = /[^"\\]*/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  "'": "'",
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** Thrown inside the reader for text isJSON rejects. */
class NotJson extends Error {}

/** A strict reader of the JSON ACF's isJSON accepts: whitespace inside is space, \b, \t, \n, \f or \r only. */
class AcfJsonReader {
  #at = 0;
  /** Whether isJSON accepts a token deserializeJSON then rejects. */
  unreadable = false;

  constructor(private readonly text: string) {}

  /** The whole text as one JSON value. */
  read(): AcfJsonValue {
    const value = this.#value();
    if (this.#at !== this.text.length) throw new NotJson();
    return value;
  }

  #space(): void {
    for (;;) {
      const ch = this.text.charAt(this.#at);
      if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f' && ch !== '\b') return;
      this.#at += 1;
    }
  }

  #literal(word: string, value: AcfJsonValue): AcfJsonValue {
    if (!this.text.startsWith(word, this.#at)) throw new NotJson();
    this.#at += word.length;
    return value;
  }

  #value(): AcfJsonValue {
    const ch = this.text.charAt(this.#at);
    if (ch === '{') return this.#struct();
    if (ch === '[') return this.#array();
    if (ch === '"') return this.#string();
    if (ch === 't') return this.#literal('true', true);
    if (ch === 'f') return this.#literal('false', false);
    if (ch === 'n') return this.#literal('null', null);
    return this.#number();
  }

  #number(): bigint | number | AcfBigDecimal {
    NUMBER_TOKEN.lastIndex = this.#at;
    const match = NUMBER_TOKEN.exec(this.text);
    if (match === null) throw new NotJson();
    const [token, exponentSign, exponentDigits] = match;
    this.#at += token.length;
    // The text ending right after the exponent letter is no JSON to isJSON, though `1e]` or a final `1e+` is.
    if (/[eE]$/.test(token) && this.#at === this.text.length) throw new NotJson();
    // isJSON accepts an exponent without digits, which deserializeJSON cannot read.
    if (exponentDigits === '') this.unreadable = true;
    if (INTEGER_TOKEN.test(token)) {
      const long = BigInt(token);
      if (long >= LONG_MIN && long <= LONG_MAX) return long;
    }
    const double = Number(token);
    if (Number.isFinite(double) || this.unreadable) return double;
    if (exponentSign !== '-' && exponentDigits !== undefined && BigInt(exponentDigits) > BIG_DECIMAL_EXPONENT_MAX) this.unreadable = true;
    return new AcfBigDecimal(token);
  }

  #string(): string {
    this.#at += 1;
    let out = '';
    for (;;) {
      TEXT_RUN.lastIndex = this.#at;
      const run = (TEXT_RUN.exec(this.text) as RegExpExecArray)[0];
      out += run;
      this.#at += run.length;
      const ch = this.text.charAt(this.#at);
      if (ch === '') throw new NotJson();
      this.#at += 1;
      if (ch === '"') return out;
      const escape = this.text.charAt(this.#at);
      this.#at += 1;
      const simple = ESCAPES[escape];
      if (simple !== undefined) {
        out += simple;
      } else if (escape === 'u' && HEX4.test(this.text.slice(this.#at, this.#at + 4))) {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.#at, this.#at + 4), 16));
        this.#at += 4;
      } else {
        throw new NotJson();
      }
    }
  }

  /** The `,`-separated members up to `close`, each read by `member` after leading whitespace. */
  #members(close: string, member: () => void): void {
    this.#at += 1;
    this.#space();
    if (this.text.charAt(this.#at) === close) {
      this.#at += 1;
      return;
    }
    for (;;) {
      member();
      this.#space();
      const ch = this.text.charAt(this.#at);
      this.#at += 1;
      if (ch === close) return;
      if (ch !== ',') throw new NotJson();
      this.#space();
    }
  }

  #array(): AcfJsonValue[] {
    const items: AcfJsonValue[] = [];
    this.#members(']', () => items.push(this.#value()));
    return items;
  }

  #struct(): AcfStruct {
    const struct = new AcfStruct();
    this.#members('}', () => {
      if (this.text.charAt(this.#at) !== '"') throw new NotJson();
      const key = this.#string();
      this.#space();
      if (this.text.charAt(this.#at) !== ':') throw new NotJson();
      this.#at += 1;
      this.#space();
      struct.set(key, this.#value());
    });
    return struct;
  }
}

/** ACF `isJSON(text) ? deserializeJSON(text) : undefined`, or {@link UNREADABLE_JSON} where only isJSON accepts the text. */
export function readAcfJson(text: string): AcfJsonValue | typeof UNREADABLE_JSON | undefined {
  const reader = new AcfJsonReader(javaTrim(text));
  let value: AcfJsonValue;
  try {
    value = reader.read();
  } catch (err) {
    if (err instanceof NotJson) return undefined;
    throw err;
  }
  return reader.unreadable ? UNREADABLE_JSON : value;
}

/** ACF serializeJSON of a deserialized value: longs as digits, doubles as Java prints them, big decimals as written, structs in ACF key order. */
export function serializeAcfJson(value: AcfJsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return jsonString(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return javaDoubleToString(value);
  if (value instanceof AcfBigDecimal) return value.text;
  if (Array.isArray(value)) return `[${value.map(serializeAcfJson).join(',')}]`;
  return `{${value
    .entries()
    .map(([key, member]) => `${jsonString(key)}:${serializeAcfJson(member)}`)
    .join(',')}}`;
}
