/** ACF 2023 struct and `deserializeJSON` semantics the JSON API routes reproduce: struct key order, case-insensitive keys and JSON values. */
import { cfNumberString } from '@opt2/platform/legacy-compat';

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

/** A JSON number as `deserializeJSON` holds it: the text CFML converts it to, and its value. */
export class CfNumber {
  constructor(
    readonly text: string,
    readonly value: number,
  ) {}
}

/** A query value, such as userBean `getAddresses()` returns; JSON never yields one. */
export const CF_QUERY: unique symbol = Symbol('cf-query');

/** A CFML value: simple text, a number, a boolean, an array (whose JSON nulls are undefined elements), a struct or a query. */
export type CfValue = string | CfNumber | boolean | CfArray | CfStruct | typeof CF_QUERY;
export type CfArray = Array<CfValue | null>;

/**
 * A CFML struct: keys match ignoring case and keep their first spelling; a JSON null leaves a key no lookup finds. A struct
 * `deserializeJSON` builds iterates in insertion order; one CFML code builds iterates in ACF's hash order.
 */
export class CfStruct {
  readonly #entries = new Map<string, { key: string; value: CfValue | null }>();

  constructor(readonly ordered = false) {}

  /** `struct[key] = value`; null as `deserializeJSON` stores a JSON null. */
  set(key: string, value: CfValue | null): void {
    const upper = key.toUpperCase();
    const entry = this.#entries.get(upper);
    if (entry === undefined) this.#entries.set(upper, { key, value });
    else entry.value = value;
  }

  /** The value of `key`; null for a JSON null, undefined for no key. */
  get(key: string): CfValue | null | undefined {
    return this.#entries.get(key.toUpperCase())?.value;
  }

  /** `structKeyExists`: false for a JSON null. */
  has(key: string): boolean {
    const value = this.get(key);
    return value !== null && value !== undefined;
  }

  /** `for (key in struct)`: every key, JSON nulls included, in the struct's iteration order. */
  keys(): string[] {
    const keys = [...this.#entries.values()].map((entry) => entry.key);
    return this.ordered ? keys : acfStructKeyOrder(keys);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Whether `value` is a CFML simple value. */
export function isSimple(value: CfValue | null | undefined): value is string | CfNumber | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || value instanceof CfNumber;
}

/** A simple value as CFML text: booleans read `YES` and `NO`. */
export function simpleText(value: string | CfNumber | boolean): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  return value.text;
}

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;

/** A JSON number literal as `deserializeJSON` holds it: an integer within a Java long exactly, any other one as a double. */
function jsonNumber(literal: string): CfNumber {
  if (/^-?\d+$/.test(literal)) {
    const big = BigInt(literal);
    if (big >= LONG_MIN && big <= LONG_MAX) return new CfNumber(big.toString(), Number(big));
  }
  const value = Number(literal);
  return new CfNumber(cfNumberString(value), value);
}

/** A strict JSON reader that keeps object key order and number text, as `isJSON` and `deserializeJSON` read the text. */
class JsonReader {
  #at = 0;

  constructor(readonly text: string) {}

  /** The whole text as one JSON value; undefined when it is not JSON. */
  read(): CfValue | null | undefined {
    try {
      const value = this.#value();
      this.#space();
      return this.#at === this.text.length ? value : undefined;
    } catch (err) {
      if (err instanceof SyntaxError) return undefined;
      throw err;
    }
  }

  #space(): void {
    while (this.#at < this.text.length && ' \t\n\r'.includes(this.text.charAt(this.#at))) this.#at += 1;
  }

  #expect(token: string): void {
    if (!this.text.startsWith(token, this.#at)) throw new SyntaxError(`expected ${token}`);
    this.#at += token.length;
  }

  #value(): CfValue | null {
    this.#space();
    const ch = this.text.charAt(this.#at);
    if (ch === '{') return this.#object();
    if (ch === '[') return this.#array();
    if (ch === '"') return this.#string();
    if (this.text.startsWith('true', this.#at)) {
      this.#at += 4;
      return true;
    }
    if (this.text.startsWith('false', this.#at)) {
      this.#at += 5;
      return false;
    }
    if (this.text.startsWith('null', this.#at)) {
      this.#at += 4;
      return null;
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.#at));
    if (match === null) throw new SyntaxError('expected a value');
    this.#at += match[0].length;
    return jsonNumber(match[0]);
  }

  #object(): CfStruct {
    const struct = new CfStruct(true);
    this.#expect('{');
    this.#space();
    if (this.text.charAt(this.#at) === '}') {
      this.#at += 1;
      return struct;
    }
    for (;;) {
      this.#space();
      const key = this.#string();
      this.#space();
      this.#expect(':');
      struct.set(key, this.#value());
      this.#space();
      if (this.text.charAt(this.#at) === ',') {
        this.#at += 1;
        continue;
      }
      this.#expect('}');
      return struct;
    }
  }

  #array(): CfArray {
    const items: CfArray = [];
    this.#expect('[');
    this.#space();
    if (this.text.charAt(this.#at) === ']') {
      this.#at += 1;
      return items;
    }
    for (;;) {
      items.push(this.#value());
      this.#space();
      if (this.text.charAt(this.#at) === ',') {
        this.#at += 1;
        continue;
      }
      this.#expect(']');
      return items;
    }
  }

  #string(): string {
    this.#expect('"');
    let out = '';
    for (;;) {
      const ch = this.text.charAt(this.#at);
      if (ch === '') throw new SyntaxError('unterminated string');
      this.#at += 1;
      if (ch === '"') return out;
      if (ch < ' ') throw new SyntaxError('control character in string');
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const escape = this.text.charAt(this.#at);
      this.#at += 1;
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape in simple) out += simple[escape];
      else if (escape === 'u' && /^[0-9A-Fa-f]{4}$/.test(this.text.slice(this.#at, this.#at + 4))) {
        out += String.fromCharCode(Number.parseInt(this.text.slice(this.#at, this.#at + 4), 16));
        this.#at += 4;
      } else throw new SyntaxError('bad escape');
    }
  }
}

/** `isJSON(text) ? deserializeJSON(text) : undefined`; a JSON null reads as null. */
export function deserializeCfJson(text: string): CfValue | null | undefined {
  return new JsonReader(text).read();
}
