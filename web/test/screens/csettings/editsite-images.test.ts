import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { isSupportedLocale, rbFor } from '@/lib/resource-bundles/rb';
import { renderImagesTab } from '@/screens/csettings/editsite/images';
import type { EditSiteBean, EditSiteModel, PlaceholderFileMeta } from '@/screens/csettings/editsite/model';
import { fragmentModel } from '../../helpers/dom-model';

// `cSettings.editSite` panes captured from the legacy ACF 2023 server, cut from `<div id="tabImages"` to the pane's
// close: site `default` and Add Site (`siteid=&addsite`).
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/programs-sites/${name}`, import.meta.url), 'utf8');
const DEFAULT_PANE = fixture('editsite-images-default.html');
const ADD_PANE = fixture('editsite-images-add.html');
const selectorFixture = (name: string): string => fixture(`file-selector/${name}.html`);

const IMAGE_ID = 'E96179A4-AA08-3B1B-655CF7A6091215CE';
const FILE_ID = 'E966A553-A0A6-6C3D-6BD02262257365D5';
const CACHE_ID = 'E961B0FC-DE2F-13E7-2E602E773170A1C4';
const PNG_META: PlaceholderFileMeta = {
  fileId: IMAGE_ID,
  fileExt: 'png',
  imageUrl: `/sites/default/cache/file/${IMAGE_ID}_medium.png`,
};
const PDF_META: PlaceholderFileMeta = { fileId: FILE_ID, fileExt: 'pdf', imageUrl: '' };

type ImageFields = Pick<
  EditSiteBean,
  | 'siteID'
  | 'smallImageHeight'
  | 'smallImageWidth'
  | 'mediumImageHeight'
  | 'mediumImageWidth'
  | 'largeImageHeight'
  | 'largeImageWidth'
  | 'placeholderImgID'
>;

// The installed `default` site as legacy reads it; the renderer reads only these bean fields.
const DEFAULT_SITE: ImageFields = {
  siteID: 'default',
  smallImageHeight: '80',
  smallImageWidth: '80',
  mediumImageHeight: '180',
  mediumImageWidth: '180',
  largeImageHeight: '600',
  largeImageWidth: 'AUTO',
  placeholderImgID: '',
};

// A new settingsBean: legacy's Add Site defaults.
const NEW_SITE: Partial<ImageFields> = { siteID: '', largeImageHeight: 'AUTO', largeImageWidth: '600' };

function render(fields: Partial<ImageFields> = {}, placeholderFile: PlaceholderFileMeta | null = null): string {
  const model = {
    bean: { ...DEFAULT_SITE, ...fields },
    rb: rbFor('en'),
    isSupportedLocale,
    compactDisplay: 'false',
    placeholderFile,
    newCacheId: () => CACHE_ID,
  } as unknown as EditSiteModel;
  const markup = renderImagesTab(model);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** The inline `<script>` element, from its opening tag through its closing tag. */
function scriptOf(markup: string): string {
  const start = markup.indexOf('<script>');
  return markup.slice(start, markup.indexOf('</script>', start) + '</script>'.length);
}

beforeEach(() => {
  vi.stubEnv('MURA_CONTEXT', undefined);
  resetLegacySettingsForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('csettings.editsite Images tab', () => {
  it('matches the legacy pane of the default site byte for byte', () => {
    expect(render()).toBe(DEFAULT_PANE);
  });

  it('matches the legacy Add Site pane, which has neither the script nor the custom image control', () => {
    const markup = render(NEW_SITE);
    expect(markup).toBe(ADD_PANE);
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('openCustomImageSize');
    expect(markup).not.toContain('custom-images-container');
    expect(fragmentModel(markup).labels).not.toContain('Custom Images');
  });

  it.each<[string, string]>([
    ['tenant-a', 'tenant\\x2Da'],
    ["o'k<", 'o\\x27k\\x3C'],
  ])('writes site %s into the script and the add link as esapiEncode javascript does', (siteID, encoded) => {
    const markup = render({ siteID });
    const legacyScript = scriptOf(DEFAULT_PANE).replace(
      "loadCustomImages({siteid:'default'})",
      `loadCustomImages({siteid:'${encoded}'})`,
    );
    expect(scriptOf(markup)).toBe(legacyScript);
    expect(markup).toContain(`onclick="return openCustomImageSize('','${encoded}')"`);
    expect(markup).toBe(
      DEFAULT_PANE.replace(scriptOf(DEFAULT_PANE), legacyScript)
        .replace("openCustomImageSize('','default')", `openCustomImageSize('','${encoded}')`)
        .replaceAll("'default','placeholderImgID'", `'${siteID}','placeholderImgID'`)
        .replace('data-siteid="default"', `data-siteid="${siteID}"`),
    );
  });

  it.each<[string, PlaceholderFileMeta, string]>([
    ['an image', PNG_META, 'image'],
    ['a non-image', PDF_META, 'file'],
  ])('embeds the file selector with the tools of %s placeholder', (_case, meta, selector) => {
    const withoutFile = selectorFixture('none');
    expect(DEFAULT_PANE).toContain(withoutFile);
    expect(render({ placeholderImgID: meta.fileId }, meta)).toBe(
      DEFAULT_PANE.replace(withoutFile, selectorFixture(selector)),
    );
  });

  it('models the pane headings, labels and controls in legacy order', () => {
    const model = fragmentModel(render());
    expect(model.headings).toEqual(['Image Galleries']);
    expect(model.labels.filter((l) => l !== 'Height' && l !== 'Width')).toEqual([
      'Small (Thumbnail) Image',
      'Medium Image',
      'Large Image',
      'Custom Images',
      'Placeholder Image',
    ]);
    expect(model.controls.map((c) => [c.name, c.type, c.value])).toEqual([
      ['smallImageHeight', 'text', '80'],
      ['smallImageWidth', 'text', '80'],
      ['mediumImageHeight', 'text', '180'],
      ['mediumImageWidth', 'text', '180'],
      ['largeImageHeight', 'text', '600'],
      ['largeImageWidth', 'text', 'AUTO'],
      ['newPlaceholderImg', 'file', ''],
      ['newPlaceholderImg', 'text', ''],
    ]);
    expect(model).toEqual(fragmentModel(DEFAULT_PANE));
  });

  it('HTML-attribute-encodes the size values', () => {
    const value = '"<a&b>\' é';
    const markup = render({ smallImageHeight: value });
    expect(markup).toContain(
      'name="smallImageHeight" type="text" value="&quot;&lt;a&amp;b&gt;&#x27;&#x20;&eacute;" />',
    );
    expect(fragmentModel(markup).controls.find((c) => c.name === 'smallImageHeight')?.value).toBe(value);
  });
});
