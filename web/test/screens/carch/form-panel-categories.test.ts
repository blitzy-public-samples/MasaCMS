import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderCategoriesPanel, type CategoriesPanelInput } from '@/screens/carch/form/panel-categories';

// `cArch.edit` of Home on the default site, captured from the legacy ACF 2023 server as admin with the categories of
// `tree()` and the assignments of `ASSIGNED`, cut from the include's leading newline through `</script>\n`: once with
// the site as its own category pool, and once with the same categories moved to the pool site `poolsite`.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/${name}`, import.meta.url), 'utf8');
const LEGACY = fixture('edit-panel-categories.html');
const LEGACY_POOLED = fixture('edit-panel-categories-pooled.html');

const HIST = '6300ED69-1320-5CC3-F922E3012E2C6BAE';
const HOME = '00000000000000000000000000000000001';
const id = (n: string): string => `CB000000-0000-0000-00000000000000${n}`;
const trim = (n: string): string => id(n).replaceAll('-', '');
const path = (...ns: string[]): string => ns.map(id).join(',');

type Row = Record<string, unknown>;

function category(n: string, name: string, categoryPath: string, children: Row[] = [], extra: Row = {}): Row {
  const flags = { isOpen: 1, isFeatureable: 1, permitted: true, hasKids: children.length };
  return { categoryID: id(n), siteID: 'default', name, ...flags, path: categoryPath, children, ...extra };
}

/** The captured tree, each level in name order; Yankee Child keeps a quoted path. */
function tree(extra: Row = {}): Row[] {
  const yankee = category('05', 'Yankee Child', `'${id('04')}','${id('05')}'`, [], extra);
  return [
    category('04', 'Bravo Root', path('04'), [yankee], extra),
    category('06', 'Charlie Root', path('06'), [], extra),
    category('08', 'Delta Unassigned', path('08'), [], extra),
    category(
      '01',
      'Zulu Root',
      path('01'),
      [
        category(
          '02',
          'Mike Child',
          path('01', '02'),
          [
            category('03', 'Alpha Grandchild', path('01', '02', '03'), [], extra),
            category('07', 'Kilo Grandchild', path('01', '02', '07'), [], extra),
          ],
          extra,
        ),
      ],
      extra,
    ),
  ];
}

const assignment = (n: string, isFeature: number): Row => ({
  contentHistID: HIST,
  categoryID: id(n),
  contentID: HOME,
  isFeature,
  orderno: 0,
  featureStart: null,
  featureStop: null,
});
const ASSIGNED: Row[] = [assignment('05', 1), assignment('06', 0), assignment('03', 0), assignment('07', 0)];

const BEAN: Row = { siteID: 'default', contentID: HOME, contentHistID: HIST, categoryID: '' };
const SESSION = { locale: 'en_US', dateKeyFormat: 'MM/DD/YYYY', localeHasDayParts: true };

function input(rc: Row, siteid = 'default'): CategoriesPanelInput {
  return { ctx: { rb: rbFor('en'), req: { session: SESSION, rc: { siteid } } }, data: { rc } };
}

function render(rc: Row, siteid?: string): string {
  const result = renderCategoriesPanel(input(rc, siteid));
  expect(isSafeHtml(result.html)).toBe(true);
  return toString(result.html);
}

/** The category ids the ancestor-open script clicks, in order. */
const triggered = (markup: string): string[] =>
  [...markup.matchAll(/\$\('#bigui__categories li\[data-categoryid="([^"]*)"\]'\)/g)].map((m) => m[1] ?? '');

describe('carch.edit Categorization panel', () => {
  it('matches the legacy include byte for byte and reports its tab', () => {
    const result = renderCategoriesPanel(input({ contentBean: BEAN, categories: tree(), rsCategoryAssign: ASSIGNED }));
    expect(toString(result.html)).toBe(LEGACY);
    expect(result.tabId).toBe('tabCategorization');
    expect(result.tabLabel).toBe('Categories');
  });

  it('opens each ancestor once, for the assigned categories in name order rather than tree order', () => {
    const markup = render({ contentBean: BEAN, categories: tree(), rsCategoryAssign: ASSIGNED });
    expect(triggered(markup)).toEqual([id('01'), id('02'), id('04')]);
    expect(markup).toContain(
      "\t\t});\n\n\t\t$('#bigui__categories li[data-categoryid=\"CB000000-0000-0000-0000000000000001\"]')" +
        ".find('span.hasChildren:first').trigger('click'); $(",
    );
    expect(markup).toContain(".trigger('click'); \n\n\t\tcatsInited=true;");
  });

  it('opens nothing for a tree from another site’s category pool, as the feed filters by the request site', () => {
    const rc = { contentBean: BEAN, categories: tree({ siteID: 'poolsite' }), rsCategoryAssign: ASSIGNED };
    expect(render(rc)).toBe(LEGACY_POOLED);
  });

  it('compares the request site without case, as SQL Server does', () => {
    const markup = render({ contentBean: BEAN, categories: tree(), rsCategoryAssign: ASSIGNED }, 'DEFAULT');
    expect(triggered(markup)).toEqual([id('01'), id('02'), id('04')]);
  });

  it.each<[string, Row[]]>([
    ['without assignments', []],
    ['with rows of another version only', ASSIGNED.map((row) => ({ ...row, contentHistID: HIST.toLowerCase() }))],
  ])('checks nothing and opens nothing %s', (_case, rows) => {
    const markup = render({ contentBean: BEAN, categories: tree(), rsCategoryAssign: rows });
    expect(markup).not.toContain('checked="true"');
    expect(triggered(markup)).toEqual([]);
    expect(markup).toContain("\t\t});\n\n\t\t\n\n\t\tcatsInited=true;");
  });

  it('re-renders posted assignments from the bean, falling back to the rows where none was posted', () => {
    const bean = {
      ...BEAN,
      categoryID: `${id('08')},${id('07')}`,
      [`categoryAssign${trim('08')}`]: '1',
      [`CATEGORYASSIGN${trim('05')}`]: 0,
      [`categoryAssign${trim('07')}`]: '0',
    };
    const markup = render({ contentBean: bean, categories: tree(), rsCategoryAssign: ASSIGNED });
    const checked = [...markup.matchAll(/value="([^"]*)" type="checkbox" \tchecked="true"/g)].map((m) => m[1]);
    expect(checked).toEqual([id('06'), id('08'), id('03'), id('07')]);
    expect(markup).toContain(`name="categoryAssign${trim('08')}" value="1"`);
    expect(triggered(markup)).toEqual([id('01'), id('02')]);
  });

  it('breaks name ties in tree order and ignores case in the name order', () => {
    const categories = [
      category('11', 'beta', path('10', '11')),
      category('12', 'Alpha', path('13', '12')),
      category('14', 'BETA', path('15', '14')),
    ];
    const rows = ['11', '12', '14'].map((n) => assignment(n, 0));
    expect(triggered(render({ contentBean: BEAN, categories, rsCategoryAssign: rows }))).toEqual([
      id('13'),
      id('10'),
      id('15'),
    ]);
  });

  it('clicks an empty quoted path element every time, as legacy never finds it in its list', () => {
    const categories = [category('11', 'A', `'',${id('11')}`), category('12', 'B', `'',${id('12')}`)];
    const rows = ['11', '12'].map((n) => assignment(n, 0));
    expect(triggered(render({ contentBean: BEAN, categories, rsCategoryAssign: rows }))).toEqual(['', '']);
  });

  it('reads the category flags as legacy compares them', () => {
    const categories = [
      category('11', 'Closed', path('11'), [], { isOpen: '0', isFeatureable: null }),
      category('12', 'Plain', path('12'), [], { isOpen: '1.0', isFeatureable: 0, path: null, children: null }),
    ];
    const markup = render({ contentBean: BEAN, categories, rsCategoryAssign: [] });
    expect(markup).not.toContain(`value="${id('11')}" type="checkbox"`);
    expect(markup).toContain(`id="categoryLabelContainer${trim('11')}"`);
    expect(markup).toContain(`value="${id('12')}" type="checkbox" />`);
    expect(markup).not.toContain(`id="categoryLabelContainer${trim('12')}"`);
  });

  it.each<[string, Row, string]>([
    ['without rc.contentBean', { categories: [], rsCategoryAssign: [] }, 'rc holds no contentBean struct'],
    ['without rc.categories', { contentBean: BEAN, rsCategoryAssign: [] }, 'rc holds no categories rows'],
    ['without rc.rsCategoryAssign', { contentBean: BEAN, categories: [] }, 'rc holds no rsCategoryAssign rows'],
    [
      'with a category lacking its path',
      { contentBean: BEAN, categories: [{ ...category('11', 'A', ''), path: undefined }], rsCategoryAssign: [] },
      'A category of rc.categories has no path',
    ],
    [
      'with a category lacking its permission',
      { contentBean: BEAN, categories: [{ ...category('11', 'A', ''), permitted: 'yes' }], rsCategoryAssign: [] },
      'A category of rc.categories has no permitted flag',
    ],
    [
      'with a non-numeric kid count',
      { contentBean: BEAN, categories: [category('11', 'A', '', [], { hasKids: 'many' })], rsCategoryAssign: [] },
      'A category of rc.categories has a non-numeric hasKids',
    ],
    [
      'with an assignment row lacking its version',
      { contentBean: BEAN, categories: [category('11', 'A', '')], rsCategoryAssign: [{ categoryID: id('11') }] },
      'rc.rsCategoryAssign has no contentHistID',
    ],
    [
      'with a complex bean value',
      { contentBean: { ...BEAN, contentHistID: [HIST] }, categories: [], rsCategoryAssign: [] },
      'contentHistID is not a simple value',
    ],
  ])('throws %s', (_case, rc, message) => {
    expect(() => renderCategoriesPanel(input(rc))).toThrow(new TypeError(message));
  });
});
