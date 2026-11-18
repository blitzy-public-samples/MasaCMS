// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { describe, expect, it } from 'vitest';
import { isSafeHtml, raw } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { opt2Label } from '@/screens/opt2/shared/labels';
import type { GridCell } from '@/screens/opt2/shared/markup';
import { amountCell, stateBadge, stateBadgeOf, type StateDisplay } from '@/screens/opt2/shared/states';

const DISPLAYS: Readonly<Record<'open' | 'shut', StateDisplay>> = {
  open: { label: (ctx) => opt2Label(ctx, 'Approved'), tone: 'success' },
  shut: { label: () => 'Shut', tone: 'inverse' },
};

describe('opt2 state badges and amounts', () => {
  it.each<[string, () => GridCell, boolean, string]>([
    ['a success badge', () => stateBadge('Done', 'success'), true, '<span class="label label-success">Done</span>'],
    ['an info badge', () => stateBadge('Queued', 'info'), true, '<span class="label label-info">Queued</span>'],
    ['an inverse badge', () => stateBadge('Draft', 'inverse'), true, '<span class="label label-inverse">Draft</span>'],
    [
      'an important badge of a bundle label, kept unencoded',
      () => stateBadge(raw('Rejet&eacute;'), 'important'),
      true,
      '<span class="label label-important">Rejet&eacute;</span>',
    ],
    [
      'a badge of a string label, encoded',
      () => stateBadge('<b>', 'info'),
      true,
      '<span class="label label-info">&lt;b&gt;</span>',
    ],
    [
      'the badge of a catalogued state in the fr bundle',
      () => stateBadgeOf({ rb: rbFor('fr') }, DISPLAYS, 'open'),
      true,
      '<span class="label label-success">Validé</span>',
    ],
    [
      'the badge of a literal state',
      () => stateBadgeOf({ rb: rbFor('fr') }, DISPLAYS, 'shut'),
      true,
      '<span class="label label-inverse">Shut</span>',
    ],
    ['a negative amount', () => amountCell('-1234.5600'), true, '<span class="text-danger">-1234.5600</span>'],
    ['a zero amount', () => amountCell('0.0000'), false, '0.0000'],
    ['a positive amount', () => amountCell('999999000000000.0000'), false, '999999000000000.0000'],
  ])('renders %s', (_, render, markup, expected) => {
    const cell = render();
    expect([isSafeHtml(cell), String(cell)]).toEqual([markup, expected]);
  });
});
