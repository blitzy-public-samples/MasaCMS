import { isCfUuid } from '@opt2/platform/legacy-compat';
import type { IdRules } from './rules.js';

/** First-sight ordinals of one id kind within a scenario, keyed by the kind's ordinal key. */
export interface OrdinalCounter {
  readonly byId: Map<string, number>;
  next: number;
}

/**
 * One scenario side's id ordinals: CF UUIDs in `byId`/`next`. RFC 4122 uuids are numbered apart, so an
 * event or tenant id present on one side only never shifts the CF UUID numbering of the steps after it.
 */
export interface IdOrdinals extends OrdinalCounter {
  readonly rfc4122: OrdinalCounter;
}

/** Fresh ordinals for one scenario side; numbering starts at 1. */
export function createIdOrdinals(): IdOrdinals {
  return { byId: new Map(), next: 1, rfc4122: { byId: new Map(), next: 1 } };
}

/** Candidate CF UUIDs (8-4-4-16 hex) in text, not adjoining further hex digits or hyphens; confirm with `isCfUuid`. */
export const CF_UUID_IN_TEXT = /(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}(?![0-9A-Fa-f-])/g;

interface IdMatcher {
  readonly find: RegExp;
  readonly confirm: (candidate: string) => boolean;
  /** Template holding the `{n}` ordinal slot. */
  readonly placeholder: string;
  readonly ordinalKey: (id: string) => string;
}

interface CompiledIdRules {
  readonly cfUuid: IdMatcher;
  readonly rfc4122: IdMatcher | undefined;
  /** Upper-cased literals that stay as they are even when a pattern matches them. */
  readonly keepLiteral: ReadonlySet<string>;
}

const upperCase = (id: string): string => id.toUpperCase();
const exact = (id: string): string => id;
// The YAML pattern is the whole definition of an RFC 4122 uuid; legacy-compat has no predicate for it.
const anyMatch = (): boolean => true;

// Without rules, ordinal keys fold to upper case, as CFML compares ids (isValid('uuid'), SQL Server's default
// collation); with rules, `ordinalKey` decides. RFC 4122 uuids are replaced only when rules declare them.
const DEFAULT_RULES: CompiledIdRules = {
  cfUuid: { find: CF_UUID_IN_TEXT, confirm: isCfUuid, placeholder: '<id:{n}>', ordinalKey: upperCase },
  rfc4122: undefined,
  keepLiteral: new Set(),
};

// Loaded rules are deep-frozen, so each object compiles once.
const compiledRules = new WeakMap<IdRules, CompiledIdRules>();

type IdPatternRule = Pick<IdRules, 'pattern' | 'flags' | 'boundary' | 'placeholder' | 'ordinalKey'>;

function matcher(rule: IdPatternRule, confirm: (candidate: string) => boolean): IdMatcher {
  return {
    find: new RegExp(`(?<!${rule.boundary})(?:${rule.pattern})(?!${rule.boundary})`, `${rule.flags}g`),
    confirm,
    placeholder: rule.placeholder,
    ordinalKey: rule.ordinalKey === 'exact' ? exact : upperCase,
  };
}

function compile(rules: IdRules | undefined): CompiledIdRules {
  if (rules === undefined) return DEFAULT_RULES;
  let compiled = compiledRules.get(rules);
  if (compiled === undefined) {
    compiled = {
      cfUuid: matcher(rules, isCfUuid),
      rfc4122: matcher(rules.rfc4122, anyMatch),
      keepLiteral: new Set(rules.keepLiteral.map(upperCase)),
    };
    compiledRules.set(rules, compiled);
  }
  return compiled;
}

function render(template: string, ordinal: number): string {
  return template.replaceAll('{n}', String(ordinal));
}

function assign(counter: OrdinalCounter, key: string, template: string): string {
  let ordinal = counter.byId.get(key);
  if (ordinal === undefined) {
    ordinal = counter.next;
    counter.byId.set(key, ordinal);
    counter.next = ordinal + 1;
  }
  return render(template, ordinal);
}

/** Placeholder of CF UUID `id`, assigning the scenario's next ordinal on first sight. */
export function ordinalFor(id: string, state: IdOrdinals, rules?: IdRules): string {
  const { cfUuid } = compile(rules);
  return assign(state, cfUuid.ordinalKey(id), cfUuid.placeholder);
}

/** Placeholder already assigned to CF UUID `id`, or undefined when unseen; never assigns. */
export function peekOrdinal(id: string, state: IdOrdinals, rules?: IdRules): string | undefined {
  const { cfUuid } = compile(rules);
  const ordinal = state.byId.get(cfUuid.ordinalKey(id));
  return ordinal === undefined ? undefined : render(cfUuid.placeholder, ordinal);
}

function replaceIds(s: string, kind: IdMatcher, counter: OrdinalCounter, keepLiteral: ReadonlySet<string>): string {
  return s.replace(kind.find, (candidate) =>
    !kind.confirm(candidate) || keepLiteral.has(upperCase(candidate))
      ? candidate
      : assign(counter, kind.ordinalKey(candidate), kind.placeholder),
  );
}

function replaceAllKinds(s: string, state: IdOrdinals, compiled: CompiledIdRules): string {
  const withCfUuids = replaceIds(s, compiled.cfUuid, state, compiled.keepLiteral);
  return compiled.rfc4122 === undefined
    ? withCfUuids
    : replaceIds(withCfUuids, compiled.rfc4122, state.rfc4122, compiled.keepLiteral);
}

/** `s` with every CF UUID in it, and every RFC 4122 uuid when `rules` declare them, replaced by its placeholder. */
export function normaliseIdsInString(s: string, state: IdOrdinals, rules?: IdRules): string {
  return replaceAllKinds(s, state, compile(rules));
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, state: IdOrdinals, compiled: CompiledIdRules): unknown {
  if (typeof value === 'string') return replaceAllKinds(value, state, compiled);
  if (Array.isArray(value)) return value.map((item: unknown) => walk(item, state, compiled));
  if (typeof value !== 'object' || value === null || !isPlainObject(value)) return value;
  // Sorted keys: CFML struct key order differs from the target's, and ordinals follow first sight.
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key): [string, unknown] => [replaceAllKinds(key, state, compiled), walk(value[key], state, compiled)]),
  );
}

/**
 * New copy of `value` with ids replaced in every string and plain-object key; arrays keep their order and
 * object keys are visited in code-unit order. Other values are returned as they are; `value` is never mutated.
 */
export function normaliseIds(value: unknown, state: IdOrdinals, rules?: IdRules): unknown {
  return walk(value, state, compile(rules));
}
