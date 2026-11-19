// onError's debugging-on error page, the setting that selects it and the faults the target raises where legacy does (core/appcfc/onError_include.cfm:138-408).
import type { LegacyFaultTrace } from './errors.js';
import type { SerializedLegacyResponse } from './envelope.js';
import { cfIsBoolean, cfToBoolean } from './serializer.js';
import { LEGACY_ERROR_PAGE_HTML, LEGACY_ERROR_STATUS_TEXT, LEGACY_HTML_CONTENT_TYPE } from './unavailable.js';

/** The cfcatch fields onError's debug page prints besides the message and type (onError_include.cfm:200-305). */
export interface LegacyFaultFields {
  /** `DataSource` of a failed query. */
  readonly dataSource?: string;
  /** `Sql` of a failed query, each cfqueryparam as `(param n)`. */
  readonly sql?: string;
  /** `ErrorCode`: a query's SQLSTATE or the driver's error number. */
  readonly errorCode?: string;
  readonly detail?: string;
  readonly extendedInfo?: string;
}

/** Each {@link LegacyFaultFields} member and the `stacktrace` key naming it, in onError's heading order. */
const FAULT_FIELD_KEYS = [
  ['dataSource', 'DataSource'],
  ['sql', 'Sql'],
  ['errorCode', 'ErrorCode'],
  ['detail', 'Detail'],
  ['extendedInfo', 'ExtendedInfo'],
] as const satisfies ReadonlyArray<readonly [keyof LegacyFaultFields, Exclude<keyof LegacyFaultTrace, 'Message' | 'Type'>]>;

/** A ColdFusion exception legacy raises at a point the target reproduces: its message, type and the other fields onError prints. */
export class LegacyFaultError extends Error implements LegacyFaultFields {
  override readonly name: string = 'LegacyFaultError';
  readonly dataSource: string | undefined;
  readonly sql: string | undefined;
  readonly errorCode: string | undefined;
  readonly detail: string | undefined;
  readonly extendedInfo: string | undefined;

  constructor(
    message: string,
    readonly type: string = 'Expression',
    fields: LegacyFaultFields = {},
  ) {
    super(message);
    this.dataSource = fields.dataSource;
    this.sql = fields.sql;
    this.errorCode = fields.errorCode;
    this.detail = fields.detail;
    this.extendedInfo = fields.extendedInfo;
  }

  /** The fault an error envelope's `stacktrace` names. */
  static fromTrace(trace: LegacyFaultTrace): LegacyFaultError {
    const fields: { -readonly [K in keyof LegacyFaultFields]: string } = {};
    for (const [field, key] of FAULT_FIELD_KEYS) fields[field] = trace[key];
    return new LegacyFaultError(trace.Message, trace.Type, fields);
  }

  /** The fault as an error envelope's `stacktrace`: `Message`, `Type`, then each field it has. */
  trace(): LegacyFaultTrace {
    const trace: { -readonly [K in keyof LegacyFaultTrace]: LegacyFaultTrace[K] } = { Message: this.message, Type: this.type };
    for (const [field, key] of FAULT_FIELD_KEYS) {
      const value = this[field];
      if (value !== undefined) trace[key] = value;
    }
    return trace;
  }
}

/** cusers.cfc:343 reading the `rc.userBean` a refused CSRF token, or an action other than Add, Update and Delete, leaves unset. */
export const UNSET_USER_BEAN_FAULT: LegacyFaultTrace = Object.freeze({
  Message: 'Element RC.userBean is undefined in ARGUMENTS.',
  Type: 'Expression',
});

/** ACF reading a struct, query or array as a simple value, as in a `gt` comparison. */
export const COMPLEX_VALUE_FAULT: LegacyFaultTrace = Object.freeze({
  Message: 'Complex object types cannot be converted to simple values.',
  Type: 'Expression',
  Detail:
    'The expression has requested a variable or an intermediate expression result as a simple value. However, the ' +
    'result cannot be converted to a simple value. Simple values are strings, numbers, boolean values, and date/time ' +
    'values. Queries, arrays, and COM objects are examples of complex values. <p> The most likely cause of the error ' +
    'is that you tried to use a complex value as a simple one. For example, you tried to use a query variable in a cfif tag.',
});

/** `<cfwddx action="wddx2cfml">` of an empty input, as an empty or NULL packet and a query without rows give it. */
export const EMPTY_WDDX_PACKET_FAULT: LegacyFaultTrace = Object.freeze({
  Message: 'WDDX packet parse error at line -1, column -1. Premature end of file..',
  Type: 'Application',
});

/** `struct[key]` by case-insensitive key, as CFML reads it; undefined for a value that is not a struct. */
function memberOf(struct: unknown, key: string): unknown {
  if (typeof struct !== 'object' || struct === null) return undefined;
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === key);
  return name === undefined ? undefined : (struct as Record<string, unknown>)[name];
}

/** The fault a legacy error envelope's `error.stacktrace` names, as {@link legacyFaultOfTrace} reads it. */
export function legacyFaultOf(body: unknown): LegacyFaultError | undefined {
  return legacyFaultOfTrace(memberOf(memberOf(body, 'error'), 'stacktrace'));
}

/**
 * The fault a `stacktrace` struct names, its keys read in any case as the API serializer lower-cases them, with each
 * other field onError prints that it holds as text; undefined unless it holds a text message and type.
 */
export function legacyFaultOfTrace(trace: unknown): LegacyFaultError | undefined {
  const [message, type] = [memberOf(trace, 'message'), memberOf(trace, 'type')];
  if (typeof message !== 'string' || typeof type !== 'string') return undefined;
  const fields: { -readonly [K in keyof LegacyFaultFields]: string } = {};
  for (const [field, key] of FAULT_FIELD_KEYS) {
    const value = memberOf(trace, key.toLowerCase());
    if (typeof value === 'string') fields[field] = value;
  }
  return new LegacyFaultError(message, type, fields);
}

/** The settings template's `debuggingenabled` (core/templates/settings.template.cfm:37). */
export const DEBUGGING_ENABLED_TEMPLATE = 'true';

// configBean keeps the value as text (configBean.cfc:722-724); onError's `!` throws on non-boolean text inside a try.
/** configBean `debuggingEnabled` as onError tests it: off only for a CFML boolean false. */
export function debuggingEnabledOf(value: string): boolean {
  return !(cfIsBoolean(value) && !cfToBoolean(value));
}

/** `MURA_DEBUGGINGENABLED`, else the settings template's value, as onError tests it. */
export function legacyDebuggingEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return debuggingEnabledOf(env.MURA_DEBUGGINGENABLED ?? DEBUGGING_ENABLED_TEMPLATE);
}

// onError_include.cfm:160-174, written from a single-quoted CFML string, so its doubled quotes reach the wire.
const DEBUG_PAGE_HEAD =
  '<style type=""text/css"">\n\t\t.errorBox {\n\t\t\tmargin: 10px auto 10px auto;\n\t\t\twidth: 90%;\n\t\t}\n\n' +
  '\t\t.errorBox h1 {\n\t\t\tfont-size: 100px;\n\t\t\tmargin: 5px 0px 5px 0px;\n\t\t}\n\n\t</style>\n' +
  '\t<div class=""errorBox"">\n\t\t<h1>500 Error</h1>';

/**
 * onError's debugging-on page for `fault`: the errorBox with its `500 Error`, then the message, `Datasource:`, `SQL:`,
 * `Code:`, `Type:`, detail and extended-info headings, each only for a non-empty value, without the Java stack trace and
 * tag context legacy prints after them.
 * @param encodeHtml `esapiEncode('html', …)`.
 */
export function legacyDebugPageHtml(
  fault: Pick<LegacyFaultError, 'message' | 'type'> & LegacyFaultFields,
  encodeHtml: (text: string) => string,
): string {
  const heading = (tag: string, label: string, value: string | undefined): string =>
    value === undefined || value === '' ? '' : `<${tag}>${label}${encodeHtml(value)}<br /></${tag}>`;
  return (
    DEBUG_PAGE_HEAD +
    heading('h2', '', fault.message) +
    heading('h3', 'Datasource:', fault.dataSource) +
    heading('h4', 'SQL:', fault.sql) +
    heading('h3', 'Code:', fault.errorCode) +
    heading('h3', 'Type:', fault.type) +
    heading('h3', '', fault.detail) +
    heading('h3', '', fault.extendedInfo) +
    '</div>'
  );
}

/** Options of {@link legacyRuntimeErrorResponse}. */
export interface LegacyRuntimeErrorOptions {
  /** configBean `debuggingEnabled`, as {@link debuggingEnabledOf} reads it. */
  debuggingEnabled: boolean;
  /** `esapiEncode('html', …)`. */
  encodeHtml: (text: string) => string;
  /**
   * The `cfhtmlhead` text the request wrote before the fault, which ColdFusion prints ahead of the debug page; the
   * debugging-off branch's `cfcontent reset` discards it.
   */
  htmlHead?: string;
}

/** onError's answer to a runtime error: 500 `An Error Occurred` with the debug page of `fault` when debugging is on, else error.html. */
export function legacyRuntimeErrorResponse(
  fault: LegacyFaultError | undefined,
  opts: LegacyRuntimeErrorOptions,
): SerializedLegacyResponse & { statusText: string } {
  return {
    status: 500,
    statusText: LEGACY_ERROR_STATUS_TEXT,
    headers: { 'Content-Type': LEGACY_HTML_CONTENT_TYPE },
    body:
      fault !== undefined && opts.debuggingEnabled
        ? (opts.htmlHead ?? '') + legacyDebugPageHtml(fault, opts.encodeHtml)
        : LEGACY_ERROR_PAGE_HTML,
  };
}
