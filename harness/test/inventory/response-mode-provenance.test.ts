// Committed inventory download, bare-body and post-action modes checked against the pinned admin views and controllers.
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openSourceTree, parseAttributes, parseCfmTemplate, parseCfmlComponent } from '../../src/inventory/closure.js';
import { gitArchiveExtract } from '../../src/lib/git.js';
import { opt2Path } from '../../src/lib/paths.js';
import { pinnedSha } from '../../src/lib/pin.js';

interface InventoryAction {
  id: string;
  name: string;
  source: { path: string; lines: [number, number] };
  viewPath: string | null;
  variants: Array<{ id: string; responseMode: string; layout: string | null; contentType: string | null }>;
}

const inventory = JSON.parse(readFileSync(opt2Path('inventory', 'legacy-inventory.json'), 'utf8')) as {
  controllers: Array<{ actions: InventoryAction[] }>;
};
const actions = inventory.controllers.flatMap((c) => c.actions);

// Extracted at collection so it.each can enumerate the downloading views.
const root = await gitArchiveExtract(pinnedSha());
afterAll(() => rm(root, { recursive: true, force: true }));
const tree = openSourceTree(root);

const DISPOSITION = /\b(?:cf)?header\b[^>;]*?\bname\s*=\s*["']content-disposition["']/i;
const CFCONTENT = /<cfcontent\b([^>]*)>/gi;
const USERS_VIEW = 'admin/core/views/cusers/download.cfm';
// An optional <cfcontent>, one <cfoutput> block and <cfabort>, nothing else.
const BARE_VIEW = /^\s*(?:<cfcontent\b[^>]*>\s*)?<cfoutput>(?:(?!<\/?cfoutput\b)[\s\S])*<\/cfoutput>\s*<cfabort\b[^>]*>\s*$/i;
// expand() splices each target in before its include tag, which is left in place.
const INCLUDE_TAG = /<cfinclude\b[^>]*>/gi;
const INLINE_SAVE = 'ctl:carch.updateobjectparams';

/** Comment-stripped text of the template `rel` with each static include's expansion spliced in at its offset. */
function expand(rel: string): string {
  const unit = parseCfmTemplate(rel, tree.readText(rel));
  let text = unit.text;
  for (const inc of [...(unit.functions[0]?.includes ?? [])].reverse()) {
    const target = path.posix.join(path.posix.dirname(rel), inc.template);
    // Skips dynamic `#…#` templates and targets absent at the pin (carch/datamanager.cfm includes one).
    if (inc.template.includes('#') || !tree.exists(target)) continue;
    text = text.slice(0, inc.offset) + expand(target) + text.slice(inc.offset);
  }
  return text;
}

/** `type` of the first `<cfcontent>` that declares one. */
function declaredType(text: string): string | undefined {
  for (const m of text.matchAll(CFCONTENT)) {
    const type = parseAttributes(m[1] ?? '').type;
    if (type !== undefined) return type;
  }
  return undefined;
}

type ScannedAction = { id: string; variants: InventoryAction['variants']; type: string | undefined };

// Actions whose expanded view sends a Content-Disposition header, and those whose expanded view only prints one
// output block and aborts; afterAll never runs if this scan throws.
let downloads: ScannedAction[];
let bareViews: ScannedAction[];
try {
  const expanded = actions.map((a) => ({ action: a, text: a.viewPath === null ? '' : expand(a.viewPath) }));
  const scanned = ({ action, text }: (typeof expanded)[number]): ScannedAction => ({
    id: action.id,
    variants: action.variants,
    type: declaredType(text),
  });
  downloads = expanded.filter(({ text }) => DISPOSITION.test(text)).map(scanned);
  bareViews = expanded.filter(({ text }) => BARE_VIEW.test(text.replace(INCLUDE_TAG, ''))).map(scanned);
} catch (error) {
  await rm(root, { recursive: true, force: true });
  throw error;
}

describe('download response mode against the pinned view and its includes', () => {
  it('finds a Content-Disposition header in exactly the known download views', () => {
    expect(downloads.map((a) => a.id).sort()).toEqual([
      'ctl:carch.downloaddata',
      'ctl:carch.exportcomponent',
      'ctl:cemail.download',
      'ctl:cextend.download',
      'ctl:cform.export',
      'ctl:cmailinglist.download',
      'ctl:cusers.download',
    ]);
  });

  it.each(downloads)('$id records download with the declared cfcontent type', ({ variants, type }) => {
    expect(variants).not.toHaveLength(0);
    expect(variants.map((v) => [v.id, v.responseMode, v.contentType])).toEqual(
      variants.map((v) => [v.id, 'download', type ?? v.contentType]),
    );
  });

  it('cusers.download records download and text/csv', () => {
    const action = actions.find((a) => a.id === 'ctl:cusers.download');
    expect(action?.viewPath).toBe(USERS_VIEW);
    expect(action?.variants.map((v) => [v.responseMode, v.contentType])).toEqual([['download', 'text/csv']]);
  });

  it('cusers.download takes its header and type only from the included inc/dsp_download.cfm', () => {
    const own = parseCfmTemplate(USERS_VIEW, tree.readText(USERS_VIEW));
    expect(own.functions[0]?.includes.map((i) => i.template)).toEqual(['inc/dsp_download.cfm']);
    expect(DISPOSITION.test(own.text)).toBe(false);
    expect(declaredType(own.text)).toBeUndefined();
    const text = expand(USERS_VIEW);
    expect(DISPOSITION.test(text)).toBe(true);
    expect(declaredType(text)).toBe('text/csv');
  });
});

describe('bare-body response modes against the pinned view and its includes', () => {
  it('finds a view that only prints one output block and aborts in exactly the known actions', () => {
    expect(bareViews.map((a) => a.id).sort()).toEqual([
      'ctl:carch.updateobjectparams',
      'ctl:cform.getdataset',
      'ctl:cform.getdialog',
      'ctl:cform.getfield',
      'ctl:cform.getfieldtemplate',
      'ctl:cform.getfieldtype',
      'ctl:cform.getform',
    ]);
  });

  it.each(bareViews)('$id records json for a declared JSON type, else a text/html fragment', ({ id, variants, type }) => {
    const mediaType = type?.split(';')[0]?.trim().toLowerCase();
    // The object-params save is an inline save, which the JSON handler serves with legacy's undeclared text/html.
    const [mode, contentType] =
      mediaType === 'application/json' ? ['json', mediaType] : id === INLINE_SAVE ? ['json', 'text/html'] : ['fragment', 'text/html'];
    expect(variants).not.toHaveLength(0);
    expect(variants.map((v) => [v.id, v.responseMode, v.layout, v.contentType])).toEqual(
      variants.map((v) => [v.id, mode, null, contentType]),
    );
  });
});

describe('cform.importform post-action mode against the pinned controller', () => {
  const action = actions.find((a) => a.id === 'ctl:cform.importform');

  it('records redirect without layout or content type', () => {
    expect(action?.variants.map((v) => [v.responseMode, v.layout, v.contentType])).toEqual([['redirect', null, null]]);
  });

  it('reads the multipart formzip file part and answers with location() in the recorded method', () => {
    const source = action?.source;
    expect(source?.path).toBe('admin/core/controllers/cform.cfc');
    const component = parseCfmlComponent(source?.path ?? '', tree.readText(source?.path ?? ''));
    const method = component?.functions.find((fn) => fn.name.toLowerCase() === action?.name.toLowerCase());
    expect(method && [method.startLine, method.endLine]).toEqual(source?.lines);
    expect(method?.body).toMatch(/\bfileUpload\s*\([^)]*["']formzip["']/i);
    expect(method?.body).toMatch(/\blocation\s*\(/i);
  });
});
