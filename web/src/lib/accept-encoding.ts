// Undertow's `identity` content negotiation as one pattern, for the response builders.
const WS = '[\\x00-\\x20]';
const PARAM = '[^,;]*';
const VISIBLE = '[^,;\\x00-\\x20]';

/** A parameter that, Java-trimmed, does not start with `q=`. */
const OTHER_PARAM = `(?!${WS}*q=)${PARAM}`;

/** Lookahead after `q=`: character 0, 2, 3 or 4 of the Java-trimmed q value is not `0` (Undertow `isQValueZero`). */
const NONZERO_Q = `(?=(?:[^,;]{2,4})?(?:[^0,;\\x00-\\x20]|${WS}${PARAM}${VISIBLE}))`;

/** A `q=` parameter whose value is not zero. */
const NONZERO_Q_PARAM = `${WS}*q=${NONZERO_Q}${PARAM}`;

/** An `identity` or `*` element whose first `q=` parameter, if any, is not zero. */
const IDENTITY_ELEMENT = `${WS}*(?:identity|\\*)${WS}*(?:;${OTHER_PARAM})*(?:;${NONZERO_Q_PARAM}(?:;${PARAM})*)?`;

/** `Accept-Encoding` values that negotiate `identity`, unanchored. */
const IDENTITY_ACCEPT_ENCODING = `(?:[^,]*,)*${IDENTITY_ELEMENT}(?:,[\\s\\S]*)?`;

const IDENTITY_ACCEPT_ENCODING_RE = new RegExp(`^${IDENTITY_ACCEPT_ENCODING}$`);

/** True when `Accept-Encoding` negotiates `identity`: an `identity` or `*` element whose q is not zero. */
export function negotiatesIdentityEncoding(acceptEncoding: string | null | undefined): boolean {
  return acceptEncoding !== null && acceptEncoding !== undefined && IDENTITY_ACCEPT_ENCODING_RE.test(acceptEncoding);
}
