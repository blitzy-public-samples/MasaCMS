// Type and subtype selector of the content edit form's Basic panel (`carch/form/dsp_type_selector.cfm`).
import { cfEq, cfListToArray } from '@opt2/platform/legacy-compat';
import { legacySettings } from '@/lib/env';
import { encodeJs, raw, type SafeHtml } from '@/lib/html';
// Not one of this view's planned inputs: reused so the selector prints the theme path partials/js.ts prints on the
// same edit page, rather than deriving `getThemeAssetPath()` a second way.
import { siteBeanOf, sitePaths } from '@/lib/site-paths';
import { isSuperOrAdminUser, structOf, structText } from '../model';
import { cfListHas, type EditFormInput, type EditFormState, type SubTypeRow } from './custom-tags';

/** What the selector reads of an edit panel's input; an {@link EditFormInput} satisfies it. */
export interface TypeSelectorInput {
  readonly ctx: Pick<EditFormInput['ctx'], 'rb'>;
  readonly req: EditFormInput['req'];
  readonly data: EditFormInput['data'];
  readonly state: Pick<EditFormState, 'pageLevelList' | 'baseTypeList' | 'subTypes' | 'subtypeFilter'>;
}

// The markup is the include as ACF 2023 emits it after the panel's indentation: whitespace-only text between CFML tags
// prints one space after non-whitespace output and nothing otherwise, and all other text is kept byte for byte. So
// each Link, Component and Form subtype option is followed by one space and nothing else. Ids, types, subtypes and
// labels print unencoded, as legacy prints them.

/** The theme Masa start-up installs as `<webroot>/themes/default`, which the installed site uses. */
const INSTALLED_THEME = 'default';

/** `settingsManager.getSite(rc.siteID).getThemeAssetPath()` for the session site, which carch keeps as `rc.siteID`. */
function themeAssetPath(req: TypeSelectorInput['req']): string {
  if (req.site === undefined) return `${legacySettings().context}/themes/${INSTALLED_THEME}`;
  return sitePaths(req, siteBeanOf(req.site)).themeAssetPath('webRoot', false);
}

/** The values every branch reads, as edit.cfm leaves them before the include. */
interface Selector {
  readonly rcType: string;
  readonly siteId: string;
  /** `rc.contentBean.getType()`. */
  readonly type: string;
  /** `rc.contentBean.getSubType()`. */
  readonly subType: string;
  readonly subTypes: readonly SubTypeRow[];
  readonly subtypeFilter: string;
  readonly rbKey: (key: string) => string;
  /** The `typeSelector` onchange script with `siteId` printed as the branch prints it. */
  readonly onchange: (siteId: string) => string;
}

/** `rsst`: the rows of `type` other than `Default`, matched case-sensitively as the query of queries matches. */
function subTypesOf(rows: readonly SubTypeRow[], type: string): SubTypeRow[] {
  return rows.filter((row) => row.type === type && row.subtype !== 'Default' && row.subtype !== 'default');
}

/** `not len(subtypefilter) or listFindNoCase(subtypefilter, entry)`. */
function allows(s: Selector, entry: string): boolean {
  return s.subtypeFilter.length === 0 || cfListHas(s.subtypeFilter, entry, { noCase: true });
}

/** One `<option>` of `t^sub`, `selected` when it is `rc.type` and the content's subtype. */
function option(s: Selector, t: string, sub: string, label: string): string {
  const selected = cfEq(s.rcType, t) && cfEq(s.subType, sub) ? 'selected' : '';
  return `<option value="${t}^${sub}" ${selected}>${label}</option>`;
}

/** `sitemanager.content.type.<suffix>`. */
const typeLabel = (s: Selector, suffix: string): string => s.rbKey(`sitemanager.content.type.${suffix}`);

/** The page-level branch: every type of `baseTypeList` with its subtypes, the site id JavaScript-encoded. */
function pageLevelSelector(s: Selector, baseTypeList: string, isAdmin: boolean): string {
  let out = `\n\t\t<div class="mura-control-group">\n\t\t\t<label>\n\t\t\t\t${s.rbKey('sitemanager.content.type')}\n\t\t\t</label>\n\t\t\t\t<select name="typeSelector" onchange="${s.onchange(encodeJs(s.siteId))}">\n\t\t\t\t`;
  for (const t of cfListToArray(baseTypeList)) {
    // Admin-only subtypes are offered to other users only when the content already has that subtype.
    const rsst = subTypesOf(s.subTypes, t).filter(
      (row) => isAdmin || row.adminonly !== 1 || (row.type === s.type && row.subtype === s.subType),
    );
    const label = typeLabel(s, t.toLowerCase());
    if (allows(s, `${t}/Default`)) out += `\n\t\t\t\t\t${option(s, t, 'Default', label)}\n\t\t\t\t`;
    for (const row of rsst) {
      if (allows(s, `${t}/${row.subtype}`)) {
        out += `\n\t\t\t\t\t\t\t\t${option(s, t, row.subtype, `${label}  / ${row.subtype}`)}\n\t\t\t\t\t\t\t`;
      }
    }
  }
  return `${out}\n\t\t\t</select>\n\t\t\t</div>\n\t`;
}

/** The File branch: nothing without File subtypes; its Default label key keeps the type's case. */
function fileSelector(s: Selector): string {
  const t = 'File';
  const rsst = subTypesOf(s.subTypes, t);
  if (rsst.length === 0) return '';
  let out = `\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<label>\n\t\t\t\t\t${s.rbKey('sitemanager.content.type')}\n\t\t\t\t</label>\n\t\t\t\t\t<select name="typeSelector" onchange="${s.onchange(s.siteId)}">\n\t\t\t\t\t\t`;
  if (allows(s, `${t}/Default`)) out += `\n\t\t\t\t\t\t\t${option(s, t, 'Default', typeLabel(s, t))}\n\t\t\t\t\t\t`;
  const label = typeLabel(s, t.toLowerCase());
  for (const row of rsst) {
    if (allows(s, `${t}/${row.subtype}`)) {
      out += `\n\t\t\t\t\t\t\t\t\t${option(s, t, row.subtype, `${label} / ${row.subtype}`)}\n\t\t\t\t\t\t\t\t`;
    }
  }
  return `${out}\n\t\t\t\t</select>\n\t\t\t\t</div>\n\t\t`;
}

/** The Link branch (`filtered`: the parent's subtype filter applies) and the Component or Form branch of type `t`. */
function compactSelector(s: Selector, t: string, filtered: boolean): string {
  const rsst = subTypesOf(s.subTypes, t);
  if (rsst.length === 0) return '';
  const label = typeLabel(s, t.toLowerCase());
  let out = `\n\t\t\t<div class="mura-control-group">\n\t\t\t\t<label>${s.rbKey('sitemanager.content.type')}</label>\n\t\t\t\t<select name="typeSelector"  onchange="${s.onchange(s.siteId)}">\n\t\t\t\t\t`;
  if (!filtered) out += `${option(s, t, 'Default', label)}\n\t\t\t\t\t`;
  else if (allows(s, `${t}/Default`)) out += `\n\t\t\t\t\t\t${option(s, t, 'Default', label)}\n\t\t\t\t\t`;
  for (const row of rsst) {
    if ((!filtered || allows(s, `${t}/${row.subtype}`)) && !cfEq(row.subtype, 'Default')) {
      out += `${option(s, t, row.subtype, `${label}  / ${row.subtype}`)} `;
    }
  }
  return `${out}\n\t\t\t\t</select>\n\t\t\t</div>\n\t\t`;
}

/** The include's output for `rc.type`; empty for types it has no branch for and for non-page types without subtypes. */
export function renderTypeSelector(input: TypeSelectorInput): SafeHtml {
  const { ctx, req, data, state } = input;
  const bean = structOf(data.rc, 'contentBean');
  const rcType = req.rc.type ?? '';
  const ids = `'${structText(bean, 'contentID')}','${structText(bean, 'contentHistID')}'`;
  const call = `siteManager.resetExtendedAttributes(${ids},this.value,'`;
  const s: Selector = {
    rcType,
    siteId: req.rc.siteid ?? '',
    type: structText(bean, 'type'),
    subType: structText(bean, 'subType'),
    subTypes: state.subTypes,
    subtypeFilter: state.subtypeFilter,
    rbKey: (key) => ctx.rb.rbKey(key),
    onchange: (siteId) => `${call}${siteId}','${legacySettings().context}','${themeAssetPath(req)}');`,
  };
  if (cfListHas(state.pageLevelList, rcType, { noCase: true })) {
    return raw(pageLevelSelector(s, state.baseTypeList, isSuperOrAdminUser(req)));
  }
  if (cfEq(rcType, 'File')) return raw(fileSelector(s));
  if (cfEq(rcType, 'Link')) return raw(compactSelector(s, 'Link', true));
  if (cfListHas('Component,Form', rcType, { noCase: true })) return raw(compactSelector(s, rcType, false));
  return raw('');
}
