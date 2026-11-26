import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderTagsPanel } from '@/screens/carch/form/panel-tags';

// `cArch.edit` of Home on the default site, captured from the legacy ACF 2023 server as admin with the site's
// `customTagGroups` and the version's default and group tags set as each case states, cut from the include's leading
// newline through `</div> \n`.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/edit-panel-tags-${name}.html`, import.meta.url), 'utf8');

const GROUP_TAGS = 'red,blue & "green"';

type Bean = Record<string, unknown>;

function render(contentBean: Bean, customTagGroups: string): string {
  const rc = { contentBean, siteConfig: { customTagGroups } };
  const result = renderTagsPanel({ ctx: { rb: rbFor('en') }, data: { rc } });
  expect(isSafeHtml(result.html)).toBe(true);
  return toString(result.html);
}

describe('carch.edit Tags panel', () => {
  it.each<[string, Bean, string]>([
    ['plain', { tags: '' }, ''],
    [
      'groups',
      {
        TAGS: `alpha,Tom & Jerry,say "hi",<b>bold</b>,café,O'Brien`,
        Colortags: GROUP_TAGS,
        sizetags: '',
        Regiontags: "O'Hare",
        shapeTAGS: 'round',
      },
      'Color^Size, Region ,Shape',
    ],
    ['delimiters', { tags: ',,alpha,,beta,', Colortags: GROUP_TAGS, Sizetags: '' }, '^ Color ^^,Size,'],
    ['blank-group', { tags: '', Colortags: GROUP_TAGS, Sizetags: '' }, 'Color^ ,Size'],
  ])('matches the legacy include byte for byte (%s)', (name, bean, groups) => {
    expect(render(bean, groups)).toBe(fixture(name));
  });

  it('reports the tab id and label the include appends', () => {
    const result = renderTagsPanel({ ctx: { rb: rbFor('en') }, data: { rc: { contentBean: {}, siteConfig: {} } } });
    expect(result.tabId).toBe('tabTags');
    expect(result.tabLabel).toBe('Tags');
    expect(toString(result.html)).toBe(fixture('plain'));
  });

  it('reads SQL NULL as empty and numbers as their CFML text', () => {
    const markup = render({ tags: null, Ntags: 2024 }, 'N');
    expect(markup).toContain('<input name="Ntags" type="hidden" value="2024">');
    expect(markup).not.toContain('<input name="tags" type="hidden"');
  });

  it.each<[string, Bean, string]>([
    ['without rc.contentBean', { siteConfig: {} }, 'Element CONTENTBEAN is undefined in RC.'],
    ['without rc.siteConfig', { contentBean: {} }, 'Element SITECONFIG is undefined in RC.'],
    ['on a complex tag value', { contentBean: { tags: ['a'] }, siteConfig: {} }, 'tags is not a simple value'],
  ])('fails as legacy does %s', (_case, rc, message) => {
    expect(() => renderTagsPanel({ ctx: { rb: rbFor('en') }, data: { rc } })).toThrow(new TypeError(message));
  });
});
