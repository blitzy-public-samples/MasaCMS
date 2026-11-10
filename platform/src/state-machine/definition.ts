/** Row target that keeps the current state and creates a new version. */
export const SAME_NEW_VERSION = 'same-new-version' as const;

/** Literal type of `SAME_NEW_VERSION`. */
export type SameNewVersion = typeof SAME_NEW_VERSION;

/** One legal move: `action`, by any of `roles`, from any `from` state to `to`. */
export interface TransitionRow<S extends string, A extends string, R extends string> {
  readonly from: readonly S[];
  readonly action: A;
  readonly roles: readonly R[];
  readonly to: S | SameNewVersion;
}

/** Context predicate that, while it applies, makes every action illegal with `name` as the error code. */
export interface TransitionGuard<C> {
  readonly name: string;
  applies(ctx: C): boolean;
}

/** A lifecycle's states, actions, roles, terminal states, legal rows and guards. */
export interface TransitionDefinition<S extends string, A extends string, R extends string, C = unknown> {
  readonly service: string;
  readonly states: readonly S[];
  readonly actions: readonly A[];
  readonly roles: readonly R[];
  // NoInfer: a misspelt state, action or role in `terminal` or `rows` is a type error instead of widening the union.
  readonly terminal: readonly NoInfer<S>[];
  readonly rows: readonly TransitionRow<NoInfer<S>, NoInfer<A>, NoInfer<R>>[];
  readonly guards?: readonly TransitionGuard<C>[];
}

/** Thrown by `defineTransitions` for an inconsistent definition. */
export class TransitionDefinitionError extends Error {
  override readonly name = 'TransitionDefinitionError';
}

// The runner's own error codes; a guard with one of these names would be indistinguishable from them.
const RESERVED_GUARD_NAMES: ReadonlySet<string> = new Set(['illegalTransition', 'authorization']);

function fail(message: string): never {
  throw new TransitionDefinitionError(message);
}

function distinct(label: string, values: readonly string[]): Set<string> {
  if (values.length === 0) fail(`${label} must not be empty`);
  const set = new Set(values);
  if (set.size !== values.length) {
    fail(`${label} contains duplicate '${values.find((value, index) => values.indexOf(value) !== index)}'`);
  }
  return set;
}

/** Validates a lifecycle definition and returns a frozen copy; throws `TransitionDefinitionError` on the first violation. */
export function defineTransitions<const S extends string, const A extends string, const R extends string, C = unknown>(
  def: TransitionDefinition<S, A, R, C>,
): TransitionDefinition<S, A, R, C> {
  if (def.service.length === 0) fail('service must not be empty');
  const states = distinct('states', def.states);
  const actions = distinct('actions', def.actions);
  const roles = distinct('roles', def.roles);
  if (states.has(SAME_NEW_VERSION)) fail(`states must not contain '${SAME_NEW_VERSION}'`);
  const terminal = new Set<string>(def.terminal);
  for (const state of terminal) {
    if (!states.has(state)) fail(`terminal state '${state}' is not in states`);
  }

  const pairs = new Set<string>();
  def.rows.forEach((row, index) => {
    const at = `rows[${index}] '${row.action}'`;
    if (!actions.has(row.action)) fail(`${at}: action is not in actions`);
    if (row.from.length === 0) fail(`${at}: from must not be empty`);
    if (row.roles.length === 0) fail(`${at}: roles must not be empty`);
    if (row.to !== SAME_NEW_VERSION && !states.has(row.to)) fail(`${at}: to '${row.to}' is not in states`);
    for (const role of row.roles) {
      if (!roles.has(role)) fail(`${at}: role '${role}' is not in roles`);
    }
    for (const from of row.from) {
      if (!states.has(from)) fail(`${at}: from state '${from}' is not in states`);
      if (terminal.has(from)) fail(`${at}: from contains terminal state '${from}'`);
      const pair = JSON.stringify([from, row.action]);
      if (pairs.has(pair)) fail(`${at}: (${from}, ${row.action}) is already defined by another row`);
      pairs.add(pair);
    }
  });

  const guardNames = new Set<string>();
  for (const { name } of def.guards ?? []) {
    if (name.length === 0) fail('guard name must not be empty');
    if (RESERVED_GUARD_NAMES.has(name)) fail(`guard name '${name}' is reserved`);
    if (guardNames.has(name)) fail(`guard name '${name}' is duplicated`);
    guardNames.add(name);
  }

  return Object.freeze({
    service: def.service,
    states: Object.freeze([...def.states]),
    actions: Object.freeze([...def.actions]),
    roles: Object.freeze([...def.roles]),
    terminal: Object.freeze([...def.terminal]),
    rows: Object.freeze(
      def.rows.map((row) =>
        Object.freeze({
          from: Object.freeze([...row.from]),
          action: row.action,
          roles: Object.freeze([...row.roles]),
          to: row.to,
        }),
      ),
    ),
    ...(def.guards === undefined ? {} : { guards: Object.freeze([...def.guards]) }),
  });
}

/** Roles a lifecycle route lists in `config.opt2.requires`. */
export function lifecycleRoles<R extends string>(def: TransitionDefinition<string, string, R>): readonly R[] {
  return def.roles;
}
