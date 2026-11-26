import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { renderBundlesTab } from '@/screens/csettings/editsite/bundles';
import type { EditSiteModel } from '@/screens/csettings/editsite/model';
import { fragmentModel } from '../../helpers/dom-model';

interface Options {
  readonly javaEnabled?: boolean;
  readonly postBundles?: boolean;
  readonly isS2?: boolean;
  readonly broadcaster?: boolean;
  readonly siteID?: string;
  readonly publicUserPoolID?: string;
  readonly privateUserPoolID?: string;
}

/** A model carrying only the values the Bundles tab reads. */
function model(o: Options = {}): EditSiteModel {
  const siteID = o.siteID ?? 'default';
  return {
    bean: {
      siteID,
      publicUserPoolID: o.publicUserPoolID ?? siteID,
      privateUserPoolID: o.privateUserPoolID ?? siteID,
    },
    config: {
      javaEnabled: o.javaEnabled ?? true,
      lockableNodes: false,
      dataCollection: true,
      emailBroadcaster: true,
      postBundles: o.postBundles ?? false,
      razuna: false,
      useLayoutManager: false,
    },
    isS2: o.isS2 ?? true,
    sessionSiteEmailBroadcaster: o.broadcaster ?? false,
  } as EditSiteModel;
}

/** Rendered markup of the tab. */
function render(o: Options = {}): string {
  const markup = renderBundlesTab(model(o));
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

const LEGACY_DEFAULT_SITE = readFileSync(
  new URL('../../fixtures/csettings/editsite-bundles-default.html', import.meta.url),
  'utf8',
);

const JAVA_DISABLED = [
  '\t\t<div id="tabBundles" class="tab-pane">',
  '\t\t\t',
  '\t\t\t<div class="block block-bordered">',
  '\t\t\t\t<div class="mura-control-group">',
  '\t\t\t\t\t<div class="help-block-empty">',
  '\t\t\t\t\t\tJava is disabled. This feature is unavailable.',
  '\t\t\t\t\t</div>',
  '\t\t\t\t</div>',
  '\t\t\t</div>',
  '\t\t\t',
  '\t\t</div> ',
  '\t</div> ',
  '',
].join('\n');

type ControlRow = [name: string, type: string, value: string, checked: boolean];

/** Controls legacy renders for the given flags, in document order. */
function expectedControls(isS2: boolean, postBundles: boolean, broadcaster: boolean): ControlRow[] {
  const s2Only: ControlRow[] = [
    ['bundleImportKeyMode', 'radio', 'copy', true],
    ['bundleImportKeyMode', 'radio', 'publish', false],
    ['bundleImportContentMode', 'checkbox', 'all', false],
    ['bundleImportUsersMode', 'checkbox', 'all', false],
    ...(broadcaster ? [['bundleImportMailingListMembersMode', 'checkbox', 'all', false] as ControlRow] : []),
    ['bundleImportFormDataMode', 'checkbox', 'all', false],
    ['bundleImportPluginMode', 'checkbox', 'all', false],
    ['bundleImportRenderingMode', 'radio', 'all', false],
  ];
  return [
    ...(isS2 ? s2Only : []),
    ['bundleImportRenderingMode', 'radio', 'theme', !isS2],
    ['bundleImportRenderingMode', 'radio', 'none', true],
    ['serverBundlePath', 'text', '', false],
    postBundles ? ['bundleFile', 'file', '', false] : ['bundleFile', 'hidden', '', false],
  ];
}

/** Label texts legacy renders for the given flags, in document order. */
function expectedLabels(isS2: boolean, postBundles: boolean, broadcaster: boolean): string[] {
  const s2Only = [
    'Are you restoring a site from a backup bundle?',
    'No - Assign New Keys to Imported Items',
    'Yes - Maintain All Keys from Imported Items',
    'Include:',
    'Site Architecture & Content',
    'Site Members & Administrative Users',
    ...(broadcaster ? ['Mailing Lists Members'] : []),
    'Form Response Data',
    'All Plugins',
  ];
  return [
    ...(isS2 ? s2Only : []),
    'Which rendering files would you like to import?',
    ...(isS2 ? ['All'] : []),
    'Theme Only',
    'None',
    postBundles ? 'Select Bundle File From Server (Preferred)' : 'Select Bundle File From Server',
    ...(postBundles ? ['Upload Bundle File'] : []),
  ];
}

const FLAGS = [true, false].flatMap((isS2) =>
  [true, false].flatMap((postBundles) => [true, false].map((broadcaster) => ({ isS2, postBundles, broadcaster }))),
);

describe('renderBundlesTab', () => {
  it('reproduces the legacy pane byte for byte for an S2 user on the default site', () => {
    expect(render()).toBe(LEGACY_DEFAULT_SITE);
  });

  it('renders the Java-disabled notice followed by both unconditional closers', () => {
    expect(render({ javaEnabled: false })).toBe(JAVA_DISABLED);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])('with javaEnabled=%s the closers leave %i following elements inside the tab-content', (javaEnabled, inside) => {
    const $ = cheerio.load(
      `<div class="tab-content">${render({ javaEnabled })}<div id="tabNext" class="tab-pane"></div></div>`,
      null,
      false,
    );
    expect($('.tab-content > #tabNext')).toHaveLength(inside);
    expect($('#tabBundles > .block.block-bordered')).toHaveLength(1);
  });

  it.each(FLAGS)('renders the Java-enabled controls for %o', ({ isS2, postBundles, broadcaster }) => {
    const markup = render({ isS2, postBundles, broadcaster });
    const dom = fragmentModel(markup);
    const controls = dom.controls.map((c): ControlRow => [c.name, c.type, c.value, c.checked]);
    expect(controls).toEqual(expectedControls(isS2, postBundles, broadcaster));
    expect(dom.labels).toEqual(expectedLabels(isS2, postBundles, broadcaster));
    expect(dom.headings).toEqual(['Deploy Site Bundle']);
    expect(dom.buttons).toEqual([{ text: 'Browse Server', type: 'button', hasOnclick: false }]);

    const $ = cheerio.load(markup, null, false);
    expect($('#themeNotice').attr('style')).toBe(isS2 ? 'display:none' : undefined);
    expect($('#contentRemovalNotice, #userNotice')).toHaveLength(isS2 ? 2 : 0);
    expect($('p.help-block:not([id])')).toHaveLength(postBundles ? 1 : 0);
    expect($('#tabBundles > .block > .block-content')).toHaveLength(1);
  });

  it.each([
    ['default', 'default', 'default', false],
    ['tenant-a', 'umbrella', 'tenant-a', true],
    ['tenant-b', 'tenant-b', 'tenant-b', false],
    ['tenant-c', 'tenant-c', 'umbrella', true],
    ['Tenant-B', 'tenant-b', 'TENANT-B', false],
  ])('site %s with pools %s/%s hides the users option: %s', (siteID, publicUserPoolID, privateUserPoolID, hidden) => {
    const $ = cheerio.load(render({ siteID, publicUserPoolID, privateUserPoolID }), null, false);
    expect($('#bundleImportUsersModeLI').attr('style')).toBe(hidden ? 'display:none;' : undefined);
    expect($('#bundleImportUsersModeLI #bundleImportUsersMode')).toHaveLength(1);
  });
});
