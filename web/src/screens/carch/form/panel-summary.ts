// The content editor's Summary panel (`admin/core/views/carch/form/dsp_panel_summary.cfm`), server-only.
import { cfEq, cfToBoolean, cfToNumber, javaTrim } from '@opt2/platform/legacy-compat';
import { formatDateTimeShort } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw } from '@/lib/html';
import type { ScreenContext } from '../../registry';
import { CONTENT_MODULE_ID, ROOT_CONTENT_ID, structOf, structText, structValue, type CarchStruct } from '../model';
import { cfListHas, type EditFormInput, type EditFormState, type PanelResult } from './custom-tags';

// The markup is written as ACF 2023 emits the include: template text between two CFML constructs is copied byte for
// byte, CFML comments are dropped with the text around them joined, and text that is only whitespace prints one space
// after output that does not already end in whitespace, else nothing (`ViewOutput.t`).

/** contentManager `TreeLevelList`. */
const TREE_LEVEL_LIST = 'Page,Folder,Calendar,Link,File,Gallery';

const TEMPLATE_WHITESPACE = /^[ \t\r\n]+$/;

/** One include's output under ACF whitespace management. */
class ViewOutput {
  #out = '';

  /** Template text between two CFML constructs; whitespace-only text prints one space after non-whitespace, else nothing. */
  t(text: string): this {
    if (!TEMPLATE_WHITESPACE.test(text)) this.#out += text;
    else if (this.#out !== '' && this.#out.charCodeAt(this.#out.length - 1) > 0x20) this.#out += ' ';
    return this;
  }

  /** The output of a `#…#` expression. */
  e(value: string): this {
    this.#out += value;
    return this;
  }

  toString(): string {
    return this.#out;
  }
}

// ACF isValid('URL'), as strategies-content observed it: trimmed; http, https, ftp or file with an RFC 2396 server
// authority, or an opaque news: URI; path characters as java.net.URI accepts them.
const URI_CHAR = String.raw`(?:[\w\-.!~*'();/?:@&=+$,]|%[0-9A-Fa-f]{2}|[^\x00-\x9F\s])`;
const URI_USERINFO = String.raw`(?:(?:[\w\-.!~*'();:&=+$,]|%[0-9A-Fa-f]{2}|[^\x00-\x9F\s])*@)?`;
const URI_HOST = String.raw`(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z](?:[a-z0-9-]*[a-z0-9])?\.?|\d{1,3}(?:\.\d{1,3}){3})`;
const CF_URL = new RegExp(
  String.raw`^(?:(?:https?|ftp|file)://${URI_USERINFO}${URI_HOST}(?::\d*)?(?:[/?]${URI_CHAR}*)?(?:#${URI_CHAR}*)?` +
    String.raw`|news:(?!/)${URI_CHAR}+(?:#${URI_CHAR}*)?)$`,
  'i',
);

/** ACF `isValid('URL', s)`. */
const isCfUrl = (s: string): boolean => CF_URL.test(javaTrim(s));

const STAR_STEPS: ReadonlyArray<readonly [below: number, text: string]> = [
  [1, 'half'],
  [1.5, 'one'],
  [2, 'onehalf'],
  [2.5, 'two'],
  [3, 'twohalf'],
  [3.5, 'three'],
  [4, 'threehalf'],
  [4.5, 'four'],
  [5, 'fourhalf'],
];

/** raterManager `getStarText`: the rater image name of an average; an empty average compares as text, below 0. */
function starText(avg: string): string {
  if (avg === '') return 'zero';
  const value = cfToNumber(avg);
  if (value <= 0) return 'zero';
  return STAR_STEPS.find(([below]) => value < below)?.[1] ?? 'five';
}

/** The {@link EditFormInput} members the panel reads; an `EditFormInput` satisfies it. */
export type PanelSummaryInput = Pick<EditFormInput, 'req' | 'data' | 'state'> & {
  readonly ctx: Pick<ScreenContext, 'rb'>;
};

/** The values the include reads. */
interface SummaryView {
  readonly rb: (key: string) => string;
  readonly state: EditFormState;
  /** The edit model's `rc`. */
  readonly model: CarchStruct;
  /** `rc.contentBean`. */
  readonly bean: CarchStruct;
  readonly isNew: boolean;
  /** Request `rc.type`. */
  readonly type: string;
  /** Request `rc.contentID`. */
  readonly rcContentId: string;
  /** Request `rc.moduleid`. */
  readonly moduleId: string;
  readonly dateKeyFormat: string;
  readonly locale: string;
}

/** Request `rc[name]` after the carch defaults; throws as CFML does for an undefined element. */
function rcText(input: PanelSummaryInput, name: string): string {
  const value = input.req.rc[name];
  if (value === undefined) throw new TypeError(`Element ${name.toUpperCase()} is undefined in RC.`);
  return value;
}

/** A bean value as a CFML number, booleans counting as 1 and 0. */
function beanNumber(bean: CarchStruct, key: string): number {
  const value = structValue(bean, key);
  return typeof value === 'boolean' ? Number(value) : cfToNumber(value);
}

/** `raterManager.getAvgRating` as strategies-content returns it in `rc.rsRating`; absent or null has no rows. */
function ratingRows(model: CarchStruct): readonly CarchStruct[] {
  const rows = structValue(model, 'rsRating');
  if (rows === undefined || rows === null) return [];
  if (!Array.isArray(rows)) throw new TypeError('rsRating is not a query');
  return rows as readonly CarchStruct[];
}

/** The vote count and average stars of a rated tree node, then the version of a versioned file (not new only). */
function storedMetadata(o: ViewOutput, v: SummaryView): void {
  o.t('\n\t\t\t\t\t');
  if (cfListHas(TREE_LEVEL_LIST, v.type, { noCase: true })) {
    o.t('\n\t\t\t\t\t\t').t('\n\t\t\t\t\t\t');
    const [rating] = ratingRows(v.model);
    if (rating !== undefined) {
      const avg = structText(rating, 'theAvg');
      o.t('\n\t\t\t\t\t\t\t<span class="meta-label">').e(v.rb('sitemanager.content.votes')).t(': <span>');
      o.e(structText(rating, 'theCount')).t('</span></span>\n\t\t\t\t\t\t\t<span class="meta-label">');
      o.e(v.rb('sitemanager.content.averagerating')).t(': <img id="ratestars" src="assets/images/rater/star_');
      o.e(starText(avg)).t('.gif" alt="').e(avg).t(' stars" border="0"></span>\n\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t');
  if (cfEq(v.type, 'file') && cfToBoolean(structValue(v.bean, 'majorVersion'))) {
    o.t('\n\t\t\t\t\t\t\t<span class="meta-label">').e(v.rb('sitemanager.content.version.file')).t(': <span>');
    o.e(structText(v.bean, 'majorVersion')).t('.').e(structText(v.bean, 'minorVersion'));
    o.t('</span></span>\n\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t');
}

/** The `viewStatusInfo` link up to its label, after `lead`. */
function statusLink(o: ViewOutput, v: SummaryView, lead: string, label: string): void {
  o.t(`${lead}<a href="#" onclick="return viewStatusInfo('`).e(encodeJs(structText(v.bean, 'contentHistID')));
  o.t("','").e(encodeJs(structText(v.bean, 'siteID'))).t(`');">`).e(label);
}

/** The status label: published, the approval status, queued, draft or archived. */
function status(o: ViewOutput, v: SummaryView): void {
  if (v.isNew) {
    o.t('\n\t\t\t\t\t\t\t\t').e(v.rb('sitemanager.content.draft')).t('\n\t\t\t\t\t\t\t');
    return;
  }
  const approvalStatus = structText(v.bean, 'approvalStatus');
  o.t('\n\t\t\t\t\t\t\t\t');
  if (beanNumber(v.bean, 'active') > 0 && beanNumber(v.bean, 'approved') > 0) {
    o.t('\n\t\t\t\t\t\t\t\t\t');
    if (approvalStatus.length > 0) {
      statusLink(o, v, '\n\t\t\t\t\t\t\t\t\t\t', v.rb('sitemanager.content.published'));
      o.t('</a>\n\t\t\t\t\t\t\t\t\t');
    } else {
      o.t('\n\t\t\t\t\t\t\t\t\t\t').e(v.rb('sitemanager.content.published')).t('\n\t\t\t\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t\t\t');
  } else if (approvalStatus.length > 0 && (v.state.requiresApproval || v.state.showApprovalStatus)) {
    statusLink(o, v, '\n\t\t\t\t\t\t\t\t\t', v.rb(`sitemanager.content.${approvalStatus}`));
    o.t('</a>\n\t\t\t\t\t\t\t\t');
  } else if (beanNumber(v.bean, 'approved') < 1) {
    const queued = structText(v.bean, 'changesetID').length > 0;
    o.t('\n\t\t\t\t\t\t\t\t\t').t('\n\t\t\t\t\t\t\t\t\t\t');
    o.e(v.rb(queued ? 'sitemanager.content.queued' : 'sitemanager.content.draft')).t('\n\t\t\t\t\t\t\t\t\t');
    o.t('\n\t\t\t\t\t\t\t\t');
  } else {
    o.t('\n\t\t\t\t\t\t\t\t\t').e(v.rb('sitemanager.content.archived')).t('\n\t\t\t\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t\t\t');
}

/** `<span class="clicktocopy">` of `value` for a stored node opened by id, else the not-available label. */
function copyable(o: ViewOutput, v: SummaryView, value: string): void {
  if (v.rcContentId.length > 0 && structText(v.bean, 'contentID').length > 0) {
    o.t('<span class="clicktocopy">').e(value).t('</span>');
  } else {
    o.e(v.rb('sitemanager.content.fields.notavailable'));
  }
}

/** The `#mura-content-metadata` block: ratings, file version, update time, status, filename and content id. */
function metadata(o: ViewOutput, v: SummaryView): void {
  if (!v.isNew) storedMetadata(o, v);
  const updated = formatDateTimeShort(structText(v.bean, 'lastUpdate'), v.dateKeyFormat, v.locale);
  o.t('\n\t\t\t\t\t<span class="meta-label">').e(v.rb('sitemanager.content.update')).t(': <span>').e(updated);
  o.t('</span></span>\n\t\t\t\t\t<span class="meta-label">').e(v.rb('sitemanager.content.status'));
  o.t(':\n\t\t\t\t\t\t<span>\n\t\t\t\t\t\t\t');
  status(o, v);
  o.t('\n\t\t\t\t\t\t</span>\n\t\t\t\t\t</span>\n\n\t\t\t\t\t');
  if (cfListHas('Gallery,Link,Folder,Page,Calendar', v.type)) {
    o.t('\n\t\t\t\t\t\t<span class="meta-label">\n\t\t\t\t      \t');
    o.e(v.rb('sitemanager.content.fields.currentfilename')).t(': \n\t\t\t\t\t\t');
    if (cfEq(structText(v.bean, 'contentID'), ROOT_CONTENT_ID)) {
      o.e(v.rb('sitemanager.content.fields.emptystring'));
    } else {
      copyable(o, v, structText(v.bean, 'filename'));
    }
    o.t('\n\t\t\t\t\t\t</span>\n\t\t\t\t\t');
  }
  o.t('\n\t\t\t\t\t<span class="meta-label meta-label-wide">\n\t\t\t\t      ');
  o.e(v.rb('sitemanager.content.fields.contentid')).t(': \n\t\t\t\t      ');
  copyable(o, v, structText(v.bean, 'contentID'));
  o.t('\n\t\t\t\t    </span>\n\n\t\t\t\t\t<div class="clearfix"></div>\n\t\t  \t\t</div> \n\n\t\t\t\t\n\t\t\t\t');
}

const SUMMARY_SCRIPT =
  '\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t<script>\n' +
  '\t\t\t\t\t\thideSummaryEditor=function(){\n' +
  "\t\t\t\t\t\t\tif(typeof CKEDITOR.instances.summary != 'undefined'){\n" +
  '\t\t\t\t\t\t\t\tCKEDITOR.instances.summary.updateElement();\n' +
  '\t\t\t\t\t\t\t\tCKEDITOR.instances.summary.destroy();\n' +
  '\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\tjQuery(".summaryContainer").hide();\n' +
  '\t\t\t\t\t\t\tsummaryLoaded=true;\n' +
  '\t\t\t\t\t\t}\n\n' +
  '\t\t\t\t\t\tshowSummaryEditor=function(){\n' +
  "\t\t\t\t\t\t\tif(typeof CKEDITOR.instances.summary == 'undefined'){\n" +
  '\t\t\t\t\t\t\t\tjQuery(".summaryContainer").show();\n' +
  "\t\t\t\t\t\t\t\tjQuery('#summary').ckeditor(\n" +
  "\t\t\t\t\t     \t\t{ toolbar:'Summary',\n" +
  "\t\t\t\t\t     \t\t\theight:'150',\n" +
  "\t\t\t\t\t     \t\t  \tcustomConfig : 'config.js.cfm'\n" +
  '\t\t\t\t\t\t\t\t},\n' +
  '\t\t\t\t\t\t\t\tfunction(editorInstance){\n' +
  '\t\t\t\t\t\t\t\t\thtmlEditorOnComplete(editorInstance);\n' +
  '\t\t\t\t\t\t\t\t\tif (!hasBody){\n' +
  '\t\t\t\t\t\t\t\t\t\tshowPreview();\n' +
  '\t\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t     \t);\n' +
  '\t\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t}\n' +
  '\t\t\t\t\t\t';

/** The summary editor and its CKEditor script, for every type but Form and Component. */
function summaryField(o: ViewOutput, v: SummaryView, summaryLabel: string): void {
  if (cfListHas('Form,Component', v.type, { noCase: true })) return;
  const summary = structText(v.bean, 'summary');
  o.t('\n\t\t\t\t\t<div class="mura-control-group summaryContainer" style="display:none;">\n\t\t\t\t      \t<label>');
  o.t('\n\t\t\t\t\t    \t<span data-toggle="popover" title="" data-placement="right"\n\t\t\t\t\t    \tdata-content="');
  o.e(encodeHtmlAttr(v.rb('tooltip.contentSummary'))).t('"\n\t\t\t\t\t    \tdata-original-title="');
  o.e(encodeHtmlAttr(summaryLabel)).t('">\n\t\t\t\t\t    \t\t').e(summaryLabel);
  o.t(' <i class="mi-question-circle"></i></span>\n\t\t\t      \t\t</label>');
  o.t('\n\t\t\t\t      \t<div id="editSummary" class="summaryContainer" style="display:none;">\n\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t\t\t<textarea name="summary" id="summary" cols="96" rows="10">');
  if (!cfEq(legacySettings().htmlEditorType, 'none') || summary.length > 0) {
    o.e(encodeHtml(summary));
  } else {
    o.t('<p></p>');
  }
  o.t('</textarea>\n\t\t\t\t\t\t').t(SUMMARY_SCRIPT);
  if (!v.state.isExtended) o.t('\n\t\t\t\t\t\tshowSummaryEditor();\n\t\t\t\t\t\t');
  o.t('\n\t\t\t\t\t</script>\n\t\t\t\t');
}

/** Credits and, where the SEO tab applies, meta description, meta keywords and canonical URL. */
function pageFields(o: ViewOutput, v: SummaryView): void {
  if (!cfListHas('Page,Folder,Calendar,Gallery,File,Link', v.type, { noCase: true })) return;
  o.t('\n\t\t\t\t\t\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t  <label>');
  o.e(v.rb('sitemanager.content.fields.credits'));
  o.t('</label>\n\t\t\t\t\t  <input type="text" id="credits" name="credits" value="');
  o.e(encodeHtmlAttr(structText(v.bean, 'credits'))).t('"  maxlength="255">\n\t\t\t\t\t</div>\n\n\t\t\t\t\t\n\t\t\t\t\t');
  const { tabAssignments } = v.state;
  // CFML `and` binds tighter than `or`: the SEO tab assignment alone also shows the fields.
  const seo =
    (cfEq(v.moduleId, CONTENT_MODULE_ID) && tabAssignments.length === 0) ||
    cfListHas(tabAssignments, 'SEO', { noCase: true });
  if (seo) {
    // contentBean keeps the canonical URL in `metakeywords`: getCanonicalURL() returns it when it is a URL and
    // getMetaKeywords() when it is not.
    const stored = structText(v.bean, 'metaKeywords');
    const isUrl = isCfUrl(stored);
    o.t('\n\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t<label>');
    o.e(v.rb('sitemanager.content.fields.description'));
    o.t('</label>\n\t\t\t\t\t\t\t<textarea name="metadesc" id="metadesc">').e(encodeHtml(structText(v.bean, 'metaDesc')));
    o.t('</textarea>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t\t');
    if (legacySettings().keepMetaKeywords) {
      o.t('\n\t\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t\t<label>');
      o.e(v.rb('sitemanager.content.fields.keywords'));
      o.t('</label>\n\t\t\t\t\t\t\t\t<textarea name="metakeywords" rows="3" id="metakeywords">');
      o.e(encodeHtml(isUrl ? '' : stored)).t('</textarea>\n\t\t\t\t\t\t\t</div>\n\t\t\t\t\t\t');
    }
    o.t('\n\t\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t\t\t<label>Canonical URL</label>');
    o.t('\n\t\t\t\t\t\t\t<input type="text" id="canonicalURL" name="canonicalURL" value="');
    o.e(encodeHtmlAttr(isUrl ? stored : '')).t('"  maxlength="255">\n\t\t\t\t\t\t</div>\n\t\t\t\t\t');
  }
  o.t('\n\n\t\t\t\t');
}

const PANEL_HEADING =
  '\n<div class="mura-panel panel">\n\t<div class="mura-panel-heading" role="tab" id="heading-summary">\n' +
  '\t\t<h4 class="mura-panel-title">\n' +
  '\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" ' +
  'href="#panel-summary" aria-expanded="true" aria-controls="panel-summary">';

const PANEL_BODY_START =
  '</a>\n\t\t</h4>\n\t</div>\n' +
  '\t<div id="panel-summary" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-summary" ' +
  'aria-expanded="false" style="height: 0px;">\n' +
  '\t\t<div class="mura-panel-body">\n\n\n' +
  '\t\t\t<span id="extendset-container-tabsummarytop" class="extendset-container"></span>\n\n\t\t\t\n' +
  '\t\t\t<div class="help-block" id="mura-content-metadata">\n\t\t\t\t';

const PANEL_END =
  '</textarea>\n\t\t\t\t</div> \n\n\n' +
  '\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-summary">\n' +
  '\t\t\t\t\t<div class="bigui" id="bigui__summary" data-label="Manage Extended Attributes">\n' +
  '\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>\n' +
  '\t\t\t\t\t\t<div class="bigui__controls">\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-summary" class="extendset-container extendedattributes-body" ' +
  'data-controlparent="extendedattributes-container-summary"></span>\n' +
  '\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>\n' +
  '\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t\n\t\t\t\t</div>\n' +
  '\t\t\t<span id="extendset-container-tabsummarybottom" class="extendset-container"></span>\n' +
  '\t\t</div>\n\t</div>\n</div> \n\n\n\n';

/**
 * `form/dsp_panel_summary.cfm`: the Summary panel from the newline after its `<cfoutput>` through the blank lines
 * before `</cfoutput>`, appending `tabSummary`.
 */
export function renderPanelSummary(input: PanelSummaryInput): PanelResult {
  const { ctx, req, data, state } = input;
  const bean = structOf(data.rc, 'contentBean');
  const v: SummaryView = {
    rb: (key) => ctx.rb.rbKey(key),
    state,
    model: data.rc,
    bean,
    isNew: cfToBoolean(structValue(bean, 'isNew')),
    type: rcText(input, 'type'),
    rcContentId: rcText(input, 'contentID'),
    moduleId: rcText(input, 'moduleid'),
    dateKeyFormat: req.session.dateKeyFormat,
    locale: req.session.locale,
  };
  const summaryLabel = v.rb('sitemanager.content.fields.summary');
  const o = new ViewOutput();
  o.t(PANEL_HEADING).e(summaryLabel).t(PANEL_BODY_START);
  metadata(o, v);
  summaryField(o, v, summaryLabel);
  o.t('\n\t\t\t\t\n\n\t\t\t\t');
  pageFields(o, v);
  o.t('\n\n\t\t\t\t\n\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t<label>\n\t\t\t\t\t\t\n\t\t\t\t\t\t');
  o.e(v.rb('sitemanager.content.fields.addnotes'));
  o.t('\n\t\t\t\t\t</label>\n\t\t\t\t\t<textarea name="notes" rows="3" id="abstract">');
  o.e(encodeHtml(structText(bean, 'notes'))).t(PANEL_END);
  return { html: raw(o.toString()), tabId: 'tabSummary', tabLabel: summaryLabel };
}
