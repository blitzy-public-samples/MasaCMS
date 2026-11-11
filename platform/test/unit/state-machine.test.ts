import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SAME_NEW_VERSION,
  TRANSITION_ERROR_CODES,
  TransitionDefinitionError,
  TransitionRejectedError,
  applyTransition,
  compareTableRows,
  decide,
  defineTransitions,
  evaluate,
  generateTable,
  lifecycleRoles,
  serializeTable,
  transitionError,
  transitionErrorEnvelope,
  writeTableJson,
  type EvaluateInput,
  type TransitionDecision,
  type TransitionDefinition,
  type TransitionGuard,
  type TransitionRow,
  type TransitionTableRow,
} from '../../src/state-machine/index.js';

interface Ctx {
  readonly blackout: boolean;
}

type LooseDefinition = TransitionDefinition<string, string, string, Ctx>;

const blackout: TransitionGuard<Ctx> = { name: 'blackout', applies: (ctx) => ctx.blackout === true };

const DEFINITION = {
  service: 'approvals',
  states: ['DRAFT', 'SUBMITTED', 'APPROVED'],
  actions: ['submit', 'approve', 'edit'],
  roles: ['author', 'approver'],
  terminal: ['APPROVED'],
  rows: [
    { from: ['DRAFT'], action: 'submit', roles: ['author'], to: 'SUBMITTED' },
    { from: ['SUBMITTED'], action: 'approve', roles: ['approver'], to: 'APPROVED' },
    { from: ['DRAFT'], action: 'edit', roles: ['author'], to: SAME_NEW_VERSION },
  ],
  guards: [blackout],
} as const;

const LOOSE: LooseDefinition = DEFINITION;

function row(overrides: Partial<TransitionRow<string, string, string>>): TransitionRow<string, string, string> {
  return { from: ['DRAFT'], action: 'submit', roles: ['author'], to: 'SUBMITTED', ...overrides };
}

describe('defineTransitions', () => {
  it('returns a copy equal to the definition', () => {
    const defined = defineTransitions(DEFINITION);
    expect(defined).toEqual(DEFINITION);
    expect(defined).not.toBe(DEFINITION);
    expect(defined.guards?.map((guard) => guard.applies({ blackout: true }))).toEqual([true]);
    expect(defined.guards?.map((guard) => guard.applies({ blackout: false }))).toEqual([false]);
  });

  it('freezes the definition, its arrays and every row', () => {
    const defined = defineTransitions(DEFINITION);
    const frozen = [
      defined,
      defined.states,
      defined.actions,
      defined.roles,
      defined.terminal,
      defined.rows,
      defined.guards,
      ...defined.rows.flatMap((each) => [each, each.from, each.roles]),
    ];
    expect(defined.guards).toHaveLength(1);
    expect(frozen.filter((value) => !Object.isFrozen(value))).toEqual([]);
  });

  it('is unaffected by later changes to the source arrays', () => {
    const states = ['DRAFT', 'SUBMITTED', 'APPROVED'];
    const from = ['DRAFT'];
    const rows: TransitionRow<string, string, string>[] = [
      { from, action: 'submit', roles: ['author'], to: 'SUBMITTED' },
    ];
    const guards = [blackout];
    const defined = defineTransitions<string, string, string, Ctx>({ ...LOOSE, states, rows, guards });
    states.push('ARCHIVED');
    from.push('SUBMITTED');
    rows.push(row({ action: 'approve' }));
    guards.push({ name: 'frozen', applies: () => true });
    expect(defined.states).toEqual(['DRAFT', 'SUBMITTED', 'APPROVED']);
    expect(defined.rows).toEqual([row({})]);
    expect(defined.guards).toEqual([blackout]);
  });

  it('omits guards when the definition has none', () => {
    const { guards: _guards, ...unguarded } = DEFINITION;
    expect('guards' in defineTransitions(unguarded)).toBe(false);
  });

  it('accepts an empty guard list and no terminal states', () => {
    const defined = defineTransitions({ ...LOOSE, terminal: [], guards: [] });
    expect(defined.terminal).toEqual([]);
    expect(defined.guards).toEqual([]);
  });

  it('accepts one action from different states in different rows', () => {
    const rows = [
      row({ from: ['DRAFT'], action: 'edit', to: SAME_NEW_VERSION }),
      row({ from: ['SUBMITTED'], action: 'edit', to: SAME_NEW_VERSION }),
    ];
    expect(defineTransitions({ ...LOOSE, rows }).rows).toEqual(rows);
  });

  it.each<{ case: string; def: LooseDefinition; message: string }>([
    { case: 'an empty service', def: { ...LOOSE, service: '' }, message: 'service must not be empty' },
    { case: 'no states', def: { ...LOOSE, states: [] }, message: 'states must not be empty' },
    {
      case: 'a duplicate state',
      def: { ...LOOSE, states: ['DRAFT', 'SUBMITTED', 'DRAFT', 'APPROVED'] },
      message: "states contains duplicate 'DRAFT'",
    },
    { case: 'no actions', def: { ...LOOSE, actions: [] }, message: 'actions must not be empty' },
    {
      case: 'a duplicate action',
      def: { ...LOOSE, actions: ['submit', 'approve', 'edit', 'approve'] },
      message: "actions contains duplicate 'approve'",
    },
    { case: 'no roles', def: { ...LOOSE, roles: [] }, message: 'roles must not be empty' },
    {
      case: 'a duplicate role',
      def: { ...LOOSE, roles: ['author', 'author', 'approver'] },
      message: "roles contains duplicate 'author'",
    },
    {
      case: 'the same-new-version marker as a state',
      def: { ...LOOSE, states: [...LOOSE.states, SAME_NEW_VERSION] },
      message: "states must not contain 'same-new-version'",
    },
    {
      case: 'a terminal state missing from states',
      def: { ...LOOSE, terminal: ['ARCHIVED'] },
      message: "terminal state 'ARCHIVED' is not in states",
    },
    {
      case: 'a row action missing from actions',
      def: { ...LOOSE, rows: [row({ action: 'publish' })] },
      message: "rows[0] 'publish': action is not in actions",
    },
    {
      case: 'a row without from states',
      def: { ...LOOSE, rows: [row({ from: [] })] },
      message: "rows[0] 'submit': from must not be empty",
    },
    {
      case: 'a row without roles',
      def: { ...LOOSE, rows: [row({ roles: [] })] },
      message: "rows[0] 'submit': roles must not be empty",
    },
    {
      case: 'a row target missing from states',
      def: { ...LOOSE, rows: [row({ to: 'ARCHIVED' })] },
      message: "rows[0] 'submit': to 'ARCHIVED' is not in states",
    },
    {
      case: 'a row role missing from roles',
      def: { ...LOOSE, rows: [row({ roles: ['author', 'reviewer'] })] },
      message: "rows[0] 'submit': role 'reviewer' is not in roles",
    },
    {
      case: 'a row from state missing from states',
      def: { ...LOOSE, rows: [row({ from: ['ARCHIVED'] })] },
      message: "rows[0] 'submit': from state 'ARCHIVED' is not in states",
    },
    {
      case: 'a row leaving a terminal state',
      def: { ...LOOSE, rows: [row({ from: ['APPROVED'], action: 'edit', to: SAME_NEW_VERSION })] },
      message: "rows[0] 'edit': from contains terminal state 'APPROVED'",
    },
    {
      case: 'a (state, action) pair defined by two rows',
      def: { ...LOOSE, rows: [...LOOSE.rows, row({ roles: ['approver'] })] },
      message: "rows[3] 'submit': (DRAFT, submit) is already defined by another row",
    },
    {
      case: 'a from state repeated within one row',
      def: { ...LOOSE, rows: [row({ from: ['DRAFT', 'DRAFT'] })] },
      message: "rows[0] 'submit': (DRAFT, submit) is already defined by another row",
    },
    {
      case: 'an empty guard name',
      def: { ...LOOSE, guards: [{ ...blackout, name: '' }] },
      message: 'guard name must not be empty',
    },
    {
      case: 'the reserved guard name illegalTransition',
      def: { ...LOOSE, guards: [{ ...blackout, name: 'illegalTransition' }] },
      message: "guard name 'illegalTransition' is reserved",
    },
    {
      case: 'the reserved guard name authorization',
      def: { ...LOOSE, guards: [{ ...blackout, name: 'authorization' }] },
      message: "guard name 'authorization' is reserved",
    },
    {
      case: 'a duplicate guard name',
      def: { ...LOOSE, guards: [blackout, { name: 'blackout', applies: () => false }] },
      message: "guard name 'blackout' is duplicated",
    },
  ])('rejects $case', ({ def, message }) => {
    expect(() => defineTransitions(def)).toThrow(TransitionDefinitionError);
    expect(() => defineTransitions(def)).toThrow(new TransitionDefinitionError(message));
  });

  it('throws an Error named TransitionDefinitionError', () => {
    expect(() => defineTransitions({ ...LOOSE, service: '' })).toThrow(Error);
    expect(() => defineTransitions({ ...LOOSE, service: '' })).toThrow(
      expect.objectContaining({ name: 'TransitionDefinitionError' }),
    );
  });

  it('rejects misspelt terminal states, actions, roles and targets at compile time', () => {
    const submit = DEFINITION.rows[0];
    // @ts-expect-error misspelt terminal state
    expect(() => defineTransitions({ ...DEFINITION, terminal: ['APPROVD'] })).toThrow(TransitionDefinitionError);
    // @ts-expect-error misspelt action
    expect(() => defineTransitions({ ...DEFINITION, rows: [{ ...submit, action: 'sumbit' }] })).toThrow(
      TransitionDefinitionError,
    );
    // @ts-expect-error misspelt role
    expect(() => defineTransitions({ ...DEFINITION, rows: [{ ...submit, roles: ['autor'] }] })).toThrow(
      TransitionDefinitionError,
    );
    // @ts-expect-error misspelt from state
    expect(() => defineTransitions({ ...DEFINITION, rows: [{ ...submit, from: ['DRAF'] }] })).toThrow(
      TransitionDefinitionError,
    );
    // @ts-expect-error misspelt target state
    expect(() => defineTransitions({ ...DEFINITION, rows: [{ ...submit, to: 'SUBMITED' }] })).toThrow(
      TransitionDefinitionError,
    );
  });
});

describe('lifecycleRoles', () => {
  it('returns the declared roles in order', () => {
    expect(lifecycleRoles(defineTransitions(DEFINITION))).toEqual(['author', 'approver']);
  });
});

const ILLEGAL = { code: 'illegalTransition', message: 'illegalTransition' };
const FORBIDDEN = { code: 'authorization', message: 'Insufficient Account Permissions' };
const BLACKOUT = { code: 'blackout', message: 'blackout' };
const SEED = 20260630;

type Key = readonly [guard: string | null, from: string, action: string, role: string];

function request(state: string, action: string, roles: readonly string[], activeGuard: string | null = null): EvaluateInput {
  return { state, action, roles, activeGuard };
}

/** The rejection `evaluate` returns for `input`; throws when the transition is legal. */
function rejectionFor(input: EvaluateInput) {
  const decision = evaluate(LOOSE, input);
  if (decision.outcome === 'ok') throw new Error(`expected ${input.action} from ${input.state} to be rejected`);
  return decision;
}

function keyOf(row: TransitionTableRow): Key {
  return [row.guard, row.from, row.action, row.role];
}

const TABLE = generateTable(LOOSE);

const UNGUARDED: LooseDefinition = { ...LOOSE, guards: undefined };

function tableRow(...[guard, from, action, role]: Key): TransitionTableRow | undefined {
  return TABLE.find((r) => r.guard === guard && r.from === from && r.action === action && r.role === role);
}

describe('transitionError', () => {
  it('uses illegalTransition and authorization as the runner error codes', () => {
    expect(TRANSITION_ERROR_CODES).toEqual({ illegal: 'illegalTransition', forbidden: 'authorization' });
  });

  it.each([
    { code: 'illegalTransition', body: ILLEGAL },
    { code: 'authorization', body: FORBIDDEN },
    { code: 'blackout', body: BLACKOUT },
  ])('keeps the label $code and returns the fixture message', ({ code, body }) => {
    expect(transitionError(code)).toStrictEqual(body);
  });
});

describe('evaluate', () => {
  it.each<{ case: string; input: EvaluateInput; decision: TransitionDecision<string, string> }>([
    {
      case: 'moves DRAFT to SUBMITTED on submit by the author',
      input: request('DRAFT', 'submit', ['author']),
      decision: { outcome: 'ok', to: 'SUBMITTED', newVersion: false, actingRole: 'author' },
    },
    {
      case: 'moves SUBMITTED to APPROVED on approve by the approver',
      input: request('SUBMITTED', 'approve', ['approver']),
      decision: { outcome: 'ok', to: 'APPROVED', newVersion: false, actingRole: 'approver' },
    },
    {
      case: 'keeps DRAFT with a new version on edit by the author',
      input: request('DRAFT', 'edit', ['author']),
      decision: { outcome: 'ok', to: 'DRAFT', newVersion: true, actingRole: 'author' },
    },
    {
      case: 'answers 409 illegalTransition for submit from SUBMITTED',
      input: request('SUBMITTED', 'submit', ['author']),
      decision: { outcome: 'illegal', status: 409, error: ILLEGAL },
    },
    {
      case: 'answers 409 illegalTransition for an action without a row from the state',
      input: request('DRAFT', 'approve', ['approver']),
      decision: { outcome: 'illegal', status: 409, error: ILLEGAL },
    },
    {
      case: 'answers 409 illegalTransition for edit from SUBMITTED',
      input: request('SUBMITTED', 'edit', ['author', 'approver']),
      decision: { outcome: 'illegal', status: 409, error: ILLEGAL },
    },
    {
      case: 'answers 409 illegalTransition for a state outside the definition',
      input: request('ARCHIVED', 'submit', ['author']),
      decision: { outcome: 'illegal', status: 409, error: ILLEGAL },
    },
    {
      case: 'answers 409 illegalTransition for an action outside the definition',
      input: request('DRAFT', 'publish', ['author']),
      decision: { outcome: 'illegal', status: 409, error: ILLEGAL },
    },
    {
      case: 'answers 403 authorization for a role the row excludes',
      input: request('DRAFT', 'submit', ['approver']),
      decision: { outcome: 'forbidden', status: 403, error: FORBIDDEN },
    },
    {
      case: 'answers 403 authorization for a caller without roles',
      input: request('SUBMITTED', 'approve', []),
      decision: { outcome: 'forbidden', status: 403, error: FORBIDDEN },
    },
    {
      case: 'answers 409 with the guard name for a legal transition under an active guard',
      input: request('DRAFT', 'submit', ['author'], 'blackout'),
      decision: { outcome: 'illegal', status: 409, error: BLACKOUT },
    },
    {
      case: 'answers 409 with the guard name ahead of the terminal check',
      input: request('APPROVED', 'edit', ['author'], 'blackout'),
      decision: { outcome: 'illegal', status: 409, error: BLACKOUT },
    },
    {
      case: 'answers 409 with the guard name ahead of the role check',
      input: request('DRAFT', 'submit', ['approver'], 'blackout'),
      decision: { outcome: 'illegal', status: 409, error: BLACKOUT },
    },
  ])('$case', ({ input, decision }) => {
    expect(evaluate(LOOSE, input)).toStrictEqual(decision);
  });

  it.each(LOOSE.actions.flatMap((action) => LOOSE.roles.map((role) => ({ action, role }))))(
    'answers 409 illegalTransition for $action by $role from the terminal state',
    ({ action, role }) => {
      expect(evaluate(LOOSE, request('APPROVED', action, [role]))).toStrictEqual({
        outcome: 'illegal',
        status: 409,
        error: ILLEGAL,
      });
    },
  );

  const SHARED_EDIT: LooseDefinition = {
    ...LOOSE,
    rows: [row({ from: ['DRAFT', 'SUBMITTED'], action: 'edit', roles: ['author', 'approver'], to: SAME_NEW_VERSION })],
  };

  it.each<{ state: string; roles: readonly string[]; actingRole: string }>([
    { state: 'DRAFT', roles: ['approver', 'author'], actingRole: 'author' },
    { state: 'SUBMITTED', roles: ['admin', 'approver'], actingRole: 'approver' },
  ])('acts as the first definition role among $roles that the row allows', ({ state, roles, actingRole }) => {
    expect(evaluate(SHARED_EDIT, request(state, 'edit', roles))).toStrictEqual({
      outcome: 'ok',
      to: state,
      newVersion: true,
      actingRole,
    });
  });
});

describe('decide', () => {
  it('evaluates no guard when the request carries no guard context', () => {
    const applies = vi.fn(() => true);
    const def: LooseDefinition = { ...LOOSE, guards: [{ name: 'frozen', applies }] };
    expect(decide(def, { state: 'DRAFT', action: 'submit', roles: ['author'] })).toMatchObject({ outcome: 'ok' });
    expect(applies).not.toHaveBeenCalled();
  });

  it.each([
    { blackout: true, decision: { outcome: 'illegal', status: 409, error: BLACKOUT } },
    { blackout: false, decision: { outcome: 'ok', to: 'SUBMITTED', newVersion: false, actingRole: 'author' } },
  ])('decides submit from DRAFT with blackout $blackout', ({ blackout: active, decision }) => {
    const input = { state: 'DRAFT', action: 'submit', roles: ['author'], guards: { blackout: active } };
    expect(decide(DEFINITION, input)).toStrictEqual(decision);
  });

  it('answers with the first applying guard in definition order and passes it the context', () => {
    const quiet = vi.fn(() => false);
    const frozen = vi.fn(() => true);
    const later = vi.fn(() => true);
    const def: LooseDefinition = {
      ...LOOSE,
      guards: [
        { name: 'quiet', applies: quiet },
        { name: 'frozen', applies: frozen },
        { name: 'later', applies: later },
      ],
    };
    const ctx = { blackout: false };
    expect(decide(def, { state: 'DRAFT', action: 'submit', roles: ['author'], guards: ctx })).toMatchObject({
      outcome: 'illegal',
      error: { code: 'frozen' },
    });
    expect(quiet).toHaveBeenCalledWith(ctx);
    expect(frozen).toHaveBeenCalledWith(ctx);
    expect(later).not.toHaveBeenCalled();
  });

  it('applies no guard for a definition without guards', () => {
    const input = { state: 'DRAFT', action: 'submit', roles: ['author'], guards: { blackout: true } };
    expect(decide(UNGUARDED, input)).toMatchObject({ outcome: 'ok', to: 'SUBMITTED' });
  });
});

describe('transitionErrorEnvelope', () => {
  it('wraps the rejection error in the legacy envelope with the method and params', () => {
    const envelope = transitionErrorEnvelope(rejectionFor(request('APPROVED', 'edit', ['author'])), {
      method: 'edit',
      params: { id: 'r-1' },
    });
    expect(envelope).toStrictEqual({
      apiversion: 'v1',
      method: 'edit',
      params: { id: 'r-1' },
      error: { code: 'invalid_request', message: 'illegalTransition' },
    });
  });

  it('omits params when the context has none', () => {
    const envelope = transitionErrorEnvelope(rejectionFor(request('DRAFT', 'submit', ['approver'])), { method: 'submit' });
    expect(envelope).toStrictEqual({
      apiversion: 'v1',
      method: 'submit',
      error: { code: 'invalid_request', message: 'Insufficient Account Permissions' },
    });
  });

  // Expected values are the fixture oracle's (legacy-fixtures/cfml/lib/envelope.cfc errorMap forbidden and conflict).
  it.each([
    {
      case: 'an illegal state',
      input: request('SUBMITTED', 'submit', ['author']),
      status: 409,
      error: { code: 'invalid_request', message: 'illegalTransition' },
    },
    {
      case: 'a wrong role',
      input: request('SUBMITTED', 'approve', ['author']),
      status: 403,
      error: { code: 'invalid_request', message: 'Insufficient Account Permissions' },
    },
    {
      case: 'a blackout',
      input: request('DRAFT', 'submit', ['author'], 'blackout'),
      status: 409,
      error: { code: 'invalid_request', message: 'blackout' },
    },
  ])('answers $case with the fixture status, code and message, code first', ({ input, status, error }) => {
    const rejection = rejectionFor(input);
    const envelope = transitionErrorEnvelope(rejection, { method: input.action });
    expect(rejection.status).toBe(status);
    expect(envelope.error).toStrictEqual(error);
    expect(Object.keys(envelope.error ?? {})).toEqual(['code', 'message']);
  });
});

describe('TransitionRejectedError', () => {
  it.each([
    { case: 'an illegal transition', input: request('APPROVED', 'edit', ['author']), statusCode: 409, body: ILLEGAL },
    { case: 'a forbidden transition', input: request('DRAFT', 'submit', ['approver']), statusCode: 403, body: FORBIDDEN },
    { case: 'an active guard', input: request('DRAFT', 'submit', ['author'], 'blackout'), statusCode: 409, body: BLACKOUT },
  ])('carries the status, code, message and decision of $case', ({ input, statusCode, body }) => {
    const decision = rejectionFor(input);
    const error = new TransitionRejectedError(decision);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'TransitionRejectedError', statusCode, code: body.code, message: body.message });
    expect(error.decision).toBe(decision);
  });

  it('renders the same envelope as transitionErrorEnvelope', () => {
    const decision = rejectionFor(request('DRAFT', 'submit', ['author'], 'blackout'));
    const ctx = { method: 'submit', params: { id: 'r-1' } };
    expect(new TransitionRejectedError(decision).toEnvelope(ctx)).toStrictEqual(transitionErrorEnvelope(decision, ctx));
  });
});

describe('applyTransition', () => {
  it.each([
    {
      case: 'a state change',
      input: { state: 'DRAFT', action: 'submit', roles: ['author'] },
      applied: { from: 'DRAFT', action: 'submit', to: 'SUBMITTED', newVersion: false, actingRole: 'author' },
    },
    {
      case: 'an edit',
      input: { state: 'DRAFT', action: 'edit', roles: ['author'] },
      applied: { from: 'DRAFT', action: 'edit', to: 'DRAFT', newVersion: true, actingRole: 'author' },
    },
  ])('persists $case once and returns what persist returns', async ({ input, applied }) => {
    const persist = vi.fn((transition: { to: string }) => Promise.resolve({ saved: transition.to }));
    await expect(applyTransition(LOOSE, { ...input, guards: { blackout: false } }, persist)).resolves.toEqual({
      saved: applied.to,
    });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith(applied);
  });

  it.each([
    {
      case: 'an illegal state',
      input: { state: 'APPROVED', action: 'edit', roles: ['author'], guards: { blackout: false } },
      statusCode: 409,
      code: 'illegalTransition',
    },
    {
      case: 'a wrong role',
      input: { state: 'DRAFT', action: 'submit', roles: ['approver'], guards: { blackout: false } },
      statusCode: 403,
      code: 'authorization',
    },
    {
      case: 'an active guard',
      input: { state: 'DRAFT', action: 'submit', roles: ['author'], guards: { blackout: true } },
      statusCode: 409,
      code: 'blackout',
    },
  ])('throws TransitionRejectedError for $case without calling persist', async ({ input, statusCode, code }) => {
    const persist = vi.fn(() => Promise.resolve('saved'));
    const pending = applyTransition(LOOSE, input, persist);
    await expect(pending).rejects.toThrow(TransitionRejectedError);
    await expect(pending).rejects.toMatchObject({ statusCode, code });
    expect(persist).not.toHaveBeenCalled();
  });

  it('rejects with the error persist throws', async () => {
    const failure = new Error('write failed');
    await expect(
      applyTransition(LOOSE, { state: 'DRAFT', action: 'submit', roles: ['author'] }, () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});

describe('generateTable', () => {
  it('emits one row per guard or none, state, action and role', () => {
    const { states, actions, roles, guards = [] } = LOOSE;
    expect(TABLE).toHaveLength((guards.length + 1) * states.length * actions.length * roles.length);
    expect(TABLE).toHaveLength(36);
    expect(new Set(TABLE.map((row) => JSON.stringify(keyOf(row)))).size).toBe(TABLE.length);
  });

  it('emits unguarded rows first, then guarded ones, each in definition order of state, action and role', () => {
    expect(TABLE.slice(0, 3).map(keyOf)).toEqual([
      [null, 'DRAFT', 'submit', 'author'],
      [null, 'DRAFT', 'submit', 'approver'],
      [null, 'DRAFT', 'approve', 'author'],
    ]);
    expect(keyOf(TABLE[18] as TransitionTableRow)).toEqual(['blackout', 'DRAFT', 'submit', 'author']);
    expect(keyOf(TABLE.at(-1) as TransitionTableRow)).toEqual(['blackout', 'APPROVED', 'edit', 'approver']);
  });

  it('emits only unguarded rows for a definition without guards', () => {
    const rows = generateTable(UNGUARDED);
    expect(rows).toHaveLength(18);
    expect(rows.filter((row) => row.guard !== null)).toEqual([]);
  });

  type Outcome = Pick<TransitionTableRow, 'expectedStatus' | 'to' | 'newVersion' | 'errorCode'>;

  it.each<{ case: string; key: Key; outcome: Outcome }>([
    {
      case: '200 and the new state for a legal transition',
      key: [null, 'DRAFT', 'submit', 'author'],
      outcome: { expectedStatus: 200, to: 'SUBMITTED', newVersion: false, errorCode: null },
    },
    {
      case: '200, the same state and a new version for an edit',
      key: [null, 'DRAFT', 'edit', 'author'],
      outcome: { expectedStatus: 200, to: 'DRAFT', newVersion: true, errorCode: null },
    },
    {
      case: '409 illegalTransition for submit from SUBMITTED',
      key: [null, 'SUBMITTED', 'submit', 'author'],
      outcome: { expectedStatus: 409, to: null, newVersion: false, errorCode: 'illegalTransition' },
    },
    {
      case: '409 illegalTransition for an action without a row from the state',
      key: [null, 'DRAFT', 'approve', 'approver'],
      outcome: { expectedStatus: 409, to: null, newVersion: false, errorCode: 'illegalTransition' },
    },
    {
      case: '409 illegalTransition from the terminal state',
      key: [null, 'APPROVED', 'edit', 'author'],
      outcome: { expectedStatus: 409, to: null, newVersion: false, errorCode: 'illegalTransition' },
    },
    {
      case: '403 authorization for submit by the approver',
      key: [null, 'DRAFT', 'submit', 'approver'],
      outcome: { expectedStatus: 403, to: null, newVersion: false, errorCode: 'authorization' },
    },
    {
      case: '403 authorization for approve by the author',
      key: [null, 'SUBMITTED', 'approve', 'author'],
      outcome: { expectedStatus: 403, to: null, newVersion: false, errorCode: 'authorization' },
    },
    {
      case: '409 with the guard name ahead of the role check',
      key: ['blackout', 'DRAFT', 'submit', 'approver'],
      outcome: { expectedStatus: 409, to: null, newVersion: false, errorCode: 'blackout' },
    },
    {
      case: '409 with the guard name ahead of the terminal check',
      key: ['blackout', 'APPROVED', 'edit', 'author'],
      outcome: { expectedStatus: 409, to: null, newVersion: false, errorCode: 'blackout' },
    },
  ])('expects $case', ({ key, outcome }) => {
    const [guard, from, action, role] = key;
    expect(tableRow(...key)).toStrictEqual({ service: 'approvals', from, action, role, guard, ...outcome });
  });

  it('expects 409 with the guard name on every guarded row', () => {
    const guarded = TABLE.filter((row) => row.guard !== null);
    expect(guarded).toHaveLength(18);
    expect(guarded.filter((row) => row.expectedStatus !== 409 || row.errorCode !== 'blackout' || row.to !== null)).toEqual([]);
  });

  it('equals the decide and evaluate outcome for every guard, state, action and role, never 200 from a terminal state', () => {
    const expectedRow = (key: Key, decision: TransitionDecision<string, string>): TransitionTableRow => {
      const [guard, from, action, role] = key;
      const base = { service: LOOSE.service, from, action, role, guard };
      return decision.outcome === 'ok'
        ? { ...base, expectedStatus: 200, to: decision.to, newVersion: decision.newVersion, errorCode: null }
        : { ...base, expectedStatus: decision.status, to: null, newVersion: false, errorCode: decision.error.code };
    };
    fc.assert(
      fc.property(
        fc.constantFrom(null, ...(LOOSE.guards ?? []).map((guard) => guard.name)),
        fc.constantFrom(...LOOSE.states),
        fc.constantFrom(...LOOSE.actions),
        fc.constantFrom(...LOOSE.roles),
        (guard, from, action, role) => {
          const key: Key = [guard, from, action, role];
          const generated = tableRow(...key);
          const decided = decide(LOOSE, { state: from, action, roles: [role], guards: { blackout: guard === 'blackout' } });
          const evaluated = evaluate(LOOSE, request(from, action, [role], guard));
          expect(generated).toStrictEqual(expectedRow(key, decided));
          expect(generated).toStrictEqual(expectedRow(key, evaluated));
          expect(generated?.expectedStatus === 200 && LOOSE.terminal.includes(from)).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});

describe('serializeTable', () => {
  it('sorts rows by service, guard with null first, from, action and role', () => {
    const parsed = JSON.parse(serializeTable(TABLE)) as TransitionTableRow[];
    expect(parsed).toEqual([...TABLE].sort(compareTableRows));
    expect(parsed.slice(0, 2).map(keyOf)).toEqual([
      [null, 'APPROVED', 'approve', 'approver'],
      [null, 'APPROVED', 'approve', 'author'],
    ]);
    expect(keyOf(parsed.at(-1) as TransitionTableRow)).toEqual(['blackout', 'SUBMITTED', 'submit', 'author']);
  });

  it('serializes the same rows identically on every call and in any input order', () => {
    expect(serializeTable(TABLE)).toBe(serializeTable(TABLE));
    fc.assert(
      fc.property(fc.shuffledSubarray(TABLE, { minLength: TABLE.length }), (shuffled) => {
        expect(serializeTable(shuffled)).toBe(serializeTable(TABLE));
      }),
      { seed: SEED, numRuns: 50 },
    );
  });

  it('indents by two spaces and ends with a newline', () => {
    const text = serializeTable(TABLE);
    expect(text.startsWith('[\n  {\n    "service": "approvals",\n')).toBe(true);
    expect(text.endsWith('  }\n]\n')).toBe(true);
    expect(serializeTable([])).toBe('[]\n');
  });

  it('leaves the input rows in their order', () => {
    const rows = [...TABLE].reverse();
    const before = [...rows];
    serializeTable(rows);
    expect(rows).toStrictEqual(before);
  });
});

describe('compareTableRows', () => {
  const ROW: TransitionTableRow = {
    service: 'approvals',
    from: 'DRAFT',
    action: 'submit',
    role: 'author',
    guard: null,
    expectedStatus: 200,
    to: 'SUBMITTED',
    newVersion: false,
    errorCode: null,
  };

  it.each<{ case: string; first: Partial<TransitionTableRow>; second: Partial<TransitionTableRow> }>([
    { case: 'service', first: { service: 'approvals' }, second: { service: 'billing' } },
    { case: 'a null guard before a named one', first: { guard: null }, second: { guard: 'blackout' } },
    { case: 'guard name', first: { guard: 'blackout' }, second: { guard: 'freeze' } },
    { case: 'from', first: { from: 'DRAFT' }, second: { from: 'SUBMITTED' } },
    { case: 'action', first: { action: 'approve' }, second: { action: 'submit' } },
    { case: 'role', first: { role: 'approver' }, second: { role: 'author' } },
    { case: 'code unit, upper case first', first: { role: 'Zed' }, second: { role: 'author' } },
    {
      case: 'service ahead of every later key',
      first: { service: 'approvals', guard: 'blackout', from: 'SUBMITTED', action: 'submit', role: 'author' },
      second: { service: 'billing', guard: null, from: 'APPROVED', action: 'approve', role: 'approver' },
    },
  ])('orders by $case', ({ first, second }) => {
    expect(compareTableRows({ ...ROW, ...first }, { ...ROW, ...second })).toBe(-1);
    expect(compareTableRows({ ...ROW, ...second }, { ...ROW, ...first })).toBe(1);
  });

  it.each([null, 'blackout'])('treats rows with equal keys and guard %s as equal whatever their outcome', (guard) => {
    const rejected: TransitionTableRow = { ...ROW, guard, expectedStatus: 409, to: null, errorCode: 'blackout' };
    expect(compareTableRows({ ...ROW, guard }, rejected)).toBe(0);
  });
});

describe('writeTableJson', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes the serialized table, creating missing parent directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'opt2-transition-table-'));
    dirs.push(dir);
    const path = join(dir, 'test', 'generated', 'transition-table.json');
    await writeTableJson(TABLE, path);
    expect(await readFile(path, 'utf8')).toBe(serializeTable(TABLE));
  });
});
