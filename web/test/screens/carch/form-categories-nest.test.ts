import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  renderEditCategoriesNest,
  type EditCategoriesNestInput,
  type EditCategoriesNestOptions,
  type EditCategoryAssignment,
  type EditCategoryNode,
} from '@/screens/carch/form/categories-nest';

// Tag output of `cArch.edit` for Home on the default site, captured from the legacy ACF 2023 server with the categories
// and assignments of `tree()` below, cut from the tag's first byte to its last: as admin and as `qa_editor` (outside
// `Delta Restricted`'s restrict group `Admin`) with the site locale unset (en_US), and as admin with site locale de_DE.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}`, import.meta.url), 'utf8');
const LEGACY_ADMIN = fixture('edit-categories-nest-admin.html');
const LEGACY_EDITOR = fixture('edit-categories-nest-editor.html');
const LEGACY_ADMIN_DE = fixture('edit-categories-nest-admin-de.html');

const id = (n: string): string => `CA000000-0000-0000-00000000000000${n}`;
const trim = (n: string): string => id(n).replaceAll('-', '');
const NONE: EditCategoryAssignment = { recordcount: 0, isFeature: '', featureStart: null, featureStop: null };
const row = (isFeature: number, featureStart: string | null = null, featureStop: string | null = null) =>
  ({ recordcount: 1, isFeature, featureStart, featureStop }) satisfies EditCategoryAssignment;

function node(
  n: string,
  name: string,
  flags: Pick<EditCategoryNode, 'isOpen' | 'isFeatureable'>,
  assignment: EditCategoryAssignment,
  children: readonly EditCategoryNode[] = [],
  permitted = true,
): EditCategoryNode {
  return { categoryId: id(n), name, ...flags, hasKids: children.length, permitted, children, assignment };
}

const FEATUREABLE = { isOpen: 1, isFeatureable: 1 } as const;

/** The captured tree; `restricted` is Delta's verdict for the session user. */
function tree(restricted: boolean): EditCategoryNode[] {
  return [
    node('01', 'Alpha & <Co>', FEATUREABLE, NONE, [
      node('02', 'Alpha Child', FEATUREABLE, row(2, '2026-11-10T09:05:00', "{ts '2026-11-20 23:30:00'}")),
    ]),
    node('03', 'Beta Closed', { isOpen: 0, isFeatureable: 0 }, row(0)),
    node('04', 'Charlie Unfeatureable', { isOpen: 1, isFeatureable: 0 }, NONE),
    node('05', 'Delta Restricted', FEATUREABLE, row(1), [], !restricted),
    node('06', 'Echo Null Featureable', { isOpen: 0, isFeatureable: '' }, row(0), [
      node('07', 'Echo Child', FEATUREABLE, row(2, '2026-01-01 12:40:00', null)),
    ]),
    node('08', 'Foxtrot', FEATUREABLE, row(2, '2026-03-01 00:15:00', '2026-03-02 12:00:00')),
    node('09', 'Golf Unassigned', FEATUREABLE, NONE),
  ];
}

type Session = EditCategoriesNestInput['ctx']['req']['session'];
const EN_US: Session = { locale: 'en_US', dateKeyFormat: 'MM/DD/YYYY', localeHasDayParts: true };
const DE_DE: Session = { locale: 'de_DE', dateKeyFormat: 'DD.MM.YYYY', localeHasDayParts: false };

function render(nodes: readonly EditCategoryNode[], opts: Partial<EditCategoriesNestOptions> = {}, session = EN_US) {
  const input: EditCategoriesNestInput = {
    ctx: { rb: rbFor('en'), req: { session } },
    data: { rc: { contentBean: { siteid: 'default', contentid: '00000000000000000000000000000000001' } } },
  };
  const result = renderEditCategoriesNest(input, { nodes, parentId: '', nestLevel: 0, siteId: 'default', ...opts });
  expect(isSafeHtml(result.html)).toBe(true);
  return { markup: toString(result.html), openCategoryIds: result.openCategoryIds };
}

/** The `data-disabled` values in render order. */
const disabledFlags = (markup: string): string[] => [...markup.matchAll(/data-disabled="([^"]*)"/g)].map((m) => m[1] ?? '');

/** The value of the hidden input named `name`. */
function hiddenValue(markup: string, name: string): string | undefined {
  return new RegExp(`name="${name}" value="([^"]*)"`).exec(markup)?.[1];
}

describe('carch.edit category tree', () => {
  it.each([
    ['admin, permitted everywhere', false, EN_US, LEGACY_ADMIN],
    ['qa_editor, restricted from Delta', true, EN_US, LEGACY_EDITOR],
    ['admin in a locale without day parts', false, DE_DE, LEGACY_ADMIN_DE],
  ])('matches the legacy tag output byte for byte for %s', (_case, restricted, session, legacy) => {
    expect(render(tree(restricted), {}, session).markup).toBe(legacy);
  });

  it('keeps an unpermitted category disabled for every later sibling and its subtree, but not for earlier ones', () => {
    const { markup } = render(tree(true));
    expect(disabledFlags(markup)).toEqual(['false', 'false', 'false', 'false', 'true', 'true', 'true', 'true', 'true']);
    expect(markup).toContain(`<input name="categoryid" value="${id('09')}" type="hidden" />`);
    expect(markup).not.toContain(`<input name="categoryid" value="${id('04')}" type="hidden" />`);
  });

  it('passes a caller-disabled state into the whole tree', () => {
    const { markup } = render(tree(false), { disabled: true });
    expect(new Set(disabledFlags(markup))).toEqual(new Set(['true']));
    expect(markup).not.toContain('mura-quickEditItem');
  });

  it('does not let a disabled child disable its parent’s later siblings', () => {
    const nodes = [
      node('01', 'Parent', FEATUREABLE, NONE, [node('02', 'Locked Child', FEATUREABLE, NONE, [], false)]),
      node('03', 'Next', FEATUREABLE, NONE),
    ];
    expect(disabledFlags(render(nodes).markup)).toEqual(['false', 'true', 'false']);
  });

  it('lists the assigned categories in render order, descendants before later siblings', () => {
    expect(render(tree(false)).openCategoryIds).toEqual(['02', '03', '05', '06', '07', '08'].map(id));
  });

  it('renders nothing for a level without categories', () => {
    expect(render([])).toEqual({ markup: '', openCategoryIds: [] });
  });

  it('opens the top level with the mura-nodes id and hides nested levels', () => {
    const { markup } = render(tree(false));
    expect(markup.startsWith('\n\t<ul class="categorylist" id="mura-nodes">\n\t\t')).toBe(true);
    expect(markup.match(/<ul class="categorylist" style="display:none">/g)).toHaveLength(2);
    const nested = render([node('09', 'Golf', FEATUREABLE, NONE)], { parentId: id('08') }).markup;
    expect(nested.startsWith('\n\t<ul class="categorylist" style="display:none">\n\t\t')).toBe(true);
  });

  it.each<[string, Pick<EditCategoryNode, 'isOpen' | 'isFeatureable'>, boolean]>([
    ['open and featureable', { isOpen: 1, isFeatureable: 1 }, true],
    ['closed with a NULL featureable flag', { isOpen: 0, isFeatureable: '' }, true],
    ['open with a NULL featureable flag', { isOpen: 1, isFeatureable: '' }, true],
    ['closed and featureable', { isOpen: 0, isFeatureable: 1 }, false],
    ['open and not featureable', { isOpen: 1, isFeatureable: 0 }, false],
  ])('shows the feature controls for a category %s: %s', (_case, flags, shown) => {
    const { markup } = render([node('01', 'Cat', flags, NONE)]);
    expect(markup.includes('class="categoryLabelContainer"')).toBe(shown);
    expect(markup.includes(`\n\t\t\t\t\t\t\t<input type="hidden" id="categoryAssign${trim('01')}"`)).toBe(!shown);
  });

  it.each<[string, EditCategoryAssignment, string, string | undefined]>([
    ['not featured', row(0), '<i class="mi-ban" title="No"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t<span>No</span>', '0'],
    ['featured', row(1), '<i class="mi-check" title="Yes"></i>\n\t\t\t\t\t\t\t\t\t\t\t\t<span>Yes</span>', '1'],
    ['scheduled', row(2), '<i class="mi-calendar" title="&nbsp;-&nbsp;"></i>', '2'],
    ['unassigned', NONE, '<i class="mi-ban" title="No"></i><span>No</span>', '0'],
    ['assigned with an empty flag', { ...NONE, recordcount: 1 }, '<i class="mi-ban" title="No"></i><span>No</span>', '0'],
    ['assigned with another flag', row(3), '<i class="mi-ban" title="No"></i><span>No</span>', undefined],
    ['re-rendered from bean values', { ...row(1), recordcount: 2, isFeature: '1' }, '<i class="mi-check"', '1'],
  ])('writes the quick-edit icon and categoryAssign value of a category %s', (_case, assignment, icon, value) => {
    const { markup } = render([node('01', 'Cat', FEATUREABLE, assignment)]);
    expect(markup).toContain(icon);
    expect(hiddenValue(markup, `categoryAssign${trim('01')}`)).toBe(value);
  });

  it('marks only an assigned scheduled category as scheduled', () => {
    const unassigned = render([node('01', 'Cat', FEATUREABLE, { ...NONE, isFeature: 2 })]).markup;
    expect(unassigned).toContain('<div class="categoryassignment">');
    expect(unassigned).toContain('rel="tooltip" title="&nbsp;-&nbsp;"');
    expect(hiddenValue(unassigned, `categoryAssign${trim('01')}`)).toBe('0');
    expect(render([node('01', 'Cat', FEATUREABLE, row(2))]).markup).toContain('<div class="categoryassignment scheduled">');
  });

  it.each<[string, string, string, string]>([
    ['midnight', '2026-03-01 00:15:00', '0', 'AM'],
    ['noon', '2026-03-01 12:40:00', '0', 'PM'],
    ['late evening', '2026-03-01 23:30:00', '11', 'PM'],
  ])('writes the %s hour on a 12-hour clock with its day part', (_case, date, hour, dayPart) => {
    const { markup } = render([node('01', 'Cat', FEATUREABLE, row(2, date, date))]);
    for (const end of ['start', 'stop']) {
      expect(hiddenValue(markup, `${end}Hour${trim('01')}`)).toBe(hour);
      expect(hiddenValue(markup, `${end}DayPart${trim('01')}`)).toBe(dayPart);
    }
  });

  it('writes 24-hour values and empty day parts for a locale without day parts', () => {
    const nodes = [node('01', 'Cat', FEATUREABLE, row(2, '2026-03-01 00:15:00', '2026-03-02 23:30:00'))];
    const { markup } = render(nodes, {}, DE_DE);
    const t = trim('01');
    expect(markup).toContain('\t<i class="mi-calendar" title="01.03.26&nbsp;-&nbsp;02.03.26"></i>');
    expect(markup).toContain(
      [
        `<input type="hidden" id="featureStart${t}" name="featureStart${t}" value="60.03.2026">`,
        '\t'.repeat(10),
        `${'\t'.repeat(12)}<input type="hidden" id="startHour${t}" name="startHour${t}" value="0">`,
        `${'\t'.repeat(12)}<input type="hidden" id="startDayPart${t}" name="startDayPart${t}" value="">`,
        '\t'.repeat(11),
        `${'\t'.repeat(11)}<input type="hidden" id="startMinute${t}" name="startMinute${t}" value="15">`,
      ].join('\n'),
    );
    expect(markup).toContain(
      [
        `${'\t'.repeat(12)}<input type="hidden" id="stopHour${t}" name="stopHour${t}" value="23">`,
        `${'\t'.repeat(13)}<input type="hidden" id="stopDayPart${t}" name="stopDayPart${t}" value="">`,
        '\t'.repeat(11),
        `${'\t'.repeat(11)}<input type="hidden" id="stopMinute${t}" name="stopMinute${t}" value="30">`,
      ].join('\n'),
    );
  });

  it('encodes the category name, and attribute-encodes only the start of the scheduled window', () => {
    const { markup } = render([node('01', '"Q" & <A>', FEATUREABLE, row(2, '2026-11-10 09:05:00', '2026-11-20 10:00:00'))]);
    expect(markup).toContain(' type="checkbox" \tchecked="true"/> &quot;Q&quot; &amp; &lt;A&gt;</label>');
    expect(markup).toContain('title="11&#x2f;10&#x2f;26&nbsp;-&nbsp;11/20/26"');
  });

  it('throws ACF’s error for a feature date it cannot read', () => {
    expect(() => render([node('01', 'Cat', FEATUREABLE, row(2, 'not a date'))])).toThrow(
      'The value not a date cannot be converted to a date.',
    );
  });
});
