// Error types shared by golden capture, replay and comparison.

/** Locations of a case's golden set and replay output, repository- or `${OPT2_STATE_DIR}`-relative, never absolute. */
export interface HaltEvidence {
  golden: string;
  replay: string;
}

// Kept as a literal variable reference so exception entries written from it hold no machine path.
const REPLAY_ROOT = '${OPT2_STATE_DIR}/golden/replay';

/** Portable evidence paths of scenario `scenarioId`, the one place both halt producers (capture, replay) build them. */
export function haltEvidence(scenarioId: string): HaltEvidence {
  return { golden: `harness/golden/sets/${scenarioId}.json`, replay: `${REPLAY_ROOT}/${scenarioId}.json` };
}

/** Fields of an {@link EquivalenceImpossible}. */
export interface EquivalenceImpossibleOptions {
  scenario: string;
  /** Canonical route key of the halted case. */
  routeKey: string;
  reason: string;
  evidence: HaltEvidence;
  /** Observed difference; the reason stands in for it when absent. */
  difference?: string;
}

/** Raised for a case that cannot be made equivalent to legacy; the case is recorded halted and the run continues. */
export class EquivalenceImpossible extends Error {
  override readonly name: string = 'EquivalenceImpossible';
  readonly scenario: string;
  readonly routeKey: string;
  readonly reason: string;
  readonly evidence: HaltEvidence;
  readonly difference?: string;

  constructor(opts: EquivalenceImpossibleOptions) {
    super(`${opts.scenario} ${opts.routeKey}: ${opts.reason}`);
    this.scenario = opts.scenario;
    this.routeKey = opts.routeKey;
    this.reason = opts.reason;
    this.evidence = opts.evidence;
    this.difference = opts.difference;
  }
}

/** True for an {@link EquivalenceImpossible}, including one thrown by another copy of this module. */
export function isEquivalenceImpossible(value: unknown): value is EquivalenceImpossible {
  return value instanceof EquivalenceImpossible || (value instanceof Error && value.name === 'EquivalenceImpossible');
}

/** One entry of `opt2/exceptions-list.json`. */
export interface ExceptionEntry {
  id: string;
  scenario: string;
  routeKey: string;
  /** Further route keys the entry covers. */
  appliesTo?: string[];
  difference: string;
  decision: 'preserve' | 'fix';
  reason: string;
  status: 'open' | 'accepted' | 'halted';
  evidence: HaltEvidence;
  sourceSha: string;
}

/** Halted `preserve` exceptions entry recording `err`. */
export function haltedExceptionEntry(err: EquivalenceImpossible, opts: { id: string; sourceSha: string }): ExceptionEntry {
  return {
    id: opts.id,
    scenario: err.scenario,
    routeKey: err.routeKey,
    difference: err.difference ?? err.reason,
    decision: 'preserve',
    reason: err.reason,
    status: 'halted',
    evidence: { golden: err.evidence.golden, replay: err.evidence.replay },
    sourceSha: opts.sourceSha,
  };
}

/** Invalid catalogue or normalise rules, a missing golden set, or an unresolved binding. */
export class GoldenConfigError extends Error {
  override readonly name: string = 'GoldenConfigError';
  /** File or JSON path the problem was found at. */
  readonly path?: string;

  constructor(message: string, opts: { path?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.path = opts.path;
  }
}

/** A secret placeholder without a unique value in its source; the message names where it looked, never a value. */
export class MissingSecretError extends Error {
  override readonly name: string = 'MissingSecretError';

  /**
   * @param placeholder Unresolved placeholder, e.g. `${secret:seed:<username>}`.
   * @param source Env var name or file path that was searched.
   */
  constructor(
    readonly placeholder: string,
    readonly source: string,
  ) {
    super(`Secret ${placeholder} has no unique value in ${source}`);
  }
}
