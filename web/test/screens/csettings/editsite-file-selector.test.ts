import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLegacySettingsForTests } from '@/lib/env';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  renderFileSelector,
  renderFileTools,
  type FileSelectorOptions,
} from '@/screens/csettings/editsite/file-selector';
import { fragmentModel } from '../../helpers/dom-model';

// Placeholder Image markup captured from the legacy ACF 2023 Site Settings editor (site `default`).
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/programs-sites/file-selector/${name}.html`, import.meta.url), 'utf8');

const IMAGE_ID = 'E96179A4-AA08-3B1B-655CF7A6091215CE';
const FILE_ID = 'E966A553-A0A6-6C3D-6BD02262257365D5';
const CACHE_ID = 'E961B0FC-DE2F-13E7-2E602E773170A1C4';
const RAZUNA = { hostname: 'dam.example.com', apiKey: 'KEY123' };

/** The options `images.ts` passes for the Placeholder Image of site `default`. */
const placeholder = (overrides: Partial<FileSelectorOptions> = {}): FileSelectorOptions => ({
  name: 'newPlaceholderImg',
  property: 'placeholderImgID',
  fileId: '',
  siteId: 'default',
  deleteKey: 'deletePlaceholderImg',
  compactDisplay: 'false',
  locked: '0',
  exampleFileExt: '',
  fileMeta: null,
  rb: rbFor('en'),
  newCacheId: () => CACHE_ID,
  ...overrides,
});

const pngMeta = { fileId: IMAGE_ID, fileExt: 'png', imageUrl: `/sites/default/cache/file/${IMAGE_ID}_medium.png` };
const pdfMeta = { fileId: FILE_ID, fileExt: 'pdf', imageUrl: '' };

const useContext = (context: string | undefined): void => {
  vi.stubEnv('MURA_CONTEXT', context);
  resetLegacySettingsForTests();
};

beforeEach(() => useContext(undefined));

afterEach(() => {
  vi.unstubAllEnvs();
  resetLegacySettingsForTests();
});

describe('csettings.editsite file selector', () => {
  it.each<[string, Partial<FileSelectorOptions>]>([
    ['none', {}],
    ['image', { fileId: IMAGE_ID, fileMeta: pngMeta }],
    ['file', { fileId: FILE_ID, fileMeta: pdfMeta }],
    ['razuna', { fileId: FILE_ID, fileMeta: pdfMeta, razuna: RAZUNA }],
    [
      'encoded',
      {
        name: 'nImg',
        fileId: FILE_ID,
        deleteKey: 'delKey',
        className: 'x&quot;y',
        label: "a<b>&amp;&quot;c' é:/#\tt",
        required: "r'q",
        validation: 'v/w',
        regex: '^[a-z]+$',
        message: 'm:é',
        exampleFileExt: 'p&quot;ng',
        fileMeta: pdfMeta,
        razuna: RAZUNA,
      },
    ],
  ])('renders the %s placeholder exactly as legacy', (fixture, overrides) => {
    const out = renderFileSelector(placeholder(overrides));
    expect(isSafeHtml(out)).toBe(true);
    expect(toString(out)).toBe(legacy(fixture));
  });

  it.each<[string, Partial<FileSelectorOptions>, boolean, boolean]>([
    ['no placeholder', {}, false, false],
    ['an image placeholder', { fileId: IMAGE_ID, fileMeta: pngMeta }, true, true],
    ['a non-image placeholder', { fileId: FILE_ID, fileMeta: pdfMeta }, true, false],
  ])('shows the tools for %s', (_case, overrides, hasTools, hasImage) => {
    const $ = cheerio.load(toString(renderFileSelector(placeholder(overrides))), null, false);
    expect($('.mura-file-selector > .mura-control.justify')).toHaveLength(hasTools ? 1 : 0);
    expect($('img#assocImage')).toHaveLength(hasImage ? 1 : 0);
    expect($('.imageToolsButtonGroup > a.download-file')).toHaveLength(hasImage ? 1 : 0);
    expect($('a.download-file')).toHaveLength(hasTools ? 1 : 0);
    expect($('input.deleteFileBox[name="deletePlaceholderImg"][value="1"]')).toHaveLength(hasTools ? 1 : 0);
  });

  it('models the image placeholder controls and links', () => {
    const model = fragmentModel(toString(renderFileSelector(placeholder({ fileId: IMAGE_ID, fileMeta: pngMeta }))));
    expect(model.buttons.map((b) => b.text)).toEqual(['placeholder', 'Via Upload', 'Via URL', 'Select Existing']);
    expect(model.controls.map((c) => [c.name, c.type])).toEqual([
      ['newPlaceholderImg', 'file'],
      ['newPlaceholderImg', 'text'],
      ['deletePlaceholderImg', 'checkbox'],
    ]);
    expect(model.links.map((l) => l.text)).toEqual(['', '', 'Remove Attached File']);
    expect(model).toEqual(fragmentModel(legacy('image')));
  });

  it('adds the Razuna tab and URL field only with Razuna settings', () => {
    const $ = cheerio.load(toString(renderFileSelector(placeholder({ razuna: RAZUNA }))), null, false);
    expect($('button.btn-razuna-icon[value="URL-Razuna"]').text()).toBe(' Razuna');
    expect($('div.mura-file-url-razuna input.razuna-url').attr('placeholder')).toBe('http://dam.example.com');
    expect($('div.mura-file-url-razuna button.btn-razuna').text()).toBe(' Launch Razuna');

    const hostOnly = cheerio.load(toString(renderFileSelector(placeholder({ razuna: { hostname: 'h', apiKey: '' } }))));
    expect(hostOnly('.btn-razuna-icon')).toHaveLength(1);
    expect(hostOnly('.mura-file-url-razuna')).toHaveLength(0);
  });

  it.each<[string, string]>([
    ['placeholderImgID', 'File'],
    ['FileID', 'Image'],
  ])('types the %s property as %s', (property, fileType) => {
    const $ = cheerio.load(toString(renderFileSelector(placeholder({ property }))), null, false);
    expect($('.mura-file-selector').attr('data-filetype')).toBe(fileType);
  });

  it('applies the tag defaults for the example extension and the required label', () => {
    const out = toString(renderFileSelector(placeholder({ exampleFileExt: undefined })));
    const $ = cheerio.load(out, null, false);
    expect($('.mura-file-url input').attr('placeholder')).toBe('http://www.domain.com/yourfile.zip');
    expect(out).toContain('data-label="" data-label="newPlaceholderImg"');
  });

  it('prefixes the download URL with the configured context', () => {
    useContext('/cms');
    const $ = cheerio.load(toString(renderFileTools(placeholder({ fileId: FILE_ID, fileMeta: pdfMeta }))), null, false);
    expect($('a.download-file').attr('onclick')).toBe(
      "return confirmDialog('Download File?',function(){location.href='/cms/index.cfm/_api/render/file/" +
        `?fileid=${FILE_ID}&method=attachment&size=source';});`,
    );
  });

  it.each(['PNG', 'jpg', 'JPEG', 'svg', 'Gif'])('treats %s as an image extension', (fileExt) => {
    const out = toString(renderFileTools(placeholder({ fileMeta: { ...pngMeta, fileExt } })));
    expect(out).toContain(`<img id="assocImage" src="${pngMeta.imageUrl}?cacheID=${CACHE_ID}" />`);
  });

  it('renders no tools without a stored file', () => {
    expect(toString(renderFileTools(placeholder()))).toBe('');
  });
});
