import { REDACTED, redactText } from '@opt2/platform/logging';
import type { EnvLike } from './paths.js';

/** Shortest environment value masked as a known secret, so ordinary short words stay readable. */
export const MIN_SECRET_LENGTH = 6;

/** Kind `jsonSyntaxDetail` reports for a JSON.parse failure that quotes its input. */
export const UNEXPECTED_TOKEN = 'Unexpected token in JSON';

// `pwd` is left out: PWD names the working directory.
const SECRET_NAME = /passw(?:or)?d|passphrase|secret|token|key|hmac|credential/i;

/** Name suffix of a variable or flag that holds a location rather than a secret. */
const LOCATION_NAME = /[_-](?:file|path|dir|url|uri|host|port)$/i;

/** V8 JSON.parse message naming the failure kind and its position, with an optional line and column. */
const JSON_AT_POSITION = /^([A-Z][A-Za-z ',:{}[\]-]* JSON) at position (\d+)(?: \(line (\d+) column (\d+)\))?$/;

const JSON_END = 'Unexpected end of JSON input';

/** V8 JSON.parse excerpt: an optional unexpected code unit and up to 20 code units of the input, optionally elided. */
const JSON_EXCERPT = /(?:Unexpected token '[\s\S]', )?(?:\.\.\.)?"[\s\S]{0,20}"(?:\.\.\.)? is not valid JSON/g;

/** A V8 stack frame line, which ends in `)` or `:<line>:<column>`; a quoted source line rarely does. */
const STACK_FRAME = String.raw`\n {4}at [^\n]*(?:\)|:\d+)(?=\n|$)`;

/**
 * yaml code frame after its location: the colon, blank line, one or two quoted source lines and the caret line,
 * or, when that shape is cut short, everything up to the next stack frame or the end.
 */
const YAML_FRAME = new RegExp(
  String.raw`( at line \d+, column \d+)(?::\n\n(?:(?:[^\n]*\n){1,2} *\^+\n|[\s\S]*?(?=${STACK_FRAME}|$)))+`,
  'g',
);

/** Summary keys, in any case, whose strings at any depth beneath them are diagnostics: these names, or a name ending in one of the suffixes. */
const DIAGNOSTIC_KEY = /^(?:errors?|messages?|reason|details?|diagnostics?|stderr|stdout|cause)$|(?:errors?|messages?|tail)$/i;

/** A command-line flag followed by a space-separated value, quoted or bare. */
const FLAG_VALUE = /(?<![\w-])(--?[A-Za-z][\w-]*)([ \t]+)('[^'\r\n]*'?|"[^"\r\n]*"?|[^\s"'<>-][^\s"'<>]*)/g;

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) && !LOCATION_NAME.test(name);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Values of secret-named variables in `env`, raw and JSON-escaped, longest first. */
function knownSecrets(env: EnvLike): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    // A value inside the placeholder would be matched again in its own replacement.
    if (typeof value !== 'string' || value.length < MIN_SECRET_LENGTH || REDACTED.includes(value)) continue;
    if (!isSecretName(name)) continue;
    values.add(value);
    values.add(JSON.stringify(value).slice(1, -1));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function maskText(text: string, secrets: readonly string[]): string {
  return secrets.reduce((masked, secret) => masked.split(secret).join(REDACTED), text);
}

/** `text` without JSON.parse excerpts and yaml code frames, the parts of a parser message that quote its input. */
function stripExcerpts(text: string): string {
  return text.replace(JSON_EXCERPT, UNEXPECTED_TOKEN).replace(YAML_FRAME, '$1');
}

// Both maskers strip excerpts again: masking can shorten an over-long quoted fragment into the excerpt form.

/** `text` with excerpts stripped and `secrets` masked, leaving every other character as it is. */
function maskStructural(text: string, secrets: readonly string[]): string {
  return stripExcerpts(maskText(stripExcerpts(text), secrets));
}

/** `text` with excerpts stripped and `secrets`, `redactText` credentials and secret flag values masked. */
function maskDiagnostic(text: string, secrets: readonly string[]): string {
  return stripExcerpts(redactText(maskText(stripExcerpts(text), secrets)).replace(FLAG_VALUE, maskFlag));
}

/** `value` with each string masked, by {@link maskDiagnostic} when `diagnostic` and structurally otherwise; copies a part only when it changes. */
function maskDeep(value: unknown, secrets: readonly string[], diagnostic: boolean, ancestors: Set<object>): unknown {
  if (typeof value === 'string') return diagnostic ? maskDiagnostic(value, secrets) : maskStructural(value, secrets);
  // A cycle keeps its original reference, so JSON.stringify still reports it as circular.
  if (value === null || typeof value !== 'object' || ancestors.has(value)) return value;
  if (!Array.isArray(value) && !isPlainObject(value)) return value;
  ancestors.add(value);
  let changed = false;
  const masked = Array.isArray(value)
    ? value.map((item: unknown) => {
        const safe = maskDeep(item, secrets, diagnostic, ancestors);
        changed ||= safe !== item;
        return safe;
      })
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => {
          const safeKey = maskStructural(key, secrets);
          const safe = maskDeep(item, secrets, diagnostic || DIAGNOSTIC_KEY.test(key), ancestors);
          changed ||= safeKey !== key || safe !== item;
          return [safeKey, safe];
        }),
      );
  ancestors.delete(value);
  return changed ? masked : value;
}

function maskFlag(match: string, flag: string, gap: string, value: string): string {
  if (!isSecretName(flag)) return match;
  const quote = /^["']/.exec(value)?.[0] ?? '';
  return `${flag}${gap}${quote}${REDACTED}${quote}`;
}

/** Structural description of a JSON.parse failure, its kind and line and column, that quotes none of the input. */
export function jsonSyntaxDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : '';
  const at = JSON_AT_POSITION.exec(message);
  if (at !== null) {
    return `${at[1]} at ${at[3] === undefined ? `position ${at[2]}` : `line ${at[3]} column ${at[4]}`}`;
  }
  return message === JSON_END ? message : UNEXPECTED_TOKEN;
}

/** `text` with JSON.parse excerpts, yaml code frames, secret `env` values, `redactText` credentials and secret flag values masked; idempotent, REDACTED instead of throwing. */
export function safeDiagnostic(text: string, env: EnvLike = process.env): string {
  try {
    return maskDiagnostic(text, knownSecrets(env));
  } catch {
    return REDACTED;
  }
}

/**
 * `value` with parser excerpts stripped and secret `env` values masked in every string and plain-object key, and
 * strings beneath a diagnostic-named key masked as {@link safeDiagnostic} does; copies a part only when it changes.
 */
export function safeSummary<T>(value: T, env: EnvLike = process.env): T {
  return maskDeep(value, knownSecrets(env), false, new Set()) as T;
}
