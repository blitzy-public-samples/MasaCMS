// toauthtokens.data: the ACF serializeJSON(getSession()) text jsonApiUtility.cfc writes at login and appends back on token use.
import { cfDateTimeFormat } from '@opt2/platform/legacy-compat';

/** A ColdFusion value as serializeJSON sees it; a plain object is a struct, read in its own insertion order. */
export type AcfValue = string | number | boolean | Date | null | AcfValue[] | AcfStruct;

/** A ColdFusion struct; legacy resolves its keys case-insensitively. */
export type AcfStruct = { [key: string]: AcfValue };

/** Exact emitted key text, in emission order, for the session struct and its nested `mura` struct. */
export interface AcfJsonLayout {
  sessionKeys: readonly string[];
  muraKeys: readonly string[];
}

/** ACF 2023 order and casing for the REST-mode session placeholder, the only struct legacy stores (test/fixtures/legacy/oauth-token-data.json). */
export const ACF_SESSION_JSON_LAYOUT: AcfJsonLayout = Object.freeze({
  sessionKeys: Object.freeze(['MURA', 'blockLoginUntil', 'SITEID', 'rememberMe', 'loginAttempts']),
  muraKeys: Object.freeze([
    'SUBTYPE', 'PASSWORDCREATED', 'MEMBERSHIPIDS', 'LNAME', 'ISLOGGEDIN', 'SITEID', 'EMAIL', 'csrfusedtokens', 'FNAME',
    'COMPANY', 'REMOTEID', 'PASSWORD', 'csrfsecretkey', 'USERID', 'USERNAME', 'MEMBERSHIPS', 'LASTLOGIN',
  ]),
});

/** Parsed toauthtokens.data: the whole session struct, its `mura` struct, and a case-insensitive struct read. */
export interface LegacySessionData {
  session: AcfStruct;
  mura: AcfStruct | undefined;
  get(struct: AcfStruct | undefined, key: string): AcfValue | undefined;
}

// ACF serializeJSON string escapes; '/' and non-ASCII stay raw, other C0 characters and DEL become lowercase \u00xx.
const STRING_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
});
const NEEDS_ESCAPE = /["\\\u0000-\u001F\u007F]/g;

// serializeJSON date text, Java "MMMM, dd yyyy HH:mm:ss"; in the CF mask m is month and n is minutes.
const DATE_MASK = 'mmmm, dd yyyy HH:nn:ss';

// The token keys are bracket-set, so ACF emits them as given rather than uppercased.
const CSRF_USED_TOKENS = 'csrfusedtokens';

// Keys oauthTokenBean.getTokenInfo deletes from the stored mura struct (oauthTokenBean.cfc:45-49).
const TOKEN_INFO_HIDDEN: ReadonlySet<string> = new Set(['csrfsecretkey', 'csrfusedtokens', 'isloggedin', 'lastlogin', 'password']);

const upper = (key: string): string => key.toUpperCase();
const verbatim = (key: string): string => key;

function isStruct(value: unknown): value is AcfStruct {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function stringText(s: string): string {
  const escaped = s.replace(
    NEEDS_ESCAPE,
    (c) => STRING_ESCAPES[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${escaped}"`;
}

/** Integers as ACF prints an int or long; any other double in Java Double.toString notation with shortest round-trip digits (0.25, 1.0E-7, 1.0E20). */
function numberText(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`serializeJSON has no text for ${n}`);
  if (Number.isSafeInteger(n)) return String(n);
  const magnitude = Math.abs(n);
  if (magnitude >= 1e-3 && magnitude < 1e7) return String(n);
  const [mantissa = '', exponent = '0'] = n.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}

function valueText(value: AcfValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return stringText(value);
  if (typeof value === 'number') return numberText(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return stringText(cfDateTimeFormat(value, DATE_MASK));
  if (Array.isArray(value)) return `[${value.map(valueText).join(',')}]`;
  return structText(value, []);
}

/** A struct's members: layout keys first, in layout order and text; the rest in snapshot order with keyText applied. */
function structText(
  struct: AcfStruct,
  layoutKeys: readonly string[],
  keyText: (key: string) => string = upper,
  memberText: (key: string, value: AcfValue) => string | undefined = () => undefined,
): string {
  const remaining = new Map<string, [key: string, value: AcfValue]>();
  for (const [key, value] of Object.entries(struct)) {
    const lower = key.toLowerCase();
    const prior = remaining.get(lower);
    // A ColdFusion struct cannot hold both keys, so no legacy text exists for this snapshot.
    if (prior) throw new TypeError(`Struct keys '${prior[0]}' and '${key}' differ only in case`);
    remaining.set(lower, [key, value]);
  }
  const members: string[] = [];
  const add = (text: string, value: AcfValue): void => {
    const nested =
      memberText(text, value) ??
      (isStruct(value) && text.toLowerCase() === CSRF_USED_TOKENS ? structText(value, [], verbatim) : valueText(value));
    members.push(`${stringText(text)}:${nested}`);
  };
  for (const text of layoutKeys) {
    const entry = remaining.get(text.toLowerCase());
    if (entry === undefined) continue;
    remaining.delete(text.toLowerCase());
    add(text, entry[1]);
  }
  for (const [key, value] of remaining.values()) add(keyText(key), value);
  return `{${members.join(',')}}`;
}

/** Compact ACF serializeJSON text of a session snapshot, stored verbatim in toauthtokens.data and never re-serialized. */
export function serializeLegacySessionJson(snapshot: AcfStruct, layout: AcfJsonLayout = ACF_SESSION_JSON_LAYOUT): string {
  return structText(snapshot, layout.sessionKeys, upper, (key, value) =>
    key.toLowerCase() === 'mura' && isStruct(value) ? structText(value, layout.muraKeys) : undefined,
  );
}

/** Case-insensitive struct read, as ColdFusion resolves struct keys. */
function acfGet(struct: AcfStruct | undefined, key: string): AcfValue | undefined {
  if (struct === undefined) return undefined;
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const match = Object.keys(struct).find((k) => k.toLowerCase() === lower);
  return match === undefined ? undefined : struct[match];
}

/** Reads stored session text as isJSON plus deserializeJSON do; undefined when it is empty, not JSON or not a struct. */
export function parseLegacySessionJson(text: string | null | undefined): LegacySessionData | undefined {
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isStruct(parsed)) return undefined;
  const mura = acfGet(parsed, 'mura');
  return { session: parsed, mura: isStruct(mura) ? mura : undefined, get: acfGet };
}

/** Port of oauthTokenBean.getTokenInfo: the stored mura struct without its secret and login-state keys, else {}. */
export function tokenInfoFromSessionJson(text: string | null | undefined): AcfStruct {
  const mura = parseLegacySessionJson(text)?.mura;
  if (mura === undefined) return {};
  return Object.fromEntries(Object.entries(mura).filter(([key]) => !TOKEN_INFO_HIDDEN.has(key.toLowerCase())));
}
