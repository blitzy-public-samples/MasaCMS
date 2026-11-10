import { describe, expect, it } from 'vitest';
import {
  SAME_NEW_VERSION,
  TransitionDefinitionError,
  defineTransitions,
  lifecycleRoles,
  type TransitionDefinition,
  type TransitionGuard,
  type TransitionRow,
} from '../../src/state-machine/definition.js';

interface Ctx {
  readonly blackout: boolean;
}

type LooseDefinition = TransitionDefinition<string, string, string, Ctx>;

const blackout: TransitionGuard<Ctx> = { name: 'blackout', applies: (ctx) => ctx.blackout };

const DEFINITION = {
  service: 'approvals',
  states: ['DRAFT', 'SUBMITTED', 'APPROVED'],
  actions: ['submit', 'approve', 'edit'],
  roles: ['author', 'approver'],
  terminal: ['APPROVED'],
  rows: [
    { from: ['DRAFT'], action: 'submit', roles: ['author'], to: 'SUBMITTED' },
    { from: ['SUBMITTED'], action: 'approve', roles: ['approver'], to: 'APPROVED' },
    { from: ['DRAFT', 'SUBMITTED'], action: 'edit', roles: ['author', 'approver'], to: SAME_NEW_VERSION },
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
