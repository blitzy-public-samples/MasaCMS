// Runtime transition runner of @opt2/platform/state-machine; generate-table.ts shares its `evaluate` core.
import { SAME_NEW_VERSION, type TransitionDefinition } from './definition.js';
import { buildEnvelope, LEGACY_ERROR_MAP, type LegacyEnvelope } from '../legacy-compat/index.js';

/** Error codes of an illegal and of a forbidden transition; an active guard answers with its own name instead. */
export const TRANSITION_ERROR_CODES = { illegal: 'illegalTransition', forbidden: 'authorization' } as const;

/** A rejection's internal outcome label and the message the legacy fixture answers it with. */
export interface TransitionErrorBody {
  code: string;
  message: string;
}

/** Error body for `code`; the message is the code itself, except the fixture's forbidden message for `authorization`. */
export function transitionError(code: string): TransitionErrorBody {
  if (code === TRANSITION_ERROR_CODES.forbidden) return { code, message: LEGACY_ERROR_MAP.authorization.message };
  return { code, message: code };
}

// Code of the legacy fixture's 403 forbidden and 409 conflict error-map entries.
const REJECTION_ENVELOPE_CODE = LEGACY_ERROR_MAP.authorization.code;

/** Outcome of one transition request. */
export type TransitionDecision<S extends string, R extends string> =
  | { outcome: 'ok'; to: S; newVersion: boolean; actingRole: R }
  | { outcome: 'illegal'; status: 409; error: TransitionErrorBody }
  | { outcome: 'forbidden'; status: 403; error: TransitionErrorBody };

/** A transition request with its active guard already resolved. */
export interface EvaluateInput {
  state: string;
  action: string;
  roles: readonly string[];
  /** Name of the active guard, or null when none applies. */
  activeGuard: string | null;
}

/** A transition request as a route handler sees it: stored state, route action and verified token roles. */
export interface DecideInput<C> {
  state: string;
  action: string;
  roles: readonly string[];
  /** Context the definition's guards test; without it no guard is evaluated. */
  guards?: C;
}

type TransitionRejection = Extract<TransitionDecision<string, string>, { outcome: 'illegal' | 'forbidden' }>;

type EnvelopeContext = { method: string; params?: Record<string, unknown> };

function isMember<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

function illegal(code: string): TransitionRejection {
  return { outcome: 'illegal', status: 409, error: transitionError(code) };
}

/** Decides one transition; applies the precedence documented in generate-table.ts. */
export function evaluate<S extends string, A extends string, R extends string, C>(
  def: TransitionDefinition<S, A, R, C>,
  input: EvaluateInput,
): TransitionDecision<S, R> {
  const { state, action } = input;
  if (input.activeGuard !== null) return illegal(input.activeGuard);
  if (!isMember(def.states, state) || isMember(def.terminal, state) || !isMember(def.actions, action)) {
    return illegal(TRANSITION_ERROR_CODES.illegal);
  }
  const row = def.rows.find((candidate) => candidate.action === action && candidate.from.includes(state));
  if (row === undefined) return illegal(TRANSITION_ERROR_CODES.illegal);

  const actingRole = def.roles.find((role) => row.roles.includes(role) && input.roles.includes(role));
  if (actingRole === undefined) {
    return { outcome: 'forbidden', status: 403, error: transitionError(TRANSITION_ERROR_CODES.forbidden) };
  }
  return row.to === SAME_NEW_VERSION
    ? { outcome: 'ok', to: state, newVersion: true, actingRole }
    : { outcome: 'ok', to: row.to, newVersion: false, actingRole };
}

/** Resolves the first applying guard in definition order, then delegates to `evaluate`. */
export function decide<S extends string, A extends string, R extends string, C>(
  def: TransitionDefinition<S, A, R, C>,
  input: DecideInput<C>,
): TransitionDecision<S, R> {
  const { guards } = input;
  const active = guards === undefined ? undefined : def.guards?.find((guard) => guard.applies(guards));
  const activeGuard = active?.name ?? null;
  return evaluate(def, { state: input.state, action: input.action, roles: input.roles, activeGuard });
}

/** Legacy error envelope of a rejected transition; callers serialize it at `rejection.status`. */
export function transitionErrorEnvelope(rejection: TransitionRejection, ctx: EnvelopeContext): LegacyEnvelope {
  return buildEnvelope({
    method: ctx.method,
    params: ctx.params,
    error: { code: REJECTION_ENVELOPE_CODE, message: rejection.error.message },
  });
}

/** Thrown by `applyTransition` for an illegal or forbidden transition; `statusCode` follows the Fastify convention. */
export class TransitionRejectedError extends Error {
  override readonly name = 'TransitionRejectedError';
  readonly statusCode: 409 | 403;
  readonly code: string;

  constructor(readonly decision: TransitionRejection) {
    super(decision.error.message);
    this.statusCode = decision.status;
    this.code = decision.error.code;
  }

  /** Legacy error envelope of this rejection. */
  toEnvelope(ctx: EnvelopeContext): LegacyEnvelope {
    return transitionErrorEnvelope(this.decision, ctx);
  }
}

/** A legal transition as `persist` receives it. */
export interface AppliedTransition<S extends string, A extends string, R extends string> {
  from: S;
  action: A;
  to: S;
  newVersion: boolean;
  actingRole: R;
}

/**
 * Decides a transition and runs `persist` only when it is legal; a rejection throws `TransitionRejectedError` first.
 * @param persist Writes the new state and its audit rows on the caller's open transaction; its result is returned.
 */
export async function applyTransition<S extends string, A extends string, R extends string, C, T>(
  def: TransitionDefinition<S, A, R, C>,
  input: DecideInput<C>,
  persist: (transition: AppliedTransition<S, A, R>) => Promise<T>,
): Promise<T> {
  const decision = decide(def, input);
  if (decision.outcome !== 'ok') throw new TransitionRejectedError(decision);
  // An ok decision is only reached for a state in `def.states` and an action in `def.actions`.
  return await persist({
    from: input.state as S,
    action: input.action as A,
    to: decision.to,
    newVersion: decision.newVersion,
    actingRole: decision.actingRole,
  });
}
