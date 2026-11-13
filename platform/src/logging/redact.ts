/** Placeholder written in place of a masked value. */
export const REDACTED = '[REDACTED]';

// Every quantifier is bounded, stops at a delimiter its own class excludes, or repeats the pair `25` after its own `%`,
// so each pattern runs in linear time.

/** SQL `PASSWORD '...'` literal, doubled quotes included; an unterminated literal runs to the end of the text. */
const SQL_PASSWORD = /\b(PASSWORD\s+)'(?:[^']|'')*'?/gi;

/** Credential header name with `:` or `=`, masked to the end of the line. */
const CREDENTIAL_HEADER = /\b((?:proxy-|x-serverless-)?authorization|(?:set-)?cookie)([ \t]*[:=][ \t]*)[^\r\n]*/gi;

/** HTTP authentication scheme followed by its credentials. */
const AUTH_SCHEME = /\b([Bb]earer|Basic|Digest|Negotiate)([ \t]+)[^\s"'<>]+/g;

/** JSON Web Token: base64url header, payload and optional signature. */
const JWT = /\beyJ[\w-]+\.[\w-]+\.[\w-]*/g;

/** URL userinfo up to the last `@` of the authority. */
const URL_USERINFO = /\b([a-z][a-z\d+.-]{0,31}:\/\/)[^\s/?#"'<>]+@/gi;

/** Value of a URL query or fragment parameter. */
const URL_PARAM = /([?&#][^\s=&#?"'<>]+=)[^\s&#"'<>]+/g;

/** Regex source matching an ASCII pattern in any letter case, so the rest of the expression can stay case-sensitive. */
function anyCase(pattern: string): string {
  return pattern.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

// Names in the first group also match as the suffix of a longer identifier (`newPassword`, `accessToken`).
const SECRET_SUFFIX = anyCase(String.raw`csrf[_-]?token[_-]?expires|passw(?:or)?d|pwd|secret|token|key|session[_-]?id|hmac|authorization|cookie`);
const SECRET_WORD = anyCase(String.raw`session|sig|cfid`);
// A percent escape (`%26`, re-encoded `%2526`) is a key boundary in encoded text; it stays in the name group, so it is kept.
const ESCAPE = String.raw`%(?:25)*[\dA-Fa-f]{2}`;
// `signature` only at a key boundary or camelCase hump (`oauth_signature`, `webhookSignature`), never inside a word (`esignature`).
const SECRET_KEY = String.raw`(?:(?<![A-Za-z\d])|${ESCAPE})${anyCase('signature')}|(?<=[A-Za-z\d])Signature`;
// Percent-encoded `:` or `=` after an optional encoded quote, re-encoding included (`%3D`, `%22%3A`, `%253d`).
const ENCODED_SEPARATOR = String.raw`(?:%(?:25)*2[27])?%(?:25)*3[aAdD]`;
const SECRET_VALUE = String.raw`\\"[^"\\\r\n]*(?:\\")?|"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\r\n]|'')*'?|\[[^\]\r\n]*\]?|[^\s&;,"'<>{}]+`;

/** `name=value`, `name: value` or JSON `"name":"value"` whose name denotes a secret, its punctuation literal or percent-encoded. */
const SECRET_PAIR = new RegExp(
  String.raw`((?:${SECRET_SUFFIX})|${SECRET_KEY}|(?:\b|${ESCAPE})(?:${SECRET_WORD}))\b(\\?["']?[ \t]*[:=][ \t]*|${ENCODED_SEPARATOR})(${SECRET_VALUE})`,
  'g',
);

/** Email address, with its `@` literal or percent-encoded, re-encoding included (`%2540`). */
const EMAIL = /(?<![\w.%+-])[\w.%+-]{1,64}(?:@|%(?:25)*40)[a-z\d.-]{1,253}\.[a-z]{2,63}/gi;

/** Double-quoted fragment of error text, where databases and parsers echo rejected input; `close` is empty when unterminated. */
const ERROR_QUOTE = /"(?:[^"\\\r\n]|\\.)*("?)/g;

/** Replaces a secret value, keeping the quotes it was written in. */
function maskSecret(_match: string, name: string, separator: string, value: string): string {
  const quote = /^\\?["']/.exec(value)?.[0] ?? '';
  return `${name}${separator}${quote}${REDACTED}${quote}`;
}

/** Masks credentials, session material and email addresses in free text; idempotent. */
export function redactText(text: string): string {
  return text
    .replace(SQL_PASSWORD, `$1'${REDACTED}'`)
    .replace(CREDENTIAL_HEADER, `$1$2${REDACTED}`)
    .replace(AUTH_SCHEME, `$1$2${REDACTED}`)
    .replace(JWT, REDACTED)
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_PARAM, `$1${REDACTED}`)
    .replace(SECRET_PAIR, maskSecret)
    .replace(EMAIL, REDACTED);
}

/** Masks each terminated double-quoted fragment. */
function maskQuoted(text: string): string {
  return text.replace(ERROR_QUOTE, (fragment: string, close: string) => (close ? `"${REDACTED}"` : fragment));
}

/** Masks double-quoted fragments of error text, then `redactText`, then fragments whose escaping backslash it masked; idempotent. */
export function redactErrorText(text: string): string {
  return maskQuoted(redactText(maskQuoted(text)));
}
