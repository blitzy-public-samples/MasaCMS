import type { Logger } from './logger.js';
import { redactText } from './redact.js';
import { safeErrorMessage, safeErrorStack, serializeError } from './safe-error.js';

const CONTROL_CHARACTER = /[\p{Cc}\u2028\u2029]/gu;
const SHORT_ESCAPES = new Map([
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\t', '\\t'],
]);

let diagnosticLogger: Logger | undefined;

/** Registers `logger` as the process diagnostic logger; undefined clears it. */
export function setDiagnosticLogger(logger: Logger | undefined): void {
  diagnosticLogger = logger;
}

/** The registered process diagnostic logger, or undefined. */
export function getDiagnosticLogger(): Logger | undefined {
  return diagnosticLogger;
}

/** Writes safe text `message` and `err` as one `code`-prefixed warning line, else as a native `code` process warning; never throws. */
export function emitDiagnostic(code: string, message: string, err: unknown): void {
  if (!logDiagnostic(code, message, err)) {
    // The string form keeps the warning code; process.emitWarning drops it when given an Error. Stderr only: stdout carries log-record.v1 lines.
    process.emitWarning(escapeControls(message), { code, detail: nativeDetail(err) });
  }
}

/** Writes the diagnostic through the registered logger; false when none is registered or it throws. */
function logDiagnostic(code: string, message: string, err: unknown): boolean {
  if (diagnosticLogger === undefined) return false;
  try {
    // An already-safe record, so the logger never matches the raw error message against `message`.
    diagnosticLogger.warn({ error: serializeError(err) }, `${code}: ${message}`);
    return true;
  } catch {
    return false;
  }
}

/** Safe stack frames of `err` on one line under its safe header; undefined without a stack or when `err` cannot be read. */
function nativeDetail(err: unknown): string | undefined {
  try {
    const stack = safeErrorStack(err, `${err instanceof Error ? redactText(err.name) : typeof err}: ${safeErrorMessage(err)}`);
    return stack === undefined ? undefined : escapeControls(stack);
  } catch {
    return undefined;
  }
}

/** `text` with every control and line-separator character escaped so it cannot start an output line. */
function escapeControls(text: string): string {
  return text.replace(
    CONTROL_CHARACTER,
    (char) => SHORT_ESCAPES.get(char) ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}
