// Chain-hash rule of the golden normaliser: audit chain hashes as scenario ordinals, each entry hash checked first.
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { OrdinalCounter } from './ids.js';
import type { ChainHashRules } from './rules.js';

// request_id and actor_user_id are char(35): the procedure's CONCAT keeps SQL Server's space padding.
const CHAR_ID_LENGTH = 35;
const SEPARATOR = '|';

interface CompiledChainHashes {
  /** Lower-cased `fields`. */
  readonly fields: ReadonlySet<string>;
  /** Lower-cased field of the entry hash the self-consistency check covers. */
  readonly hashField: string;
  /** Case-exact: compiled without flags. */
  readonly format: RegExp;
  readonly keepLiteral: ReadonlySet<string>;
}

// Loaded rules are deep-frozen, so each object compiles once.
const compiledRules = new WeakMap<ChainHashRules, CompiledChainHashes>();

function compile(rules: ChainHashRules): CompiledChainHashes {
  let compiled = compiledRules.get(rules);
  if (compiled === undefined) {
    compiled = {
      fields: new Set(rules.fields.map((field) => field.toLowerCase())),
      hashField: rules.selfConsistency.record.hash.toLowerCase(),
      format: new RegExp(rules.format),
      keepLiteral: new Set(rules.keepLiteral),
    };
    compiledRules.set(rules, compiled);
  }
  return compiled;
}

/** Whether `name` is one of the rule's `fields`, matched case-insensitively. */
export function isChainHashField(name: string, rules: ChainHashRules): boolean {
  return compile(rules).fields.has(name.toLowerCase());
}

// Hex text as given, or bytes (a binary row column) as lowercase hex.
function hexText(value: unknown): string | undefined {
  if (Buffer.isBuffer(value)) return value.toString('hex');
  return typeof value === 'string' ? value : undefined;
}

// NULL renders as '' (COALESCE in the procedure).
function optionalText(value: unknown): string | undefined {
  if (value === null) return '';
  return typeof value === 'string' ? value : undefined;
}

/**
 * Whether the entry hash of `record` (a JSON object or a decoded row) equals `usp_audit_append`'s over the record's
 * own fields; undefined when the record lacks a `selfConsistency.record` field (matched case-insensitively).
 */
export function chainEntryVerdict(record: Readonly<Record<string, unknown>>, rules: ChainHashRules): boolean | undefined {
  const keys = new Map(Object.keys(record).map((key): [string, string] => [key.toLowerCase(), key]));
  const roles = rules.selfConsistency.record;
  if (Object.values(roles).some((field) => !keys.has(field.toLowerCase()))) return undefined;
  const read = (field: string): unknown => record[keys.get(field.toLowerCase()) ?? field];
  const { format } = compile(rules);
  const [requestId, seq, action, at] = [read(roles.requestId), read(roles.seq), read(roles.action), read(roles.at)];
  const [actor, detail] = [optionalText(read(roles.actor)), optionalText(read(roles.detail))];
  const [previous, hash] = [hexText(read(roles.previous)), hexText(read(roles.hash))];
  if (
    typeof requestId !== 'string' ||
    (typeof seq !== 'string' && typeof seq !== 'number') ||
    typeof action !== 'string' ||
    typeof at !== 'string' ||
    actor === undefined ||
    detail === undefined ||
    previous === undefined ||
    hash === undefined ||
    !format.test(previous) ||
    !format.test(hash)
  ) {
    return false;
  }
  const canonical = [
    requestId.padEnd(CHAR_ID_LENGTH, ' '),
    String(seq),
    action,
    actor === '' ? '' : actor.padEnd(CHAR_ID_LENGTH, ' '),
    detail,
    at,
  ].join(SEPARATOR);
  // HASHBYTES('SHA2_256', prev_hash + CAST(canonical AS varbinary(max))): the nvarchar text hashes as UTF-16LE.
  const expected = createHash('sha256')
    .update(Buffer.from(previous, 'hex'))
    .update(Buffer.from(canonical, 'utf16le'))
    .digest();
  return expected.equals(Buffer.from(hash, 'hex'));
}

function assign(counter: OrdinalCounter, key: string, template: string): string {
  let ordinal = counter.byId.get(key);
  if (ordinal === undefined) {
    ordinal = counter.next;
    counter.byId.set(key, ordinal);
    counter.next = ordinal + 1;
  }
  return template.replaceAll('{n}', String(ordinal));
}

/**
 * Replacement of `value` (hex text, or bytes of a binary column) stored under `field`: the mismatch placeholder for
 * the entry hash of a record whose `verdict` is false, a `keepLiteral` hash as hex, else the hash's scenario ordinal,
 * keyed by its exact hex. Undefined when `field` is not a chain-hash field or `value` does not match `format`.
 */
export function chainHashValue(
  field: string,
  value: unknown,
  verdict: boolean | undefined,
  counter: OrdinalCounter,
  rules: ChainHashRules,
): string | undefined {
  const compiled = compile(rules);
  const hex = hexText(value);
  if (!compiled.fields.has(field.toLowerCase()) || hex === undefined || !compiled.format.test(hex)) return undefined;
  if (verdict === false && field.toLowerCase() === compiled.hashField) return rules.selfConsistency.mismatchPlaceholder;
  if (compiled.keepLiteral.has(hex)) return hex;
  return assign(counter, hex, rules.placeholder);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, counter: OrdinalCounter, rules: ChainHashRules): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, counter, rules));
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) return value;
  const verdict = chainEntryVerdict(value, rules);
  // Sorted keys, as ids.ts walks them, so ordinals follow first sight in the same order on both sides.
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key): [string, unknown] => [
        key,
        chainHashValue(key, value[key], verdict, counter, rules) ?? walk(value[key], counter, rules),
      ]),
  );
}

/**
 * New copy of JSON `value` with every chain-hash field replaced as {@link chainHashValue} does, continuing the
 * scenario's hash ordinals in `counter`; other values are kept and `value` is never mutated.
 */
export function normaliseChainHashes(value: unknown, counter: OrdinalCounter, rules: ChainHashRules): unknown {
  return walk(value, counter, rules);
}
