import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditSiteBean, EditSiteModel, SiteOption } from '@/screens/csettings/editsite/model';
import { renderSharedResourcesTab } from '@/screens/csettings/editsite/shared-resources';
import legacy from '../../fixtures/csettings/editsite-shared-resources.json';
import { fragmentModel } from '../../helpers/dom-model';

type PoolBean = Pick<
  EditSiteBean,
  'siteID' | 'publicUserPoolID' | 'privateUserPoolID' | 'displayPoolID' | 'filePoolID' | 'categoryPoolID' | 'contentPoolID'
>;

const rb = rbFor('en');

// `settingsManager.getList()` order; names carry markup characters, a CR and non-ASCII text.
const SITES: readonly SiteOption[] = [
  { siteid: 'default', site: 'Default' },
  { siteid: 'umbrella', site: `Umbrella <Pool> & "Co" 'x' (é)` },
  { siteid: 'tenant-a', site: 'Tenant A' },
  { siteid: 'tenant-b', site: 'Tenant\r\nB / Ü' },
];

/** Bean whose pools all read as `siteID`, as getters return an unset pool. */
function ownPools(siteID: string): PoolBean {
  return {
    siteID,
    publicUserPoolID: siteID,
    privateUserPoolID: siteID,
    displayPoolID: siteID,
    filePoolID: siteID,
    categoryPoolID: siteID,
    contentPoolID: siteID,
  };
}

/** The model fields the Shared Resources pane reads. */
function model(bean: PoolBean, requestSiteId: string): EditSiteModel {
  return { bean, sites: SITES, requestSiteId, rb } as unknown as EditSiteModel;
}

const CASES: Record<keyof typeof legacy.cases, EditSiteModel> = {
  'tenant-a': model(
    {
      siteID: 'tenant-a',
      publicUserPoolID: 'umbrella',
      privateUserPoolID: 'tenant-a',
      displayPoolID: 'umbrella',
      filePoolID: 'umbrella',
      categoryPoolID: 'umbrella',
      contentPoolID: 'tenant-a,umbrella',
    },
    'tenant-a',
  ),
  'tenant-b': model(ownPools('tenant-b'), 'tenant-b'),
  addsite: model(ownPools(''), ''),
};

/** Name and selected values of each select in the pane. */
function selections(markup: string): Array<[string, string[]]> {
  return fragmentModel(markup).controls.map((c) => [c.name, c.selected]);
}

describe('csettings.editsite Shared Resources tab', () => {
  it.each(Object.keys(CASES) as Array<keyof typeof CASES>)('%s renders the legacy bytes', (name) => {
    const markup = renderSharedResourcesTab(CASES[name]);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(legacy.cases[name]);
  });

  it('selects the stored pool sites and lists every other site under the legacy labels', () => {
    const markup = toString(renderSharedResourcesTab(CASES['tenant-a']));
    const dom = fragmentModel(markup);
    expect(dom.headings).toEqual(['Shared Resources']);
    expect(dom.labels).toEqual([
      'Member User Pool',
      'System User Pool',
      'Display Object Pool',
      'File Storage Pool',
      'Category Pool',
      'Related Content Pools',
    ]);
    expect(selections(markup)).toEqual([
      ['publicUserPoolID', ['umbrella']],
      ['privateUserPoolID', []],
      ['displayPoolID', ['umbrella']],
      ['filePoolID', ['umbrella']],
      ['categoryPoolID', ['umbrella']],
      ['contentPoolID', ['tenant-a', 'umbrella']],
    ]);
    const content = dom.controls.find((c) => c.name === 'contentPoolID');
    expect(content?.type).toBe('select-multiple');
    expect(content?.options.map((o) => o.value)).toEqual(['tenant-a', 'default', 'umbrella', 'tenant-b']);
  });

  it('matches site ids loosely when excluding the edited site and selecting pools', () => {
    const bean = { ...ownPools('TENANT-B'), publicUserPoolID: 'UMBRELLA' };
    const markup = toString(renderSharedResourcesTab(model(bean, 'TENANT-B')));
    const publicPool = fragmentModel(markup).controls[0];
    expect(publicPool?.options.map((o) => o.value)).toEqual(['', 'default', 'umbrella', 'tenant-a']);
    expect(publicPool?.selected).toEqual(['umbrella']);
  });
});
