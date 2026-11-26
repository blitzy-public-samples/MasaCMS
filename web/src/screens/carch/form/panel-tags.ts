// Tags panel of the content editor (`admin/core/views/carch/form/dsp_panel_tags.cfm`), server-only.
import { encodeHtml, encodeHtmlAttr, raw } from '@/lib/html';
import { cfListToArray } from '@/lib/resource-bundles/properties';
import type { ScreenContext } from '../../registry';
import type { EditPageData, PanelResult } from './custom-tags';

/**
 * What the panel reads: labels, and of the edit model `rc.contentBean` (`tags`, `<group>tags`) and `rc.siteConfig`
 * (`customTagGroups`), each value as the bean's `getValue` returns it.
 */
export interface TagsPanelInput {
  readonly ctx: Pick<ScreenContext, 'rb'>;
  readonly data: EditPageData;
}

type Struct = Readonly<Record<string, unknown>>;

const NO_BREAK_SPACES: ReadonlySet<string> = new Set(['\u00A0', '\u2007', '\u202F']);

/** Java `Character.isWhitespace` of one UTF-16 unit. */
function isJavaWhitespace(ch: string): boolean {
  return /^[\t-\r\u001C-\u001F]$/.test(ch) || (/^[\p{Zs}\p{Zl}\p{Zp}]$/u.test(ch) && !NO_BREAK_SPACES.has(ch));
}

/** One ACF output buffer under whitespace management. */
class CfOut {
  #body = '';

  /** Template text holding a non-whitespace character, or an expression's value: written verbatim. */
  t(...parts: string[]): this {
    for (const part of parts) this.#body += part;
    return this;
  }

  /** A whitespace-only template run between two CFML constructs: one space after non-whitespace, else nothing. */
  ws(): this {
    if (this.#body !== '' && !isJavaWhitespace(this.#body.slice(-1))) this.#body += ' ';
    return this;
  }

  toString(): string {
    return this.#body;
  }
}

/** A struct value by case-insensitive key, as CFML reads it; undefined when absent. */
function fieldOf(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** `rc[key]` as a struct; throws as CFML does when it is undefined or not a struct. */
function rcStruct(rc: Struct, key: string): Struct {
  const value = fieldOf(rc, key);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Element ${key.toUpperCase()} is undefined in RC.`);
  }
  return value as Struct;
}

/** A bean's `getValue(key)` as CFML text: absent and SQL NULL read as `''`; complex values throw. */
function beanText(bean: Struct, key: string): string {
  const value = fieldOf(bean, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** ACF `trim`: Java `String.trim`, which strips code units up to U+0020 from both ends. */
function cfTrim(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start++;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(start, end);
}

const HEADING_OPEN =
  '\n<div class="mura-panel panel">\n\t<div class="mura-panel-heading" role="tab" id="heading-tags">\n\t\t<h4 class="mura-panel-title">\n\t\t\t<a class="collapse collapsed" role="button" data-toggle="collapse" data-parent="#content-panels" href="#panel-tags" aria-expanded="false" aria-controls="panel-tags">';

const DEFAULT_GROUP_OPEN =
  '</a>\n\t\t</h4>\n\t</div>\n\t<div id="panel-tags" class="panel-collapse collapse" role="tabpanel" aria-labelledby="heading-tags" aria-expanded="false" style="height: 0px;">\n\t\t<div class="mura-panel-body">\n\n\t\t\t\t<span id="extendset-container-tabtagstop" class="extendset-container"></span>\n\t\t   \t\t<div id="tags" class="mura-control justify tagSelector">\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t   \t<label>\n\t\t\t\t\t   \t\t';

const DEFAULT_INPUT = '\n\t\t\t\t\t   \t</label>\n\t\t  \t\t\t\t<input type="text" name="tags">\n\t\t  \t\t\t\t';

// The default selector's script, verbatim with its mixed indentation; `siteid` is the edit page's JavaScript variable.
const DEFAULT_SCRIPT =
  "\n\t\t\t\t\t</div> \n\t\t\t\t</div> \n\n\t\t\t\t<script>\n\t\t\t\t\t$(document).ready(function(){\n\t\t\t\t\t\t$.ajax({\n\t\t\t\t\t\t\turl: '?muraAction=carch.loadtagarray&siteid=' + siteid,\n\t\t\t\t\t\t\tdataType: 'text',\n\t\t\t\t\t\t\tsuccess:function(data){\n\t\t                        var tagArray=[];\n\t\t                        if(data){\n\t\t\t\t\t\t\t       tagArray=eval('(' + data + ')');\n\t\t                        }\n\t\t\t\t\t\t\t\t$('#tags').tagSelector(tagArray, 'tags');\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t});\n\t\t\t\t\t});\n\t\t\t\t</script>\n\n\n\t\t\t\t";

const TAIL =
  '\n\n\t\t\t\t<div class="mura-control-group extendedattributes-group" id="extendedattributes-container-tags">\n\t\t\t\t\t<div class="bigui" id="bigui__tags" data-label="Manage Extended Attributes">\n\t\t\t\t\t\t<div class="bigui__title">Manage Extended Attributes</div>\n\t\t\t\t\t\t<div class="bigui__controls">\n\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributestop"></span>\n\t\t\t\t\t\t\t<span id="extendset-container-tags" class="extendset-container extendedattributes-body" data-controlparent="extendedattributes-container-tags"></span>\n\t\t\t\t\t\t\t<span id="extendset-container-tabextendedattributesbottom"></span>\n\t\t\t\t\t\t</div>\n\t\t\t\t\t</div>\n\t\t\t\t\t\n\t\t\t\t</div>\n\n\t\t\t\t<span id="extendset-container-tabtagsbottom" class="extendset-container"></span>\n\t\t</div>\n\t</div>\n</div> \n';

/** The default selector's `cfif`/`cfloop` over `tags`: one removable tag and hidden input per list item. */
function defaultTags(o: CfOut, tags: string): void {
  if (tags.length === 0) return;
  o.ws();
  for (const tag of cfListToArray(tags)) {
    o.t('\n\t\t  \t\t\t\t\t\t<span class="tag">\n\t\t  \t\t\t\t\t\t\t', encodeHtml(tag));
    o.t(' <a><i class="mi-times-circle"></i></a>\n\t\t  \t\t\t\t\t\t  <input name="tags" type="hidden" value="');
    o.t(encodeHtmlAttr(tag), '">\n\t\t  \t\t\t\t\t\t</span>\n\t\t  \t\t\t\t\t');
  }
  o.ws();
}

/** One custom tag group's selector and script; the group name prints unencoded, as legacy prints it. */
function groupSelector(o: CfOut, group: string, label: string, tags: string): void {
  o.t('\n\t\t\t\t<div id="', group, 'tags" class="mura-control justify tagSelector">');
  o.t('\n\t\t\t\t\t<div class="mura-control-group">\n\t\t\t\t\t   \t<label>\n\t\t\t\t\t   \t\t', group);
  o.ws().t(label, '\n\t\t\t\t\t   \t</label>\n\t\t\t\t\t\t<input type="text" name="', group, 'tags">\n\t\t\t\t\t\t');
  if (tags.length > 0) {
    o.ws();
    for (const tag of cfListToArray(tags)) {
      o.t('\n\t\t\t\t\t\t\t\t<span class="tag">\n\t\t\t\t\t\t\t\t\t', encodeHtml(tag));
      o.t(' <a><i class="mi-times-circle"></i></a>\n\t\t\t\t\t\t\t\t    <input name="', group);
      o.t('tags" type="hidden" value="', encodeHtmlAttr(tag), '">\n\t\t\t\t\t\t\t\t</span>\n\t\t\t\t\t\t\t');
    }
    o.ws();
  }
  o.t('\n\t\t\t\t\t</div> \n\t\t\t\t</div> \n\t\t\t\t<script>\n\t\t\t\t\t$(document).ready(function(){');
  o.t("\n\t\t\t\t\t\t$.ajax({\n\t\t\t\t\t\t\turl:'?muraAction=carch.loadtagarray&siteid=' + siteid");
  o.t(" + '&taggroup=", group, "',\n\t\t\t\t\t\t\tdataType: 'text',\n\t\t\t\t\t\t\tsuccess: function(data){");
  o.t("\n\t\t\t\t\t\t\t\tvar tagArray=eval('(' + data + ')');");
  o.t("\n\t\t\t\t\t\t\t\t$('#", group, "tags').tagSelector(tagArray, '", group);
  o.t("tags');\n\t\t\t\t\t\t\t}\n\t\t\t\t\t\t});\n\t\t\t\t\t});\n\t\t\t\t</script>\n\t\t\t");
}

/**
 * The Tags panel include: the default tag selector, one selector per `customTagGroups` group (`^` or `,` separated,
 * trimmed) and the extended-attributes container, from the newline after `<cfoutput>` through `</div> \n`. Labels and
 * group names print unencoded and tags HTML-encoded, as legacy prints them.
 * @throws TypeError When `rc.contentBean` or `rc.siteConfig` is undefined, as the include fails in legacy.
 */
export function renderTagsPanel(input: TagsPanelInput): PanelResult {
  const { rb } = input.ctx;
  const content = rcStruct(input.data.rc, 'contentBean');
  const tabLabel = rb.rbKey('sitemanager.content.tabs.tags');
  const o = new CfOut();
  o.t(HEADING_OPEN, tabLabel, DEFAULT_GROUP_OPEN, rb.rbKey('sitemanager.content.fields.defaulttags'), DEFAULT_INPUT);
  defaultTags(o, beanText(content, 'tags'));
  o.t(DEFAULT_SCRIPT);
  const tagGroupList = beanText(rcStruct(input.data.rc, 'siteConfig'), 'customTagGroups');
  o.ws();
  if (tagGroupList.length > 0) {
    o.ws();
    const label = rb.rbKey('sitemanager.content.fields.tags');
    for (const item of cfListToArray(tagGroupList, '^,')) {
      o.ws();
      const group = cfTrim(item);
      groupSelector(o, group, label, beanText(content, `${group}tags`));
    }
    o.ws();
  }
  o.t(TAIL);
  return { html: raw(o.toString()), tabId: 'tabTags', tabLabel };
}
