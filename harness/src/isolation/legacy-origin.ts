// Finds absolute and scheme-relative URLs naming the legacy origin's port in responses forwarded by the gateway.
import type { HttpResult } from '../lib/http.js';

/** One URL naming the legacy port; `where` is `hop <n> <header>` or `body`. */
export interface LegacyPortReference {
  where: string;
  url: string;
}

type Decoder = (match: string, code: string) => string;

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' };
const MAX_CODE_POINT = 0x10ffff;

/** The character of an HTML numeric reference, or `match` unchanged when `code` is no code point. */
function fromReference(code: number, match: string): string {
  return code <= MAX_CODE_POINT ? String.fromCodePoint(code) : match;
}

const fromHex: Decoder = (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16));

// JavaScript \xHH and \uHHHH, JSON \/, HTML numeric and named references, then percent-encoding.
const DECODERS: readonly (readonly [RegExp, Decoder])[] = [
  [/\\x([0-9a-fA-F]{2})/g, fromHex],
  [/\\u([0-9a-fA-F]{4})/g, fromHex],
  [/\\\//g, () => '/'],
  [/&#[xX]([0-9a-fA-F]+);/g, (match, hex) => fromReference(Number.parseInt(hex, 16), match)],
  [/&#([0-9]+);/g, (match, decimal) => fromReference(Number(decimal), match)],
  [/&(colon|sol);/g, (_match, name) => (name === 'colon' ? ':' : '/')],
  [/%([0-9a-fA-F]{2})/g, fromHex],
];

/** `text` with every supported escape decoded until none is left, so nested encodings unwrap. */
function decodeEscapes(text: string): string {
  let current = text;
  for (let previous = ''; previous !== current; ) {
    previous = current;
    current = DECODERS.reduce((value, [pattern, decode]) => value.replace(pattern, decode), current);
  }
  return current;
}

/** `[scheme:]//[userinfo@]host:<port>[path]` for `legacyOrigin`'s explicit or scheme-default port. */
function referencePattern(legacyOrigin: string): RegExp {
  const origin = new URL(legacyOrigin);
  const port = origin.port === '' ? DEFAULT_PORTS[origin.protocol] : origin.port;
  if (port === undefined) throw new Error(`legacy origin ${legacyOrigin} names no port and has no default one`);
  const host = String.raw`(?:\[[^\]\s/]+\]|[a-z0-9_.-]+)`;
  const userinfo = String.raw`(?:[^\s/?#@"'<>\\]+@)?`;
  const path = String.raw`(?:[/?#][^\s"'\x60<>()\\]*)?`;
  return new RegExp(String.raw`(?:[a-z][a-z0-9+.-]*:)?//${userinfo}${host}:${port}(?![0-9])${path}`, 'gi');
}

/** Every URL naming `legacyOrigin`'s port in the headers of each hop of `result` and in its final body. */
export function legacyPortReferences(result: HttpResult, legacyOrigin: string): LegacyPortReference[] {
  const pattern = referencePattern(legacyOrigin);
  const sources: [string, string][] = [];
  result.hops.forEach((hop, index) => {
    const headers = { ...(hop.location === undefined ? {} : { location: hop.location }), ...hop.responseHeaders };
    for (const [name, value] of Object.entries(headers)) {
      for (const item of typeof value === 'string' ? [value] : value) sources.push([`hop ${index + 1} ${name}`, item]);
    }
  });
  sources.push(['body', result.text]);
  return sources.flatMap(([where, text]) => [...decodeEscapes(text).matchAll(pattern)].map(([url]) => ({ where, url })));
}
