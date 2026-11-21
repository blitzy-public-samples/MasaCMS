// The admin secondary menu dispatcher of `layouts/includes/dsp_secondary_menu.cfm` (server-only).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { join, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { SecondaryMenuCircuit, ShellHooks } from './types';

/** Circuit whose `views/<circuit>/dsp_secondary_menu.cfm` the dispatcher includes. */
export type SecondaryMenuKey =
  | 'cdashboard'
  | 'carch'
  | 'cchangesets'
  | 'ccategory'
  | 'cfeed'
  | 'cpublicusers'
  | 'cemail'
  | 'cmailinglist';

/** Inputs of {@link selectSecondaryMenus}: `rc.originalcircuit`, `rc.moduleid` and `session.siteid`. */
export interface SecondaryMenuInput {
  readonly originalCircuit: string;
  readonly moduleId: string;
  readonly sessionSiteId: string;
}

/** Keys the screens can inject a renderer for; `satisfies` keeps it in step with {@link SecondaryMenuCircuit}. */
const HOOKED_CIRCUITS = {
  carch: true,
  cchangesets: true,
  ccategory: true,
  cfeed: true,
} as const satisfies Record<SecondaryMenuCircuit, true>;

function isSecondaryMenuCircuit(key: SecondaryMenuKey): key is SecondaryMenuCircuit {
  return Object.hasOwn(HOOKED_CIRCUITS, key);
}

/** Core module id: `suffix` left-padded with zeros to 35 characters. */
const coreModuleId = (suffix: string): string => suffix.padStart(35, '0');

/** CFML `listFirst(listLast(action, ':'), '.')`: the circuit of an FW/1 action. */
function circuitOf(action: string): string {
  return cfListToArray(cfListToArray(action, ':').at(-1) ?? '', '.')[0] ?? '';
}

/** The secondary menus legacy includes, in include order; a menu selected by several branches repeats. */
export function selectSecondaryMenus({ originalCircuit, moduleId, sessionSiteId }: SecondaryMenuInput): SecondaryMenuKey[] {
  if (sessionSiteId === '') return [];
  // Both sides use CFML `eq`, so a numeric `rc.moduleid` such as `3` matches `…003` as it does in legacy.
  const isCircuit = (name: string): boolean => cfEq(originalCircuit, name);
  const isModule = (suffix: string): boolean => cfEq(moduleId, coreModuleId(suffix));
  const isPerm = (suffix: string): boolean => isCircuit('cPerm') && isModule(suffix);
  const branches: ReadonlyArray<readonly [SecondaryMenuKey, boolean]> = [
    ['cdashboard', isCircuit('cDashboard')],
    ['carch', isModule('000') && !isCircuit('cDashboard')],
    ['cchangesets', isCircuit('cChangesets') || isPerm('014')],
    ['carch', isModule('003') || isPerm('003')],
    ['ccategory', isCircuit('cCategory') || isPerm('010')],
    ['cfeed', isCircuit('cFeed') || isPerm('011')],
    ['carch', isModule('004')],
    ['cpublicusers', isCircuit('cPublicUsers') || isPerm('008')],
    ['cemail', isCircuit('cEmail') || isPerm('005')],
    ['cmailinglist', isCircuit('cMailingList') || isPerm('009')],
  ];
  return branches.filter(([, selected]) => selected).map(([key]) => key);
}

/**
 * The selected menus rendered by the screens' injected renderers; keys without one render nothing.
 * Legacy layouts never include this dispatcher, so the shell layouts do not call it.
 */
export function renderSecondaryMenu(
  ctx: AdminRequest,
  hooks: ShellHooks,
  originalCircuit: string = circuitOf(ctx.action),
): SafeHtml {
  const keys = selectSecondaryMenus({ originalCircuit, moduleId: ctx.rc.moduleid ?? '', sessionSiteId: ctx.session.siteid });
  return join(
    keys.flatMap((key) => {
      const render = isSecondaryMenuCircuit(key) ? hooks.secondaryMenus[key] : undefined;
      return render === undefined ? [] : [render(ctx)];
    }),
  );
}
