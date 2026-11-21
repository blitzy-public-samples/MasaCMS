import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { renderDisplayRegionsTab } from '@/screens/csettings/editsite/display-regions';
import type { EditSiteBean, EditSiteModel } from '@/screens/csettings/editsite/model';
import { fragmentModel, type DomControl } from '../../helpers/dom-model';

const here = import.meta.dirname ?? __dirname;
// `cSettings.editSite&siteid=default` as legacy renders it, cut from `<div id="tabDisplayregions"` to the pane's close.
const CAPTURED = path.resolve(here, '../../fixtures/programs-sites/editsite-display-regions.html');

type RegionFields = Pick<EditSiteBean, 'columnCount' | 'primaryColumn' | 'columnNames'>;

const DEFAULT_SITE: RegionFields = {
  columnCount: 3,
  primaryColumn: 2,
  columnNames: 'Left Column^Main Content^Right Column',
};

// The renderer reads only these bean fields, so the rest of the model is left out.
function render(fields: Partial<RegionFields> = {}): string {
  const model = { bean: { ...DEFAULT_SITE, ...fields } } as unknown as EditSiteModel;
  const markup = renderDisplayRegionsTab(model);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

function controlNamed(markup: string, name: string): DomControl {
  const found = fragmentModel(markup).controls.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no control named ${name}`);
  return found;
}

const ONE_TO_TWENTY = Array.from({ length: 20 }, (_, i) => String(i + 1));

describe('renderDisplayRegionsTab', () => {
  it('matches the legacy markup of the default site byte for byte', () => {
    expect(render()).toBe(readFileSync(CAPTURED, 'utf8'));
  });

  it('renders the pane heading, labels and the three controls in order', () => {
    const model = fragmentModel(render());
    expect(model.headings).toEqual(['Display Regions']);
    expect(model.labels).toEqual([
      'Number of Display Regions',
      'Primary Display Region',
      'Display Region Names "^" Delimiter',
    ]);
    expect(model.controls.map((c) => [c.tag, c.name, c.type])).toEqual([
      ['select', 'columnCount', 'select-one'],
      ['select', 'primaryColumn', 'select-one'],
      ['input', 'columnNames', 'text'],
    ]);
  });

  it.each(['columnCount', 'primaryColumn'])('offers %s values 1 to 20', (name) => {
    const options = controlNamed(render(), name).options;
    expect(options.map((o) => o.value)).toEqual(ONE_TO_TWENTY);
    expect(options.map((o) => o.label)).toEqual(ONE_TO_TWENTY);
  });

  it.each<[EditSiteBean['columnCount'], string[]]>([
    [0, ['1']],
    [1, ['1']],
    ['0', ['1']],
    [3, ['3']],
    ['3', ['3']],
    [' 3', ['3']],
    [20, ['20']],
    [21, []],
    ['', []],
  ])('selects the region count for columnCount %j', (columnCount, expected) => {
    expect(controlNamed(render({ columnCount }), 'columnCount').selected).toEqual(expected);
  });

  it.each<[EditSiteBean['primaryColumn'], string[]]>([
    [2, ['2']],
    ['2', ['2']],
    [1, ['1']],
    [20, ['20']],
    [0, []],
    ['', []],
  ])('selects the primary region for primaryColumn %j', (primaryColumn, expected) => {
    expect(controlNamed(render({ primaryColumn }), 'primaryColumn').selected).toEqual(expected);
  });

  it('writes the selected flag after a doubled space, as the CFML does', () => {
    const markup = render({ columnCount: 0, primaryColumn: 2 });
    expect(markup).toContain('<option value="1"  selected> 1</option>');
    expect(markup).toContain('<option value="2"  selected>2</option>');
    expect(markup).toContain('<option value="20" >20</option>');
  });

  it('encodes the region names with the html_attr encoder', () => {
    const columnNames = 'Left "A" & <B>^Main\'s, Content';
    const markup = render({ columnNames });
    expect(markup).toContain(
      'value="Left&#x20;&quot;A&quot;&#x20;&amp;&#x20;&lt;B&gt;&#x5e;Main&#x27;s,&#x20;Content"',
    );
    expect(controlNamed(markup, 'columnNames').value).toBe(columnNames);
  });
});
