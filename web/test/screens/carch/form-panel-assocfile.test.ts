import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { businessClock } from '@opt2/platform/testing';
import { isSafeHtml, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import type { EditFormInput, EditFormState } from '@/screens/carch/form/custom-tags';
import { renderFileSelector } from '@/screens/carch/form/file-selector';
import { renderPanelAssocFile } from '@/screens/carch/form/panel-assocfile';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';

// `cArch.edit` of a new Page and a new Link under Home on the default site (ptype Page), captured from the legacy
// ACF 2023 server as admin (S2) and cut from the include's newline after `<cfoutput>` through `</div> \n`.
const legacy = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/edit-panel-assocfile-${name}.html`, import.meta.url), 'utf8');

/** The ids edit.cfm gave each captured new version. */
const CAPTURED_IDS = {
  Page: { contentID: '4529D8D8-E991-533B-2DC6171F6A754041', contentHistID: '4529DA86-C4E0-4766-2AF7DA8AD8314D0D' },
  Link: { contentID: '4529E65F-C3A2-811D-575B002B01560F1E', contentHistID: '4529E6F5-F29F-ADD1-F2AE8D5C7F9CE2A7' },
} as const;

const STATE: EditFormState = Object.freeze({
  tabAssignments: '',
  pageLevelList: 'Page,Folder,Calendar',
  baseTypeList: 'Page,Folder,Calendar,Gallery,Link,File',
  subTypes: [],
  subtypeFilter: '',
  isExtended: false,
  requiresApproval: false,
  showApprovalStatus: false,
  hasChangesets: false,
  ptype: 'Page',
  compactDisplay: 'false',
  preview: '0',
});

/** A new version's `rc.contentBean` with no stored file and no lock. */
function newBean(type: string, ids: { contentID: string; contentHistID: string }): Record<string, unknown> {
  return {
    ...ids,
    isNew: 1,
    type,
    siteID: 'default',
    fileID: '',
    fileExt: '',
    majorVersion: 0,
    minorVersion: 0,
    stats: { lockID: '', lockType: '' },
  };
}

/** The S2 admin editing a new `type` version in `locale`; `type` undefined leaves `rc.type` unset. */
function editInput(type: string | undefined, locale = 'en', ptype = 'Page'): EditFormInput {
  const req = adminS2Request({ circuit: 'carch', item: 'edit', rc: { type }, session: { rb: locale } });
  const ctx = { req, rb: rbFor(locale), now: businessClock().now() } as unknown as ScreenContext;
  const bean = newBean(type ?? 'Page', CAPTURED_IDS.Page);
  return { ctx, req, data: { rc: { contentBean: bean } }, state: { ...STATE, ptype } };
}

describe('carch.edit associated image panel', () => {
  it.each(['Page', 'Link'] as const)('matches the legacy include byte for byte for a new %s', async (type) => {
    const input = editInput(type);
    const panel = await renderPanelAssocFile({
      ...input,
      data: { rc: { contentBean: newBean(type, CAPTURED_IDS[type]) } },
    });
    expect(panel).not.toBeNull();
    expect(isSafeHtml(panel?.html)).toBe(true);
    expect(toString(panel!.html)).toBe(legacy(type.toLowerCase()));
    expect(panel?.tabId).toBe('tabAssoc');
    expect(panel?.tabLabel).toBe('Image');
    expect(panel?.bodyContent).toBeUndefined();
    expect(panel?.htmlHead).toBeUndefined();
  });

  it.each(['File', 'Component', 'Form', 'Variation', 'Module', ''])('renders nothing and no tab for type %j', async (type) => {
    await expect(renderPanelAssocFile(editInput(type))).resolves.toBeNull();
  });

  it.each(['Folder', 'Calendar', 'Gallery', 'page', 'LINK'])('renders for type %s, matched without case', async (type) => {
    const panel = await renderPanelAssocFile(editInput(type));
    expect(panel?.tabId).toBe('tabAssoc');
  });

  it('wraps the file selector output between the assoc containers', async () => {
    const input = editInput('Folder', 'en', 'Gallery');
    const [panel, selector] = await Promise.all([renderPanelAssocFile(input), renderFileSelector(input)]);
    expect(toString(panel!.html)).toContain(
      `<span id="extendset-container-tabassoctop" class="extendset-container"></span>\n\n\t\t\t\t\t\t\t\t\n\t\t\t\t${selector.value}\n\n\t\t\t\t<span id="extendset-container-assoc" class="extendset-container"></span>`,
    );
  });

  // Legacy prints the label's last space-delimited word unencoded, as the bundle holds it.
  it.each<[string, string]>([
    ['en', 'Image'],
    ['de', 'ausw&auml;hlen'],
    ['fr', 'envoyer'],
  ])('labels the %s heading with the last word of the select image label', async (locale, word) => {
    const panel = await renderPanelAssocFile(editInput('Page', locale));
    expect(panel?.tabLabel).toBe(word);
    expect(toString(panel!.html)).toContain(`aria-controls="panel-assoc">\n\t\t\t\t\n\t\t\t\t${word} \n\t\t\t</a>`);
  });

  it('throws when rc.type is undefined', async () => {
    await expect(renderPanelAssocFile(editInput(undefined))).rejects.toThrow(TypeError);
  });
});
