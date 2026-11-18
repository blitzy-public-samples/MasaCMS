// onError's debugging-on error page, the setting that selects it and the faults the target raises where legacy does (core/appcfc/onError_include.cfm:138-408).
import type { LegacyFaultTrace } from './errors.js';
import type { SerializedLegacyResponse } from './envelope.js';
import { cfIsBoolean, cfToBoolean } from './serializer.js';
import { LEGACY_ERROR_PAGE_HTML, LEGACY_ERROR_STATUS_TEXT, LEGACY_HTML_CONTENT_TYPE } from './unavailable.js';

/** A ColdFusion exception legacy raises at a point the target reproduces: its message and type. */
export class LegacyFaultError extends Error {
  override readonly name: string = 'LegacyFaultError';

  constructor(
    message: string,
    readonly type: string = 'Expression',
  ) {
    super(message);
  }

  /** The fault an error envelope's `stacktrace` names. */
  static fromTrace(trace: LegacyFaultTrace): LegacyFaultError {
    return new LegacyFaultError(trace.Message, trace.Type);
  }

  /** The fault as an error envelope's `stacktrace`. */
  trace(): LegacyFaultTrace {
    return { Message: this.message, Type: this.type };
  }
}

/** cusers.cfc:343 reading the `rc.userBean` a refused CSRF token, or an action other than Add, Update and Delete, leaves unset. */
export const UNSET_USER_BEAN_FAULT: LegacyFaultTrace = Object.freeze({
  Message: 'Element RC.userBean is undefined in ARGUMENTS.',
  Type: 'Expression',
});

/** `struct[key]` by case-insensitive key, as CFML reads it; undefined for a value that is not a struct. */
function memberOf(struct: unknown, key: string): unknown {
  if (typeof struct !== 'object' || struct === null) return undefined;
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === key);
  return name === undefined ? undefined : (struct as Record<string, unknown>)[name];
}

/**
 * The fault a legacy error envelope's `error.stacktrace` names, its keys read in any case as the API serializer
 * lower-cases them; undefined unless it holds a text message and type.
 */
export function legacyFaultOf(body: unknown): LegacyFaultError | undefined {
  const trace = memberOf(memberOf(body, 'error'), 'stacktrace');
  const [message, type] = [memberOf(trace, 'message'), memberOf(trace, 'type')];
  return typeof message === 'string' && typeof type === 'string' ? new LegacyFaultError(message, type) : undefined;
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
 * onError's debugging-on page for `fault`: the errorBox with its `500 Error`, message and `Type:` headings, without the
 * Java stack trace and tag context legacy prints after them.
 * @param encodeHtml `esapiEncode('html', …)`.
 */
export function legacyDebugPageHtml(
  fault: Pick<LegacyFaultError, 'message' | 'type'>,
  encodeHtml: (text: string) => string,
): string {
  const message = fault.message === '' ? '' : `<h2>${encodeHtml(fault.message)}<br /></h2>`;
  const type = fault.type === '' ? '' : `<h3>Type:${encodeHtml(fault.type)}<br /></h3>`;
  return `${DEBUG_PAGE_HEAD}${message}${type}</div>`;
}

/** Options of {@link legacyRuntimeErrorResponse}. */
export interface LegacyRuntimeErrorOptions {
  /** configBean `debuggingEnabled`, as {@link debuggingEnabledOf} reads it. */
  debuggingEnabled: boolean;
  /** `esapiEncode('html', …)`. */
  encodeHtml: (text: string) => string;
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
    body: fault !== undefined && opts.debuggingEnabled ? legacyDebugPageHtml(fault, opts.encodeHtml) : LEGACY_ERROR_PAGE_HTML,
  };
}
