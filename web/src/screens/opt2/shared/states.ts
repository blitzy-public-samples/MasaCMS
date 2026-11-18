// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { html, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import type { GridCell, Label } from './markup';

/** Legacy admin label tone of a state badge. */
export type StateTone = 'success' | 'info' | 'inverse' | 'important';

/** A contract state's label in the session locale of `ctx` and the tone of its badge. */
export interface StateDisplay {
  readonly label: (ctx: { readonly rb: RbLookup }) => Label;
  readonly tone: StateTone;
}

const BADGE_CLASS: Readonly<Record<StateTone, SafeHtml>> = Object.freeze({
  success: html` class="label label-success"`,
  info: html` class="label label-info"`,
  inverse: html` class="label label-inverse"`,
  important: html` class="label label-important"`,
});

// BLITZY [A11Y]: legacy admin.css gives label-important ~3.6:1 and text-danger ~3.5:1 contrast; kept, legacy CSS only.
/** `label` as a legacy admin label of `tone`. */
export function stateBadge(label: Label, tone: StateTone): SafeHtml {
  return html`<span${BADGE_CLASS[tone]}>${label}</span>`;
}

/** The badge of `state` as `displays` labels and tones it, in the session locale of `ctx`. */
export function stateBadgeOf<S extends string>(
  ctx: { readonly rb: RbLookup },
  displays: Readonly<Record<S, StateDisplay>>,
  state: S,
): SafeHtml {
  const { label, tone } = displays[state];
  return stateBadge(label(ctx), tone);
}

/** A fixed-decimal amount; a negative one is marked `text-danger`, zero and positive ones stay plain. */
export function amountCell(amount: string): GridCell {
  return amount.startsWith('-') ? html`<span class="text-danger">${amount}</span>` : amount;
}
