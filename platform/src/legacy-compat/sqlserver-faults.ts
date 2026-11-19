// SQL Server's failures of the statements Masa runs, as the datasource driver words them and cfcatch and onError's debug
// page report them (core/appcfc/onError_include.cfm:177-288).
import { windows1252Text } from './code-page.js';
import { LegacyFaultError } from './debug-page.js';
import { buildEnvelope, serializeResponse, type SerializedLegacyResponse } from './envelope.js';
import { LEGACY_ERROR_MAP, reportedMethod } from './errors.js';

/** `cfcatch.message` of a failed cfquery. */
const QUERY_FAILED = 'Error Executing Database Query.';
/** Prefix of the datasource driver's messages. */
const DRIVER_PREFIX = '[Macromedia][SQLServer JDBC Driver][SQLServer]';
/** Exception class of the driver's data errors. */
const DATA_EXCEPTION = 'java.sql.SQLDataException';
/** Most characters of the value SQL Server's truncation message quotes. */
const QUOTED_VALUE_MAX = 100;
/** Significant digits SQL Server prints of a float. */
const FLOAT_DIGITS = 17;
/** Decimals of the value a float overflow message prints. */
const OVERFLOW_DECIMALS = 6;
/** Most digits a SQL Server numeric literal holds. */
export const NUMERIC_PRECISION_MAX = 38;
/** Range of a SQL Server integer literal; longer digit runs are numeric literals. */
const INT_RANGE = [-2147483648n, 2147483647n] as const;
const INTEGER_LITERAL = /^[+-]?\d+$/;
const DECIMAL_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;
const FLOAT_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d+$/;
/** A Java hex float CFML passes through: its sign and what follows the binary constant SQL Server lexes `0x…` as. */
const HEX_FLOAT_LITERAL = /^([+-]?)0[xX][0-9a-fA-F]*((?:\.[0-9a-fA-F]*)?[pP][+-]?\d+)$/;
const NAMED_DOUBLE_LITERAL = /^[+-]?(Infinity|NaN)$/;

/** A non-negative decimal: `digits` × 10^-`scale`. */
interface Decimal {
  digits: bigint;
  scale: number;
}

/** The exact value of the finite double `value`'s magnitude. */
function exactDecimal(value: number): Decimal {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const biased = Number(bits >> 52n);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = biased === 0 ? fraction : fraction | (1n << 52n);
  const power = Math.max(biased, 1) - 1075;
  return power >= 0 ? { digits: mantissa << BigInt(power), scale: 0 } : { digits: mantissa * 5n ** BigInt(-power), scale: -power };
}

/** `value` at `scale` decimals: rounded up past a half, and at a half too when `halfUp`. */
function atScale(value: Decimal, scale: number, halfUp: boolean): Decimal {
  if (scale >= value.scale) return { digits: value.digits * 10n ** BigInt(scale - value.scale), scale };
  const unit = 10n ** BigInt(value.scale - scale);
  const twice = (value.digits % unit) * 2n;
  const up = twice > unit || (halfUp && twice === unit);
  return { digits: value.digits / unit + (up ? 1n : 0n), scale };
}

/**
 * The finite double `value` as a float overflow message prints it: its exact value to 17 significant digits, a half
 * rounded toward zero, then to six decimals, a half rounded away from zero.
 */
export function sqlServerFloatText(value: number): string {
  const exact = exactDecimal(value);
  const excess = exact.digits.toString().length - FLOAT_DIGITS;
  const significant = excess > 0 ? atScale(exact, exact.scale - excess, false) : exact;
  const text = atScale(significant, OVERFLOW_DECIMALS, true).digits.toString().padStart(OVERFLOW_DECIMALS + 1, '0');
  return `${value < 0 ? '-' : ''}${text.slice(0, -OVERFLOW_DECIMALS)}.${text.slice(-OVERFLOW_DECIMALS)}`;
}

/** The digits of decimal literal `text` SQL Server counts as its precision: the integer digits after leading zeros and every fraction digit. */
export function numericLiteralPrecision(text: string): number {
  const [whole = '', fraction = ''] = text.replace(/^[+-]/, '').split('.');
  return whole.replace(/^0+/, '').length + fraction.length;
}

/** Msg 1007: numeric literal `literal`, written without its sign, holds more digits than {@link NUMERIC_PRECISION_MAX}. */
function numericPrecisionMessage(literal: string): string {
  return `The number '${literal}' is out of the range for numeric representation (maximum precision ${NUMERIC_PRECISION_MAX}).`;
}

/** Msg 8115: a numeric value outside integer column type `type`. */
function conversionMessage(type: string): string {
  return `Arithmetic overflow error converting expression to data type ${type}.`;
}

/** Msg 232: the float `value` outside integer column type `type`. */
function floatOverflowMessage(type: string, value: number): string {
  return `Arithmetic overflow error for type ${type}, value = ${sqlServerFloatText(value)}.`;
}

/** Msg 2628: `value`, as code page 1252 holds it, longer than the `width` characters of `column`; its first `width` quoted, each `'` doubled. */
function truncationMessage(database: string, table: string, column: string, value: string, width: number): string {
  const quoted = windows1252Text(value).slice(0, width).replaceAll("'", "''").slice(0, QUOTED_VALUE_MAX);
  return `String or binary data would be truncated in table '${database}.dbo.${table}', column '${column}'. Truncated value: '${quoted}'.`;
}

/** Variables naming the legacy datasource and database. */
export type QueryFaultEnv = Readonly<Record<string, string | undefined>>;

/** A cfquery SQL Server fails: `cfcatch` of type Database with its statement, SQLSTATE and driver message. */
export class LegacyQueryFault extends Error {
  override readonly name: string = 'LegacyQueryFault';
  /** `cfcatch.type`. */
  readonly type: string = 'Database';

  constructor(
    /** `cfcatch.sql`: the statement, each cfqueryparam as `(param n)`. */
    readonly sql: string,
    /** `cfcatch.errorCode`, the SQLSTATE. */
    readonly errorCode: string,
    /** `cfcatch.detail`, the driver's message. */
    readonly detail: string,
  ) {
    super(QUERY_FAILED);
  }
}

/** A value a statement writes to a text column: the catalog's column name and width, and the value; NULL writes nothing. */
export interface BoundText {
  readonly column: string;
  readonly width: number;
  readonly value: string | null | undefined;
}

/** A CFML value a statement writes into a column of `type` as an inline literal. */
export interface InlineNumber {
  readonly type: 'tinyint' | 'int' | 'float';
  readonly text: string;
}

/** A value of a statement, in its statement order. */
export type StatementValue = BoundText | InlineNumber;

/** Range of the integer column types an inline literal converts to. */
const INTEGER_RANGES: Readonly<Record<'tinyint' | 'int', readonly [bigint, bigint]>> = { tinyint: [0n, 255n], int: INT_RANGE };

function driverFault(sql: string, errorCode: string, message: string): LegacyQueryFault {
  return new LegacyQueryFault(sql, errorCode, `${DRIVER_PREFIX}${message}`);
}

/**
 * The parse failure of an inline value: an empty one leaves the `,` after it unparsable, a decimal literal may hold
 * no more digits than a numeric literal (floats have no such limit), and a Java hex float lexes as a binary constant
 * followed by a token SQL Server cannot parse there, or by an identifier after which it folds a negated binary.
 */
function parseFault(sql: string, { text }: InlineNumber): LegacyQueryFault | undefined {
  if (text === '') return driverFault(sql, 'HY000', "Incorrect syntax near ','.");
  const hex = HEX_FLOAT_LITERAL.exec(text);
  if (hex !== null) {
    const [, sign, rest = ''] = hex;
    const number = /^\.\d+(?:[eE][+-]?\d*)?/.exec(rest)?.[0];
    if (number !== undefined) return driverFault(sql, 'HY000', `Incorrect syntax near '${number}'.`);
    if (rest.startsWith('.')) return undefined;
    if (sign === '-') return driverFault(sql, 'HY000', 'Invalid operator for data type. Operator equals minus, type equals varbinary.');
    return driverFault(sql, 'HY000', `Incorrect syntax near '${/^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0] ?? rest}'.`);
  }
  if (!DECIMAL_LITERAL.test(text) || numericLiteralPrecision(text) <= NUMERIC_PRECISION_MAX) return undefined;
  return driverFault(sql, '22003', numericPrecisionMessage(text.replace(/^[+-]/, '')));
}

/** The binding failure of an inline value: `Infinity` and `NaN` name no column, and a binary constant has no methods. */
function bindFault(sql: string, { text }: InlineNumber): LegacyQueryFault | undefined {
  const named = NAMED_DOUBLE_LITERAL.exec(text)?.[1];
  if (named !== undefined) return driverFault(sql, '42S22', `Invalid column name '${named}'.`);
  const rest = HEX_FLOAT_LITERAL.exec(text)?.[2];
  return rest !== undefined && /^\.[A-Za-z_]/.test(rest) ? driverFault(sql, 'HY000', 'Cannot call methods on varbinary.') : undefined;
}

/** The whole part of decimal literal `text`, truncated toward zero. */
function wholePart(text: string): bigint {
  const negative = text.startsWith('-');
  const whole = BigInt(text.replace(/^[+-]/, '').split('.')[0] || '0');
  return negative ? -whole : whole;
}

/** The overflow SQL Server raises converting inline literal `text` to its integer column; undefined when it fits. */
function conversionFault(sql: string, { type, text }: InlineNumber): LegacyQueryFault | undefined {
  if (type === 'float') return undefined;
  const [min, max] = INTEGER_RANGES[type];
  if (INTEGER_LITERAL.test(text)) {
    const value = BigInt(text.replace(/^\+/, ''));
    if (value >= INT_RANGE[0] && value <= INT_RANGE[1]) {
      return value < min || value > max ? driverFault(sql, '22003', `Arithmetic overflow error for data type ${type}, value = ${value}.`) : undefined;
    }
  }
  if (DECIMAL_LITERAL.test(text)) {
    const whole = wholePart(text);
    return whole < min || whole > max ? driverFault(sql, '22001', conversionMessage(type)) : undefined;
  }
  if (FLOAT_LITERAL.test(text)) {
    const value = Number(text);
    const whole = Math.trunc(value);
    if (whole >= Number(min) && whole <= Number(max)) return undefined;
    return driverFault(sql, '22003', floatOverflowMessage(type, value));
  }
  return undefined;
}

/** The truncation of a text value longer than its column by more than trailing spaces, which ANSI_WARNINGS cuts silently. */
function textTruncationFault(sql: string, table: string, { column, width, value }: BoundText, env: QueryFaultEnv): LegacyQueryFault | undefined {
  if (value === null || value === undefined || value.length <= width || /^ +$/.test(value.slice(width))) return undefined;
  return driverFault(sql, 'HY000', truncationMessage(env.MURA_DATABASE ?? '', table, column, value, width));
}

/**
 * The failure SQL Server raises running `sql` on `table` with `values`, in statement order: an inline value that fails the
 * parse comes first, then one that fails binding, then the first value its column cannot hold; undefined when all fit.
 * `MURA_DATABASE` names the database.
 */
export function statementFault(sql: string, table: string, values: readonly StatementValue[], env: QueryFaultEnv = process.env): LegacyQueryFault | undefined {
  for (const phase of [parseFault, bindFault]) {
    for (const value of values) {
      const fault = 'type' in value ? phase(sql, value) : undefined;
      if (fault !== undefined) return fault;
    }
  }
  for (const value of values) {
    const fault = 'type' in value ? conversionFault(sql, value) : textTruncationFault(sql, table, value, env);
    if (fault !== undefined) return fault;
  }
  return undefined;
}

/** A statement value: a bound text column (catalog name, value key, width) or an inline literal (value key, column type). */
export type StatementColumn = readonly ['text', string, string, number] | readonly ['inline', string, InlineNumber['type']];

/** The values of `columns` read from `values` by key; an inline value absent from `values` is skipped. */
export function statementValues(columns: readonly StatementColumn[], values: Readonly<Record<string, string | null | undefined>>): StatementValue[] {
  const out: StatementValue[] = [];
  for (const entry of columns) {
    if (entry[0] === 'text') {
      out.push({ column: entry[1], width: entry[3], value: values[entry[2]] });
    } else {
      const text = values[entry[1]];
      if (typeof text === 'string') out.push({ type: entry[2], text });
    }
  }
  return out;
}

/** Msg 2627: `sql` inserting `key`, the row's primary key as stored, which `constraint` of dbo.`table` already holds. */
export function primaryKeyFault(sql: string, constraint: string, table: string, key: string): LegacyQueryFault {
  return driverFault(
    sql,
    '23000',
    `Violation of PRIMARY KEY constraint '${constraint}'. Cannot insert duplicate key in object 'dbo.${table}'. The duplicate key value is (${key}).`,
  );
}

/** The 500 `server_error` envelope whose `stacktrace` holds the cfcatch fields of `fault`; `MURA_DATASOURCE` is its datasource. */
export function queryFaultResponse(fault: LegacyQueryFault, env: QueryFaultEnv = process.env): SerializedLegacyResponse {
  const { message, code } = LEGACY_ERROR_MAP.server_error;
  const stacktrace = {
    Message: fault.message,
    Type: fault.type,
    DataSource: env.MURA_DATASOURCE ?? '',
    Sql: fault.sql,
    ErrorCode: fault.errorCode,
    Detail: fault.detail,
  };
  const envelope = buildEnvelope({ method: reportedMethod(undefined), error: { message, code, stacktrace } });
  return serializeResponse(envelope, { statusCode: 500, keyOrder: 'acf' });
}

// The driver's errors as onError's debug page names them with its error number as the code and its exception class as the type.

/** Msg 1007 as the statement compiles: numeric literal `literal`, written without its sign, of more than 38 digits. */
export function numericPrecisionFault(literal: string): LegacyFaultError {
  return new LegacyFaultError(`${DRIVER_PREFIX}${numericPrecisionMessage(literal)}`, DATA_EXCEPTION, { errorCode: '1007' });
}

/** Msg 8115: a numeric value outside `int`. */
export function intConversionFault(): LegacyFaultError {
  return new LegacyFaultError(`${DRIVER_PREFIX}${conversionMessage('int')}`, DATA_EXCEPTION, { errorCode: '8115' });
}

/** Msg 232: the float `value` outside `int`. */
export function intOverflowFault(value: number): LegacyFaultError {
  return new LegacyFaultError(`${DRIVER_PREFIX}${floatOverflowMessage('int', value)}`, DATA_EXCEPTION, { errorCode: '232' });
}

/** Msg 515: an INSERT binding NULL to the NOT NULL `column` of `database`.dbo.`table`. */
export function nullInsertFault(database: string, table: string, column: string): LegacyFaultError {
  return new LegacyFaultError(
    `${DRIVER_PREFIX}Cannot insert the value NULL into column '${column}', table '${database}.dbo.${table}'; column does not allow nulls. INSERT fails.`,
    'java.sql.SQLIntegrityConstraintViolationException',
    { errorCode: '515' },
  );
}

/** Msg 2628: `value`, a varchar parameter SQL Server converts to code page 1252, longer than the `width` characters of `column`. */
export function truncationFault(database: string, table: string, column: string, value: string, width: number): LegacyFaultError {
  return new LegacyFaultError(`${DRIVER_PREFIX}${truncationMessage(database, table, column, value, width)}`, 'java.sql.SQLException', {
    errorCode: '2628',
  });
}
