// Unit tests for the cchangesets `dsp_categories_nest` category checkbox tree.
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { renderCategoriesNest, type ChangesetCategoryNode } from '@/screens/cchangesets/dsp_categories_nest';

const PARENT_ID = '24084683-CDC3-92F3-5638DA2185FAE575';
const CHILD_ID = '24085855-BC9D-74BB-0514207B8DED0B94';
const GRANDCHILD_ID = '24085D49-CACA-CA17-666F018EE47D54C8';
const CLOSED_ID = '240864EA-FEA6-7ABE-46134DE515D5FE12';
const ZETA_ID = '24086971-D103-C12F-3902C281950D3F38';

/** A permitted category without children. */
function node(categoryId: string, name: string, isOpen = true, children: ChangesetCategoryNode[] = []): ChangesetCategoryNode {
  return { categoryId, name, isOpen, permitted: true, children };
}

/** The tree seeded on an ACF 2023 instance for the captures below, in `getCategories` order. */
const SEEDED_TREE: readonly ChangesetCategoryNode[] = [
  node(CLOSED_ID, 'Closed Top', false),
  node(PARENT_ID, 'Parent & <One>', true, [
    node(CHILD_ID, `Child "quoted" 'x'`, true, [node(GRANDCHILD_ID, 'Grandchild', false)]),
  ]),
  node(ZETA_ID, 'Zeta'),
];

/** Legacy tag output for `SEEDED_TREE` at nest level 0, with `childChecked` marking the child's checkbox. */
function legacyCapture(childChecked: boolean): string {
  const box = (id: string, checked: boolean): string =>
    `<input type="checkbox" name="categoryID" class="checkbox" ${checked ? 'checked' : ''} value="${id}"  > `;
  return (
    '\n<ul class="categories checkboxTree">\n' +
    '\n<li>\nClosed Top \n</li>\n' +
    `\n<li>\n${box(PARENT_ID, false)}Parent &amp; &lt;One&gt; ` +
    '\n<ul class="categories">\n' +
    `\n<li>\n${box(CHILD_ID, childChecked)}Child &quot;quoted&quot; &#x27;x&#x27; ` +
    '\n<ul class="categories">\n' +
    '\n<li>\nGrandchild \n</li>\n' +
    '\n</ul>\n' +
    '\n</li>\n' +
    '\n</ul>\n' +
    '\n</li>\n' +
    `\n<li>\n${box(ZETA_ID, false)}Zeta \n</li>\n` +
    '\n</ul>\n'
  );
}

/** Rendered markup of `nodes` loaded as a fragment. */
function load(nodes: readonly ChangesetCategoryNode[], categoryIds = '', nestLevel?: number): cheerio.CheerioAPI {
  return cheerio.load(toString(renderCategoriesNest({ nodes, categoryIds, nestLevel })), null, false);
}

describe('renderCategoriesNest', () => {
  it.each<[string, string, boolean]>([
    ['the list filter with a checked id, a prefix of another id and an empty element', `,${CHILD_ID},${ZETA_ID.slice(0, -1)}`, true],
    ['the Categorization tab of a new change set', '', false],
  ])('reproduces the legacy bytes for %s', (_case, categoryIds, childChecked) => {
    const markup = renderCategoriesNest({ nodes: SEEDED_TREE, categoryIds, nestLevel: 0 });
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(legacyCapture(childChecked));
  });

  it.each<[string, number | undefined]>([
    ['the top level', 0],
    ['the default nest level', undefined],
  ])('renders nothing for an empty level at %s', (_case, nestLevel) => {
    expect(toString(renderCategoriesNest({ nodes: [], categoryIds: CHILD_ID, nestLevel }))).toBe('');
  });

  it.each<[number | undefined, string]>([
    [0, 'categories checkboxTree'],
    [undefined, 'categories'],
    [2, 'categories'],
  ])('gives nest level %s the list class "%s"', (nestLevel, className) => {
    expect(load([node(ZETA_ID, 'Zeta')], '', nestLevel)('ul').attr('class')).toBe(className);
  });

  it('nests children under their parent and adds checkboxTree only at the top', () => {
    const $ = load(SEEDED_TREE, '', 0);
    expect($.root().children('ul').attr('class')).toBe('categories checkboxTree');
    expect($('ul ul').map((_i, ul) => $(ul).attr('class')).get()).toEqual(['categories', 'categories']);
    const child = $(`input[value="${CHILD_ID}"]`);
    expect(child.closest('ul').parent('li').children('input').attr('value')).toBe(PARENT_ID);
  });

  it('renders a closed category as its name without a checkbox', () => {
    const li = load([node(CLOSED_ID, 'Closed Top', false)])('li');
    expect(li.children('input')).toHaveLength(0);
    expect(li.text().trim()).toBe('Closed Top');
  });

  it.each<[string, string, boolean]>([
    ['the only element', CHILD_ID, true],
    ['a middle element among empty ones', `,,${ZETA_ID},${CHILD_ID},`, true],
    ['a prefix of the id', CHILD_ID.slice(0, -1), false],
    ['the id with a suffix', `${CHILD_ID}0`, false],
    ['the id in lower case', CHILD_ID.toLowerCase(), false],
    ['the id with a leading space', ` ${CHILD_ID}`, false],
    ['an empty list', '', false],
  ])('checks the box when the list holds %s: %s', (_case, categoryIds, checked) => {
    const box = load([node(CHILD_ID, 'Child')], categoryIds)('input');
    expect(box.attr('name')).toBe('categoryID');
    expect(box.attr('type')).toBe('checkbox');
    expect(box.attr('value')).toBe(CHILD_ID);
    expect(box.is('[checked]')).toBe(checked);
  });

  it.each<[boolean, boolean]>([
    [false, true],
    [true, false],
  ])('with permitted %s renders disabled %s', (permitted, disabled) => {
    const nodes = [{ ...node(CHILD_ID, 'Child'), permitted }];
    expect(load(nodes)('input').is('[disabled]')).toBe(disabled);
  });

  it('encodes the name and a non-UUID id so neither can break out of the markup', () => {
    const markup = toString(renderCategoriesNest({ nodes: [node('"><b>x', `<i>&'"`)], categoryIds: '' }));
    expect(markup).toContain('value="&quot;&gt;&lt;b&gt;x"');
    expect(markup).toContain('&lt;i&gt;&amp;&#x27;&quot; ');
    const $ = cheerio.load(markup, null, false);
    expect($('b, i')).toHaveLength(0);
    expect($('li').text().trim()).toBe(`<i>&'"`);
  });
});
