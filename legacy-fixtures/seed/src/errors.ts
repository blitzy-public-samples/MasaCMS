// SYNTHETIC: seed - no Masa equivalent; legacy oracle in legacy-fixtures/
import { isCfUuid } from '@opt2/platform/legacy-compat';
import { ServiceUnavailableError, UnknownServiceError } from '@opt2/platform/service-kit';

/** How `printable` marks an error; `usage` also points the reader at `--help`. */
export interface PrintableOptions {
  usage?: boolean;
}

// Registered, so a mark survives a second instance of this module; non-enumerable, so error equality ignores it.
const PRINTABLE: unique symbol = Symbol.for('@opt2/legacy-fixtures-seed/printable');
const ERROR_NAME = /^[A-Za-z_$][\w$]*$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;
const JSON_LOCATION = / at position \d+ \(line (\d+) column (\d+)\)$/;
const PLAIN_NAME = /^[A-Za-z_][\w.$-]{0,127}$/;

type Marked = Error & { [PRINTABLE]?: 'message' | 'usage' };

/** Marks `err`, whose message holds only paths, keys, table, batch and site names, counts and codes, as safe to print; returns `err`. */
export function printable<E extends Error>(err: E, options: PrintableOptions = {}): E {
  Object.defineProperty(err, PRINTABLE, { value: options.usage === true ? 'usage' : 'message', enumerable: false, configurable: true });
  return err;
}

/** `text` parsed as JSON; on failure throws a printable `SyntaxError` naming `file` with V8's line and column only, never the text. */
export function parseJson(text: string, file: string, options: PrintableOptions = {}): unknown {
  let location: RegExpExecArray | null;
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    location = JSON_LOCATION.exec((err as Error).message);
  }
  const where = location === null ? '' : ` at line ${location[1]} column ${location[2]}`;
  throw printable(new SyntaxError(`${file} is not valid JSON${where}`), options);
}

/** Kind of `value` for failure messages: `null`, `nothing` for undefined, otherwise its `typeof`. */
export function kindOf(value: unknown): string {
  if (value === null) return 'null';
  return value === undefined ? 'nothing' : typeof value;
}

/** `value` as JSON when it is a CF UUID or a safe integer, otherwise its kind in angle brackets. */
export function idText(value: unknown): string {
  return (typeof value === 'string' && isCfUuid(value)) || Number.isSafeInteger(value) ? JSON.stringify(value) : `<${kindOf(value)}>`;
}

/** `name` when it is a plain identifier of letters, digits, `_`, `.`, `$` and `-`, otherwise `<name>`. */
export function nameText(name: string): string {
  return PLAIN_NAME.test(name) ? name : '<name>';
}

/** Message of `err` on one line. */
export function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s*\n\s*/g, ' ');
}

/** Whether `err` is a Node system error, whose message holds only its code, description, syscall and paths. */
function isSystemError(err: Error): boolean {
  const { code, syscall, errno } = err as { code?: unknown; syscall?: unknown; errno?: unknown };
  return typeof code === 'string' && typeof syscall === 'string' && typeof errno === 'number';
}

/** One-line message of a printable, Node system or service-client error, with the `--help` pointer of a usage mark; otherwise undefined. */
export function printableMessage(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const mark = (err as Marked)[PRINTABLE];
  if (mark === undefined && !isSystemError(err) && !(err instanceof UnknownServiceError) && !(err instanceof ServiceUnavailableError)) return undefined;
  return `${oneLine(err)}${mark === 'usage' ? ' (see --help)' : ''}`;
}

/** Class name of `err`, plus its `code` when that is an upper-case identifier; the kind of a thrown non-error. */
export function errorCategory(err: unknown): string {
  if (!(err instanceof Error)) return kindOf(err);
  const name = ERROR_NAME.test(err.name) ? err.name : 'Error';
  const { code } = err as { code?: unknown };
  return typeof code === 'string' && ERROR_CODE.test(code) ? `${name} ${code}` : name;
}

/** Text of `err` safe to print: its `printableMessage`, otherwise its `errorCategory`. */
export function failureText(err: unknown): string {
  return printableMessage(err) ?? errorCategory(err);
}
