// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
// The shared submit: the refusal it hands the re-render, and the posted fields an invalidParameters refusal concerns.
import { Roles } from '@opt2/platform/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html, toString, type SafeHtml } from '@/lib/html';
import { focusesFirst, isInvalidParameters, refusedFields, submitToService, type Opt2Refusal } from '@/screens/opt2/shared';
import { opt2RoleRequest } from '../../../helpers/admin-request';
import { useTestEnv } from '../../../helpers/env';
import { makeScreenContext } from '../../../helpers/screen-context';

// The registry module loads every circuit; the re-rendered view needs only the shell hooks.
vi.mock('@/screens/registry', () => ({ shellHooks: Object.freeze({ secondaryMenus: Object.freeze({}) }) }));

const RULES = Object.freeze({
  a: (value: string) => (value === 'bad' ? 'A is bad.' : undefined),
  b: (value: string) => (value === '' ? 'B is required.' : undefined),
});

const INVALID: Opt2Refusal = { status: 400, message: 'Invalid parameters' };

let restoreEnv: () => void;
beforeEach(() => {
  restoreEnv = useTestEnv();
});
afterEach(() => restoreEnv());

describe('refusedFields', () => {
  it('marks every field its rule refuses, the first in rule order focused', () => {
    const errors = refusedFields(RULES, { b: '', a: 'bad' }, INVALID);
    expect(errors).toEqual({
      a: { message: 'A is bad.', focus: true },
      b: { message: 'B is required.', focus: false },
    });
    expect(focusesFirst(INVALID, errors)).toBe(false);
  });

  it('reads an unposted field as empty and leaves accepted ones unmarked', () => {
    expect(refusedFields(RULES, { a: 'good' }, INVALID)).toEqual({ b: { message: 'B is required.', focus: true } });
  });

  it.each<[string, Opt2Refusal | undefined, boolean]>([
    ['no refusal', undefined, false],
    ['a CSRF refusal', { status: 400, message: 'Invalid CSRF tokens' }, true],
    ['a role refusal', { status: 403, message: 'Invalid parameters' }, true],
    ['a state refusal', { status: 409, message: 'illegalTransition' }, true],
  ])('marks nothing for %s, which says nothing of the values, the first control focused on a refusal', (_, refusal, focused) => {
    const errors = refusedFields(RULES, { a: 'bad', b: '' }, refusal);
    expect(isInvalidParameters(refusal)).toBe(false);
    expect(errors).toEqual({});
    expect(focusesFirst(refusal, errors)).toBe(focused);
  });

  it('focuses the first control on an invalidParameters refusal no rule explains', () => {
    const errors = refusedFields(RULES, { a: 'good', b: 'x' }, INVALID);
    expect(errors).toEqual({});
    expect(focusesFirst(INVALID, errors)).toBe(true);
  });
});

describe('submitToService', () => {
  it.each([
    [400, 'Invalid parameters'],
    [400, 'Invalid CSRF tokens'],
    [409, 'illegalTransition'],
  ])('hands the re-render the %i refusal %j with its alert', async (status, message) => {
    const ctx = makeScreenContext({ req: opt2RoleRequest(Roles.financePreparer) });
    const seen: Array<[string, Opt2Refusal]> = [];
    const rerender = (alert: SafeHtml, refusal: Opt2Refusal): SafeHtml => {
      seen.push([toString(alert), refusal]);
      return html`<p>re-rendered</p>`;
    };
    const write = {
      service: 'finance' as const,
      call: () => Promise.resolve({ ok: false, status, headers: {}, body: { error: { message } }, setCookies: [] }),
    };

    const result = await submitToService(ctx, write, { module: 'finance', screen: 'record' }, rerender);

    expect(seen).toEqual([[`<div class="alert alert-error"><span>${message}</span></div>`, { status, message }]]);
    expect(result).toMatchObject({ kind: 'render', view: { opt2Module: 'finance' } });
  });
});
