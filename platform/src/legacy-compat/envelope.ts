// Port of the Masa JSON API response envelope and serializeResponse (jsonApiUtility.cfc:894, 1310-1323, 1471-1514, 1620-1639).
import { createApiSerializer, cfIsBoolean, cfToBoolean, type LegacyJsonSerializer } from './serializer.js';
import { etag, LEGACY_JSON_CONTENT_TYPE, LEGACY_SHUNTER_CONTENT_TYPE } from './headers.js';

/** Legacy JSON API response struct; flattening merges data keys into the top level, hence the index signature. */
export interface LegacyEnvelope {
  apiversion: 'v1';
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
  error?: Record<string, unknown>;
  layout?: unknown;
  [k: string]: unknown;
}

/** Options of serializeResponse; `useDataNamespace` is the raw request event value, passed unchanged. */
export interface SerializeResponseOptions {
  statusCode?: number;
  mura404?: boolean;
  suppressAPIParams?: boolean;
  useDataNamespace?: unknown;
  useDataNamespaceForAPI?: boolean;
  serializer?: LegacyJsonSerializer;
}

/** Status, headers and exact body of a serialized legacy JSON API response. */
export interface SerializedLegacyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** API version every envelope reports (jsonApiUtility.cfc:1513-1515). */
export function getApiVersion(): 'v1' {
  return 'v1';
}

/** CFML isStruct for plain data: plain objects only, never arrays, dates, class instances or LegacyQuery values. */
function isStruct(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  const q = v as { kind?: unknown; columnList?: unknown; rows?: unknown };
  return !(q.kind === 'query' && Array.isArray(q.columnList) && Array.isArray(q.rows));
}

/** Own keys equal to `key` ignoring case, as CFML struct keys resolve. */
function keysNoCase(obj: Record<string, unknown>, key: string): string[] {
  const lower = key.toLowerCase();
  return Object.keys(obj).filter((k) => k.toLowerCase() === lower);
}

/** CFML struct read: the value under `key` ignoring case, or undefined. */
function getNoCase(obj: Record<string, unknown>, key: string): unknown {
  const [found] = keysNoCase(obj, key);
  return found === undefined ? undefined : obj[found];
}

/** CFML structDelete: removes every key equal to `key` ignoring case. */
function deleteNoCase(obj: Record<string, unknown>, key: string): void {
  for (const k of keysNoCase(obj, key)) delete obj[k];
}

/** CFML struct write: overwrites an existing key ignoring case in place, otherwise appends it. */
function setNoCase(obj: Record<string, unknown>, key: string, value: unknown): void {
  const [found = key, ...duplicates] = keysNoCase(obj, key);
  for (const k of duplicates) delete obj[k];
  obj[found] = value;
}

/** CFML isDefined on a struct member: present and not null. */
function isDefinedNoCase(obj: Record<string, unknown>, key: string): boolean {
  const v = getNoCase(obj, key);
  return v !== undefined && v !== null;
}

/** CFML list items over a single-character delimiter; empty items are ignored. */
function cfListItems(list: string, delimiter: string): string[] {
  return list.split(delimiter).filter((item) => item !== '');
}

/** CFML listFirst; '' for a list with no items. */
function cfListFirst(list: string, delimiter: string): string {
  return cfListItems(list, delimiter)[0] ?? '';
}

/** CFML listLast; '' for a list with no items. */
function cfListLast(list: string, delimiter: string): string {
  return cfListItems(list, delimiter).at(-1) ?? '';
}

/** Builds `{apiversion, method, params, data}`, or `{apiversion, method, params, error}` when `error` is given (jsonApiUtility.cfc:894, 1323). */
export function buildEnvelope(a: {
  method: string;
  params?: Record<string, unknown>;
  data?: unknown;
  error?: Record<string, unknown>;
}): LegacyEnvelope {
  const envelope: LegacyEnvelope = { apiversion: getApiVersion(), method: a.method };
  if (a.params !== undefined) envelope.params = a.params;
  if (a.error !== undefined) envelope.error = a.error;
  else envelope.data = a.data;
  return envelope;
}

/** Request params as echoed in envelopes: method and cache ids removed, path-like simple values hidden (jsonApiUtility.cfc:1620-1639). */
export function paramsWithoutMethod(params: Record<string, unknown>): Record<string, unknown> {
  const temp: Record<string, unknown> = { ...params };
  deleteNoCase(temp, 'method');
  deleteNoCase(temp, '_cacheid');
  deleteNoCase(temp, 'cacheid');

  for (const p of Object.keys(temp)) {
    if (p.includes('[')) {
      // Legacy quirk (line 1629): 'filter[title]' deletes 'filtertitle', never the bracketed key itself.
      deleteNoCase(temp, cfListFirst(p, '[') + cfListFirst(cfListLast(p, '['), ']'));
    }
    // Line 1633: simple values holding a slash or backslash are dropped so file paths are never echoed.
    if (!Object.hasOwn(temp, p)) continue;
    const value = temp[p];
    const simple = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
    if (simple && /[\\/]/.test(String(value))) delete temp[p];
  }
  return temp;
}

/** Serializes an envelope with legacy status, content type, params suppression, data flattening, shunter layout and ETag (jsonApiUtility.cfc:1471-1511). */
export function serializeResponse(
  response: LegacyEnvelope | Record<string, unknown>,
  opts: SerializeResponseOptions = {},
): SerializedLegacyResponse {
  const {
    statusCode = 200,
    mura404 = false,
    suppressAPIParams = true,
    useDataNamespace,
    useDataNamespaceForAPI = true,
    serializer = createApiSerializer(),
  } = opts;
  const headers: Record<string, string> = { 'Content-Type': LEGACY_JSON_CONTENT_TYPE };
  const status = mura404 ? 404 : statusCode;
  const copy: Record<string, unknown> = { ...response };

  if (suppressAPIParams && isDefinedNoCase(copy, 'params')) deleteNoCase(copy, 'params');

  const data = getNoCase(copy, 'data');
  if (isStruct(data)) {
    const flatten = cfIsBoolean(useDataNamespace) ? !cfToBoolean(useDataNamespace) : !useDataNamespaceForAPI;
    if (flatten) {
      // structAppend overwrites by default, so data keys replace top-level keys of the same name.
      for (const key of Object.keys(data)) setNoCase(copy, key, data[key]);
      deleteNoCase(copy, 'data');
    }
  }

  // Read after flattening: a flattened response has no data, so the shunter layout is never applied to it.
  const shunterData = getNoCase(copy, 'data');
  if (isStruct(shunterData)) {
    const shunter = getNoCase(shunterData, 'shunter');
    if (cfIsBoolean(shunter) && cfToBoolean(shunter) && isDefinedNoCase(shunterData, 'layout')) {
      headers['Content-Type'] = LEGACY_SHUNTER_CONTENT_TYPE;
      setNoCase(copy, 'layout', getNoCase(shunterData, 'layout'));
    }
  }

  // Legacy serializes twice (lines 1506-1510); both passes are identical, so one pass gives body and ETag.
  const body = serializer.serialize(copy);
  headers['ETag'] = etag(body);
  return { status, headers, body };
}

/** Entity-route result response: 403 when the result carries a non-empty errors struct, otherwise 200 (jsonApiUtility.cfc:1310-1314). */
export function serializeSaveResult(
  a: { method: string; params: Record<string, unknown>; data: unknown },
  opts: Omit<SerializeResponseOptions, 'statusCode'> = {},
): SerializedLegacyResponse {
  const errors = isStruct(a.data) ? getNoCase(a.data, 'errors') : undefined;
  const failed = isStruct(errors) && Object.keys(errors).length > 0;
  return serializeResponse(
    buildEnvelope({ method: a.method, params: paramsWithoutMethod(a.params), data: a.data }),
    { ...opts, statusCode: failed ? 403 : 200 },
  );
}
