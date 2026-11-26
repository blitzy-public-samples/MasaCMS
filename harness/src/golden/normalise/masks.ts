// Known-issue masks: where each known legacy issue may differ, and how differences there are classified.
import { matchRouteKey, normaliseRouteKey, parseSetCookie, type RouteKeyResult } from '@opt2/platform/legacy-compat';
import type { CompareKind, Step } from '../catalogue.js';
import { GoldenConfigError } from '../errors.js';
import {
  KNOWN_ISSUE_IDS,
  isKnownIssueId,
  type KnownIssueId,
  type KnownIssueRule,
  type KnownIssueScope,
  type NormaliseRules,
} from './rules.js';

/** Whether a difference counts against parity or is a masked known legacy issue. */
export type Classification = 'difference' | 'known-issue';

/** How a normalised value differs between golden and replay. */
export type DifferenceKind = 'changed' | 'missing' | 'extra' | 'order' | 'status';

/** One difference between a golden and a replayed step or side effect. */
export interface Difference {
  step: string;
  /** Dotted, indexed path inside the normalised step (`auth.cookies[1].rotation`, `status`) or `sideEffects.<kind>…`. */
  path: string;
  kind: DifferenceKind;
  expected: unknown;
  actual: unknown;
  classification: Classification;
  maskId?: KnownIssueId;
}

/** Field of a normalised cookie a mask may be limited to. */
export type CookieMaskField = 'rotation';

/**
 * Where a mask applies inside a step.
 * `dom`: elements matching `selector`, only those whose text or value matches `textPattern`, and only the listed
 * model `attributes` when given; resolved by the DOM model. `header`: that response header, narrowed to the
 * Set-Cookie values of `cookieNames` when given. `cookie`: the named cookie entries being missing or extra, or,
 * with `field`, a difference in that field.
 */
export type MaskLocation =
  | { kind: 'dom'; selector: string; textPattern?: RegExp; attributes?: readonly string[] }
  | { kind: 'header'; name: string; cookieNames?: readonly string[] }
  | { kind: 'cookie'; name: string; field?: CookieMaskField }
  | { kind: 'status' }
  | { kind: 'body' };

/** A known-issue mask resolved for one step. */
export interface KnownIssueMask {
  id: KnownIssueId;
  scenarios: string[];
  routeKeys: string[];
  locations: MaskLocation[];
  description: string;
  /** Compare kinds the mask is limited to; absent means every kind. */
  compareKinds?: readonly CompareKind[];
}

/** The parts of a normalised step that header, cookie, status and body locations resolve against. */
export interface MaskableStep {
  status: number;
  headers?: Readonly<Record<string, string | readonly string[]>>;
  auth?: { readonly cookies: readonly { readonly name: string }[] };
  envelope?: unknown;
  body?: unknown;
  domModel?: unknown;
  export?: unknown;
}

/** The masked paths of one step on each side. */
export interface MaskedSides {
  golden: Readonly<Record<string, KnownIssueId>>;
  replay: Readonly<Record<string, KnownIssueId>>;
}

/** Masked paths per step name: the union of both sides, and optionally each side for `missing`/`extra` differences. */
export interface MaskContext {
  maskedPathsByStep: ReadonlyMap<string, Readonly<Record<string, KnownIssueId>>>;
  maskedSidesByStep?: ReadonlyMap<string, MaskedSides>;
}

const WILDCARD = '*';
// The path of one whole cookie entry, as cookie locations resolve it.
const COOKIE_ENTRY = /^auth\.cookies\[\d+\]$/;
const PLACEHOLDER_OPEN = '<known-issue:';
const PLACEHOLDER_SPLIT = new RegExp(`(${PLACEHOLDER_OPEN}[^<>]*>)`);
// What a placeholder may stand for besides itself: one non-empty run of non-space text holding no placeholder.
const COUNTERPART_RUN = `(?:(?!${PLACEHOLDER_OPEN})\\S)+`;

/** Placeholder that known-issue mask `id` leaves in model text where it lifted a text component out. */
export function maskedTextPlaceholder(id: KnownIssueId): string {
  return `${PLACEHOLDER_OPEN}${id}>`;
}

/** `text` split around known-issue placeholders: literal text at even indexes, placeholders at odd ones. */
export function splitMaskedText(text: string): string[] {
  return text.split(PLACEHOLDER_SPLIT);
}

// Body representations of a normalised step, with the compare kind each belongs to.
const BODY_KINDS: ReadonlyArray<readonly [keyof MaskableStep, CompareKind | undefined]> = [
  ['envelope', 'envelope'],
  ['body', undefined],
  ['domModel', 'dom'],
  ['export', 'export'],
];

function listed(refs: readonly string[], scenarioId: string): boolean {
  return refs.includes(WILDCARD) || refs.includes(scenarioId);
}

function routeMatches(routeKeys: readonly string[], routeKey: string | RouteKeyResult): boolean {
  if (routeKeys.includes(WILDCARD)) return true;
  if (typeof routeKey !== 'string') return matchRouteKey(routeKey, routeKeys) !== undefined;
  const key = normaliseRouteKey(routeKey);
  return routeKeys.some((candidate) => normaliseRouteKey(candidate) === key);
}

// Presence or absence masks the cookie entry being missing or extra; equality across login masks its rotation field.
function cookieLocations(name: string, observations: KnownIssueScope['observations']): MaskLocation[] {
  const locations: MaskLocation[] = [];
  if (observations === undefined || observations.some((o) => o !== 'value-equal-across-login')) {
    locations.push({ kind: 'cookie', name });
  }
  if (observations === undefined || observations.includes('value-equal-across-login')) {
    locations.push({ kind: 'cookie', name, field: 'rotation' });
  }
  return locations;
}

function ruleLocations(scope: KnownIssueScope, setCookieHeader: string): MaskLocation[] {
  const textPattern = scope.textPattern === undefined ? undefined : new RegExp(scope.textPattern);
  const dom = (scope.selectors ?? []).map(
    (selector): MaskLocation => ({
      kind: 'dom',
      selector,
      ...(textPattern === undefined ? {} : { textPattern }),
      ...(scope.attributes === undefined ? {} : { attributes: [...scope.attributes] }),
    }),
  );
  const headers = (scope.headers ?? []).map(
    (name): MaskLocation =>
      scope.cookieNames !== undefined && name.toLowerCase() === setCookieHeader.toLowerCase()
        ? { kind: 'header', name, cookieNames: [...scope.cookieNames] }
        : { kind: 'header', name },
  );
  const cookies = (scope.cookieNames ?? []).flatMap((name) => cookieLocations(name, scope.observations));
  return [...dom, ...headers, ...cookies];
}

function toMask(rule: KnownIssueRule, flagged: boolean, setCookieHeader: string): KnownIssueMask {
  const locations = ruleLocations(rule.scope, setCookieHeader);
  if (flagged) locations.push(...(rule.scope.steps?.parts ?? []).map((kind): MaskLocation => ({ kind })));
  const mask: KnownIssueMask = {
    id: rule.id,
    scenarios: [...rule.appliesTo],
    routeKeys: [...rule.routeKeys],
    locations,
    description: rule.title,
  };
  if (rule.scope.compareKinds !== undefined) mask.compareKinds = [...rule.scope.compareKinds];
  return mask;
}

/**
 * Masks that apply to one step: those whose scenarios and route keys both list it, plus the one its catalogue
 * `knownIssue` names, which also brings that mask's step parts (status, body).
 * @param routeKey The step's live route key; a string matches by normalised equality.
 * Throws `GoldenConfigError` when the step names an unknown known issue, or one not declared for its scenario or route.
 */
export function masksFor(
  scenarioId: string,
  routeKey: string | RouteKeyResult,
  rules: NormaliseRules,
  step?: Pick<Step, 'name' | 'knownIssue'>,
): KnownIssueMask[] {
  const flagged = step?.knownIssue;
  const fail = (message: string): never => {
    throw new GoldenConfigError(`${scenarioId} step ${step?.name ?? '?'}: knownIssue ${flagged ?? ''} ${message}`, {
      path: `scenario ${scenarioId}`,
    });
  };
  if (flagged !== undefined && !isKnownIssueId(flagged)) fail(`is not one of ${KNOWN_ISSUE_IDS.join(', ')}`);

  const masks: KnownIssueMask[] = [];
  for (const rule of rules.knownIssues) {
    const isFlag = rule.id === flagged;
    if (isFlag) {
      // A flag outside the mask's declared scenarios or routes would mask beyond its scope: a configuration error.
      const allowed = rule.scope.steps?.appliesTo ?? rule.appliesTo;
      if (!listed(allowed, scenarioId)) fail(`is declared for ${allowed.join(', ')} only`);
      if (!routeMatches(rule.routeKeys, routeKey)) fail(`is declared for routes ${rule.routeKeys.join(', ')} only`);
    }
    if (isFlag || (listed(rule.appliesTo, scenarioId) && routeMatches(rule.routeKeys, routeKey))) {
      masks.push(toMask(rule, isFlag, rules.auth.cookies.header));
    }
  }
  return masks;
}

function applies(mask: KnownIssueMask, kind: CompareKind | undefined): boolean {
  if (mask.compareKinds === undefined) return true;
  return kind !== undefined && mask.compareKinds.includes(kind);
}

function headerPaths(
  headers: NonNullable<MaskableStep['headers']>,
  location: Extract<MaskLocation, { kind: 'header' }>,
): string[] {
  const paths: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== location.name.toLowerCase()) continue;
    const base = `headers.${name}`;
    const cookieNames = location.cookieNames;
    if (cookieNames === undefined) {
      paths.push(base);
    } else if (typeof value === 'string') {
      if (cookieNames.includes(parseSetCookie(value).name)) paths.push(base);
    } else {
      value.forEach((entry, index) => {
        if (cookieNames.includes(parseSetCookie(entry).name)) paths.push(`${base}[${index}]`);
      });
    }
  }
  return paths;
}

function locationPaths(step: MaskableStep, mask: KnownIssueMask, location: MaskLocation): string[] {
  switch (location.kind) {
    case 'dom':
      return [];
    case 'header':
      return step.headers === undefined || !applies(mask, 'headers') ? [] : headerPaths(step.headers, location);
    case 'cookie': {
      if (step.auth === undefined || !applies(mask, 'auth')) return [];
      const paths: string[] = [];
      step.auth.cookies.forEach((cookie, index) => {
        if (cookie.name !== location.name) return;
        const entry = `auth.cookies[${index}]`;
        paths.push(location.field === undefined ? entry : `${entry}.${location.field}`);
      });
      return paths;
    }
    case 'status':
      return applies(mask, 'status') ? ['status'] : [];
    case 'body':
      return BODY_KINDS.filter(([key, kind]) => step[key] !== undefined && applies(mask, kind)).map(([key]) => key);
  }
}

/**
 * Concrete paths of a normalised step covered by the header, cookie, status and body locations of `masks`;
 * DOM locations are resolved by the DOM model. The first mask to claim a path keeps it.
 */
export function pathMasks(step: MaskableStep, masks: readonly KnownIssueMask[]): Record<string, KnownIssueId> {
  const masked: Record<string, KnownIssueId> = {};
  for (const mask of masks) {
    for (const location of mask.locations) {
      for (const path of locationPaths(step, mask, location)) {
        if (!Object.hasOwn(masked, path)) masked[path] = mask.id;
      }
    }
  }
  return masked;
}

// A masked cookie entry covers only that entry being missing or extra; any other masked path covers itself and below.
function covers(maskedPath: string, path: string, kind: DifferenceKind): boolean {
  if (COOKIE_ENTRY.test(maskedPath)) return path === maskedPath && (kind === 'missing' || kind === 'extra');
  return path === maskedPath || path.startsWith(`${maskedPath}.`) || path.startsWith(`${maskedPath}[`);
}

// The most specific masked path covering `path` names the mask.
function coveringMask(
  path: string,
  kind: DifferenceKind,
  masked: Readonly<Record<string, KnownIssueId>> | undefined,
): KnownIssueId | undefined {
  let best: { path: string; id: KnownIssueId } | undefined;
  for (const [maskedPath, id] of Object.entries(masked ?? {})) {
    if (covers(maskedPath, path, kind) && (best === undefined || maskedPath.length > best.path.length)) {
      best = { path: maskedPath, id };
    }
  }
  return best?.id;
}

// A missing value exists on the golden side only and an extra one on the replay side only.
function maskedPathsFor(
  ctx: MaskContext,
  step: string,
  kind: DifferenceKind,
): Readonly<Record<string, KnownIssueId>> | undefined {
  const sides = ctx.maskedSidesByStep?.get(step);
  if (sides !== undefined && kind === 'missing') return sides.golden;
  if (sides !== undefined && kind === 'extra') return sides.replay;
  return ctx.maskedPathsByStep.get(step);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The mask whose lifted text accounts for `other` differing from `text`: `other` reads as `text` with each placeholder
 * standing for itself or one counterpart run, and each placeholder standing for a run is of a mask `masked` names.
 * The first such placeholder names it.
 */
function liftedMask(
  text: string,
  other: string,
  masked: Readonly<Record<string, KnownIssueId>> | undefined,
): KnownIssueId | undefined {
  const parts = splitMaskedText(text);
  if (parts.length === 1) return undefined;
  const placeholders = parts.filter((_part, i) => i % 2 === 1);
  const source = parts
    .map((part, i) => (i % 2 === 0 ? escapeRegExp(part) : `(${escapeRegExp(part)}|${COUNTERPART_RUN})`))
    .join('');
  const match = new RegExp(`^${source}$`).exec(other);
  if (match === null) return undefined;
  const inStep = new Set<string>(Object.values(masked ?? {}));
  const replaced = placeholders.flatMap((placeholder, k) =>
    match[k + 1] === placeholder ? [] : [placeholder.slice(PLACEHOLDER_OPEN.length, -1)],
  );
  const [first] = replaced;
  return first !== undefined && isKnownIssueId(first) && replaced.every((id) => inStep.has(id)) ? first : undefined;
}

// A changed text differing only where a mask of the step lifted text out of one side; each side reads its own masks.
function liftedResidual(ctx: MaskContext, step: string, expected: unknown, actual: unknown): KnownIssueId | undefined {
  if (typeof expected !== 'string' || typeof actual !== 'string') return undefined;
  const sides = ctx.maskedSidesByStep?.get(step);
  const both = ctx.maskedPathsByStep.get(step);
  return liftedMask(expected, actual, sides?.golden ?? both) ?? liftedMask(actual, expected, sides?.replay ?? both);
}

/**
 * Classifies each difference: `known-issue` with its `maskId` when a masked path of its step covers it, or when it is
 * a changed text that differs only where a mask of its step lifted text out (see {@link maskedTextPlaceholder}),
 * otherwise `difference`. Returns new objects in input order.
 */
export function applyMasks(differences: readonly Difference[], ctx: MaskContext): Difference[] {
  return differences.map(({ step, path, kind, expected, actual }): Difference => {
    const maskId =
      coveringMask(path, kind, maskedPathsFor(ctx, step, kind)) ??
      (kind === 'changed' ? liftedResidual(ctx, step, expected, actual) : undefined);
    return maskId === undefined
      ? { step, path, kind, expected, actual, classification: 'difference' }
      : { step, path, kind, expected, actual, classification: 'known-issue', maskId };
  });
}
