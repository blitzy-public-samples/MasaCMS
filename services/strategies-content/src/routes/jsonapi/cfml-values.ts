/** ACF 2023 values the JSON API `validate` reads: case-insensitive structs, JSON numbers with their CFML text, isJSON/deserializeJSON and urlDecode. */
import { LegacyServiceUnavailableError, acfKeyOrder, cfNumberString, javaTrim } from '@opt2/platform/legacy-compat';

/** Exceptions-list entry of the `validate` cases strategies-content cannot reproduce. */
export const VALIDATE_EXCEPTION = 'EX-CONTENT-VALIDATE';

/** The legacy 503 of a halted `validate` case, naming its exceptions entry. */
export function validateHalted(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} stays on legacy (${VALIDATE_EXCEPTION})`, 'auto', reason);
}

/** A number as CFML holds it: its value and the text CFML converts it to; undefined text where ACF's conversion is not reproduced. */
export class CfNumber {
  constructor(
    readonly text: string | undefined,
    readonly value: number,
  ) {}
}

/** A query value, such as a bean getter returns; JSON never yields one. */
export const CF_QUERY: unique symbol = Symbol('cf-query');

/** A CFML value: simple text, a number, a boolean, an array (JSON nulls as null elements), a struct or a query. */
export type CfValue = string | CfNumber | boolean | CfArray | CfStruct | typeof CF_QUERY;
export type CfArray = Array<CfValue | null>;

/** A CFML struct: keys match ignoring case and keep their first spelling; a JSON null leaves a key no lookup finds. */
export class CfStruct {
  readonly #entries = new Map<string, { key: string; value: CfValue | null }>();

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

  /** `for (key in struct)`: every key, JSON nulls included, in ACF's iteration order. */
  keys(): string[] {
    return acfKeyOrder(this.assigned().map((key) => ['set', key] as const));
  }

  /** Every key in the order it was first assigned. */
  assigned(): string[] {
    return [...this.#entries.values()].map((entry) => entry.key);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Whether `value` is a CFML simple value. */
export function isSimple(value: CfValue | null | undefined): value is string | CfNumber | boolean {
  return typeof value === 'string' || typeof value === 'boolean' || value instanceof CfNumber;
}

/** A simple value as CFML text: booleans read `YES` and `NO`; a number whose ACF text is not reproduced halts. */
export function simpleText(value: string | CfNumber | boolean): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'YES' : 'NO';
  if (value.text === undefined) throw validateHalted(`The CFML text of the number ${String(value.value)}`, 'validate-number-text');
  return value.text;
}

/** Doubles at or beyond this magnitude convert to text ACF formats unlike cfNumberString (oracle-measured). */
const DOUBLE_TEXT_LIMIT = 1e12;

/** A number of `value` as CFML holds a Java double. */
export function doubleOf(value: number): CfNumber {
  return new CfNumber(Math.abs(value) >= DOUBLE_TEXT_LIMIT ? undefined : cfNumberString(value), value);
}

/** A JavaScript value of a JSON request body or a stored row, as CFML holds it. */
export function cfValueOf(value: unknown): CfValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? new CfNumber(String(value), value) : doubleOf(value);
  if (typeof value === 'bigint') return new CfNumber(value.toString(), Number(value));
  if (Array.isArray(value)) return value.map(cfValueOf);
  if (typeof value === 'object') {
    const struct = new CfStruct();
    for (const [key, member] of Object.entries(value)) struct.set(key, cfValueOf(member));
    return struct;
  }
  throw new TypeError(`A ${typeof value} value has no CFML form`);
}

/** Text isJSON accepts but deserializeJSON does not read as written: a number whose exponent has no digits. */
export const UNREADABLE_JSON: unique symbol = Symbol('validate.unreadable-json');

const LONG_MIN = -(2n ** 63n);
const LONG_MAX = 2n ** 63n - 1n;
/** The JSON number syntax isJSON accepts: leading zeros, `-.5`, and an exponent without digits. */
const NUMBER_TOKEN = /(?:-?\d+(?:\.\d+)?|-\.\d+)(?:[eE][+-]?(\d*))?/y;
const TEXT_RUN = /[^"\\]*/y;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', "'": "'", b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** Thrown inside the reader for text isJSON rejects. */
class NotJson extends Error {}

/** A reader of the JSON ACF's isJSON accepts, building CFML values; whitespace inside is space, \b, \t, \n, \f or \r only. */
class JsonReader {
  #at = 0;
  /** Whether isJSON accepts a token deserializeJSON then rejects. */
  unreadable = false;

  constructor(private readonly text: string) {}

  read(): CfValue | null {
    const value = this.#value();
    if (this.#at !== this.text.length) throw new NotJson();
    return value;
  }

  #space(): void {
    while (this.#at < this.text.length && ' \t\n\r\f\b'.includes(this.text.charAt(this.#at))) this.#at += 1;
  }

  #literal(word: string, value: boolean | null): boolean | null {
    if (!this.text.startsWith(word, this.#at)) throw new NotJson();
    this.#at += word.length;
    return value;
  }

  #value(): CfValue | null {
    const ch = this.text.charAt(this.#at);
    if (ch === '{') return this.#struct();
    if (ch === '[') return this.#array();
    if (ch === '"') return this.#string();
    if (ch === 't') return this.#literal('true', true);
    if (ch === 'f') return this.#literal('false', false);
    if (ch === 'n') return this.#literal('null', null);
    return this.#number();
  }

  #number(): CfNumber {
    NUMBER_TOKEN.lastIndex = this.#at;
    const match = NUMBER_TOKEN.exec(this.text);
    if (match === null) throw new NotJson();
    const [token, exponentDigits] = match;
    this.#at += token.length;
    // The text ending right after the exponent letter is no JSON to isJSON, though `1e]` or a final `1e+` is.
    if (/[eE]$/.test(token) && this.#at === this.text.length) throw new NotJson();
    const emptyExponent = exponentDigits === '';
    if (!Number.isFinite(Number(emptyExponent ? `${token}0` : token))) throw new NotJson();
    if (emptyExponent) this.unreadable = true;
    if (/^-?\d+$/.test(token)) {
      const long = BigInt(token);
      if (long >= LONG_MIN && long <= LONG_MAX) return new CfNumber(long.toString(), Number(long));
    }
    return doubleOf(Number(token));
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

  #array(): CfArray {
    const items: CfArray = [];
    this.#members(']', () => items.push(this.#value()));
    return items;
  }

  #struct(): CfStruct {
    const struct = new CfStruct();
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

/** `isJSON(text) ? deserializeJSON(text) : undefined`; {@link UNREADABLE_JSON} where only isJSON accepts the text. */
export function deserializeCfJson(text: string): CfValue | null | typeof UNREADABLE_JSON | undefined {
  const reader = new JsonReader(javaTrim(text));
  try {
    const value = reader.read();
    return reader.unreadable ? UNREADABLE_JSON : value;
  } catch (err) {
    if (err instanceof NotJson) return undefined;
    throw err;
  }
}

/** CFML `urlDecode`: `+` is a space and `%XX` runs are UTF-8; a `%` that starts no escape stays; bytes that are not UTF-8 halt. */
export function cfUrlDecode(text: string): string {
  return text.replaceAll('+', ' ').replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      throw validateHalted('A urlDecode of bytes that are not UTF-8', 'validate-urldecode');
    }
  });
}
