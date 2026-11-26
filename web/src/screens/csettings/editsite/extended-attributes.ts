// Extended Attributes tab of `csettings/editsite.cfm` with the `extendAttribute.renderAttribute` controls it prints.
// Whitespace between tags is what ACF whitespace management leaves, as captured from the legacy server.
import { cfHour, cfIsDateText, cfLsIsDate, cfMinute, cfTimestampParam } from '@opt2/platform/legacy-compat';
import { isMoreThanFiftyYearsAfter, lsDateFormatString } from '@/lib/dates';
import { legacySettings } from '@/lib/env';
import { encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import { cfEq, cfListFind, type EditSiteModel, type ExtendAttributeView, type ExtendSetView } from './model';

const USE_MURA_DEFAULT = 'useMuraDefault';
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg']);
const NOTHING = raw('');

const HTML_EDIT_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '"': '&quot;',
  '<': '&lt;',
  '>': '&gt;',
  '\r': '',
};
const XML_ENTITIES: Readonly<Record<string, string>> = { ...HTML_EDIT_ENTITIES, "'": '&apos;' };

// renderAttribute uses ACF's own encoders, which differ from ESAPI: spaces, `/` and non-ASCII stay literal.
/** ACF 2023 `HTMLEditFormat`: `& " < >` as entities, CR dropped. */
function htmlEditFormat(s: string): string {
  return s.replace(/[&"<>\r]/g, (c) => HTML_EDIT_ENTITIES[c] ?? c);
}

/** ACF 2023 `XMLFormat`: `& " ' < >` as entities, CR dropped, U+00A0-U+00FF as `&#xhh;`. */
function xmlFormat(s: string): string {
  return s.replace(/[&"'<>\r\u00a0-\u00ff]/g, (c) => XML_ENTITIES[c] ?? `&#x${c.charCodeAt(0).toString(16)};`);
}

/** A newline followed by `depth` tabs. */
function nl(depth: number): SafeHtml {
  return raw(`\n${'\t'.repeat(depth)}`);
}

/** CFML `listToArray(list, '^')`: empty elements dropped. */
function caretList(list: string): string[] {
  return list.split('^').filter((item) => item !== '');
}

/** `LSDateFormat(value, session.dateKeyFormat)` under the session locale: '' when blank; throws as ACF fails when unreadable. */
function lsDateFormat(value: string, m: EditSiteModel): string {
  return lsDateFormatString(value, m.dateKeyFormat, m.locale);
}

/** ` data-message="…"` when the attribute has a message. */
function messageAttr(message: string): SafeHtml {
  return message === '' ? NOTHING : html` data-message="${raw(xmlFormat(message))}"`;
}

/** ` data-validate="…"` when set, then ` data-regex="…"` for Regex validation, both unencoded. */
function validationAttrs(attr: ExtendAttributeView): SafeHtml {
  const validate = attr.validation === '' ? NOTHING : html` data-validate="${raw(attr.validation)}"`;
  const regex = cfEq(attr.validation, 'Regex') ? html` data-regex="${raw(attr.regex)}"` : NOTHING;
  return html`${validate}${regex}`;
}

/** `listGetAt(optionLabelList, position + 1, '^')`, failing as ACF does past the end of the label list. */
function optionLabel(labels: readonly string[], position: number): string {
  const label = labels[position];
  if (label === undefined) {
    throw new RangeError(`Invalid list index ${position + 1}: the option label list has ${labels.length} elements.`);
  }
  return label;
}

/** The option text, unencoded: its same-position label when the label list is non-empty, else the option value. */
function optionText(attr: ExtendAttributeView, labels: readonly string[], option: string, position: number): SafeHtml {
  return raw(attr.optionLabelList === '' ? option : optionLabel(labels, position));
}

/** `<option>`s `from`..`to` as cf_timeselector loops them, `selected` on `chosen`. */
function timeOptions(from: number, to: number, chosen: number, text: (n: number) => string): string {
  let out = '';
  for (let n = from; n <= to; n += 1) {
    out += `<option value="${n}" ${n === chosen ? 'selected' : ''}>${text(n)}</option>`;
  }
  return out;
}

/** `cf_timeselector` as `cf_datetimeselector` calls it: empty select names, ids and classes from the field name. */
function renderTimeSelects(name: string, time: string, m: EditSiteModel): string {
  // hour() and minute() of a value lsIsDate or isDate reads, which throw as ACF's do when its cast fails; else 0 and 0.
  const parsed = cfLsIsDate(time, m.locale) || cfIsDateText(time) ? cfTimestampParam(time) : null;
  const hour = parsed ? cfHour(parsed) : 0;
  const minute = parsed ? cfMinute(parsed) : 0;
  const { localeHasDayParts } = m;
  const field = encodeHtmlAttr(name);
  const attrs = `class="time mura-datepicker${field}" name=""`;
  const twoDigits = (n: number): string => String(n).padStart(2, '0');
  const minutes = `<select id="mura-${field}Minute" ${attrs}>${timeOptions(0, 59, minute, twoDigits)}</select>`;
  if (!localeHasDayParts) {
    const hours = `<select  id="mura-${field}Hour" ${attrs}>${timeOptions(0, 23, hour, String)}</select>`;
    return `\n\t\t${hours}\n\t\n\n\t${minutes}\n\n\t\n`;
  }
  const clockHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const hours = `<select id="mura-${field}Hour" ${attrs}>${timeOptions(1, 12, clockHour, String)}</select>`;
  const pm = hour >= 12 ? 'selected' : '';
  const dayPart = `<select id="mura-${field}DayPart" ${attrs}><option value="AM">AM</option><option value="PM" ${pm}>PM</option></select>`;
  return `\n\t\t${hours}\n\t\n\n\t${minutes}\n\n\t\n\t\t${dayPart}\n\t\n`;
}

/** `cf_datetimeselector name datetime required message`: date field, time selects, hidden value and change script. */
function renderDatetimeSelector(
  name: string,
  datetime: string,
  required: string,
  message: string,
  m: EditSiteModel,
): SafeHtml {
  // `isDate(datetime) and dateDiff('yyyy', now(), datetime) gt 50` clears the value; the time selects keep the original.
  const kept = cfIsDateText(datetime) && isMoreThanFiftyYearsAfter(cfTimestampParam(datetime), m.now) ? '' : datetime;
  const field = encodeHtmlAttr(name);
  const script = encodeJs(name);
  const dateText = lsDateFormat(kept, m);
  // The tag's empty `dateclass` leaves one space, not two, in the legacy output.
  return raw(
    [
      `\n<input type="text" autocomplete="off" class="datepicker span3 mura-datepicker${field}" value="${dateText}"`,
      ` maxlength="12" id="mura-datepicker-${field}"/> `,
      renderTimeSelects(name, datetime, m),
      `<input type="hidden" id="mura-${field}" name="${field}" value="${encodeHtmlAttr(kept)}"`,
      ` data-required="${encodeHtmlAttr(required)}" data-required="${encodeHtmlAttr(message)}"/>\n`,
      `<script>\n\t$(function(){\n\t\t$('.mura-datepicker${script}').change(\n\t\t\tfunction(){\n`,
      `\t\t\t\tparseDateTimeSelector('${script}');\n\t\t\t}\n\t\t);\n\t});\n</script>\n`,
    ].join(''),
  );
}

/** TextBox/Text without datetime validation: a color picker, or a text input that is a date field for date validation. */
function renderTextInput(attr: ExtendAttributeView, value: string, m: EditSiteModel): SafeHtml {
  const isDate = cfEq(attr.validation, 'date');
  const shown = raw(htmlEditFormat(isDate ? lsDateFormat(value, m) : value));
  const key = raw(attr.name);
  const label = raw(xmlFormat(attr.label));
  const required = raw(attr.required);
  if (cfEq(attr.validation, 'color')) {
    return join([
      html`${nl(0)}${nl(7)}<div class="input-group mura-colorpicker">`,
      html`${nl(8)}<span class="input-group-addon">`,
      html`<i class="mura-colorpicker-swatch" style="background-color:${shown}"></i></span>`,
      html`${nl(8)}<input type="text" id="${key}" name="${key}" placeholder="Select Color" autocomplete="off" `,
      html` value="${shown}" data-label="${label}" data-required="${required}"${messageAttr(attr.message)}>`,
      html`${nl(7)}</div>${nl(0)}${nl(6)}`,
    ]);
  }
  const dateClass = isDate ? raw(' datepicker') : NOTHING;
  return join([
    html`${nl(0)}${nl(7)}<input type="text" name="${key}" class="text${dateClass}" id="${key}" data-label="${label}"`,
    html` value="${shown}" data-required="${required}"${validationAttrs(attr)}${messageAttr(attr.message)} />`,
    html`${nl(0)}${nl(6)}`,
  ]);
}

/** SelectBox/MultiSelectBox: the multi-select's empty hidden companion, then the select and its `^` options. */
function renderSelect(attr: ExtendAttributeView, value: string, multiple: boolean): SafeHtml {
  const key = raw(attr.name);
  const labels = caretList(attr.optionLabelList);
  const options = caretList(attr.optionList).map((option, position) => {
    const isSelected = cfEq(option, value) || cfListFind(value, option, '^') || cfListFind(value, option);
    const selectedAttr = isSelected ? raw(' selected="selected"') : NOTHING;
    return html`<option value="${raw(xmlFormat(option))}"${selectedAttr}>${optionText(attr, labels, option, position)}</option>`;
  });
  return join([
    multiple ? html`<input type="hidden" name="${key}" value="" />` : NOTHING,
    html`<select name="${key}" id="${key}" data-label="${raw(xmlFormat(attr.label))}" data-required="${raw(attr.required)}"`,
    html`${messageAttr(attr.message)}${multiple ? raw(' multiple="multiple"') : NOTHING}>${join(options)}</select>`,
  ]);
}

/** RadioGroup: one inline radio label per `^` option. */
function renderRadioGroup(attr: ExtendAttributeView, value: string): SafeHtml {
  const key = raw(attr.name);
  const labels = caretList(attr.optionLabelList);
  const radios = caretList(attr.optionList).map((option, position) => {
    const checkedAttr = cfEq(option, value) ? raw(' checked="checked"') : NOTHING;
    return join([
      html`<label class="radio inline"><input type="radio" id="${key}" name="${key}" value="${raw(xmlFormat(option))}"`,
      html`${checkedAttr} /> ${optionText(attr, labels, option, position)}</label> `,
    ]);
  });
  return join(radios);
}

/** `extendAttribute.renderAttribute(theValue)` without a bean, so a File attribute is a plain file input. */
function renderAttributeControl(attr: ExtendAttributeView, m: EditSiteModel): SafeHtml {
  const value = cfEq(attr.value, USE_MURA_DEFAULT) ? attr.defaultValue : attr.value;
  const key = raw(attr.name);
  const label = raw(xmlFormat(attr.label));
  const required = raw(attr.required);
  switch (attr.type.toLowerCase()) {
    case 'textbox':
    case 'text':
      return cfEq(attr.validation, 'datetime')
        ? renderDatetimeSelector(attr.name, value, attr.required, attr.message, m)
        : renderTextInput(attr, value, m);
    case 'textarea':
    case 'htmleditor': {
      const editorClass = cfEq(attr.type, 'HTMLEditor') ? raw(' class="htmlEditor"') : NOTHING;
      return join([
        html`<textarea name="${key}" id="${key}" data-label="${label}" data-required="${required}"`,
        html`${messageAttr(attr.message)}${editorClass}${validationAttrs(attr)}>${raw(htmlEditFormat(value))}</textarea>`,
      ]);
    }
    case 'selectbox':
    case 'multiselectbox':
      return renderSelect(attr, value, cfEq(attr.type, 'MultiSelectBox'));
    case 'radiogroup':
      return renderRadioGroup(attr, value);
    case 'file':
      return join([
        html`<input type="file" name="${key}" id="${key}" data-label="${label}" value="" data-required="${required}"`,
        html`${validationAttrs(attr)}${messageAttr(attr.message)}/>`,
      ]);
    default:
      return NOTHING;
  }
}

/** The label's content: the hint popover or the bare label, then a stored File value's preview, download and delete box. */
function renderAttributeLabel(attr: ExtendAttributeView, m: EditSiteModel): SafeHtml {
  const label = raw(attr.label);
  const head =
    attr.hint === ''
      ? html`${nl(9)}${label} `
      : join([
          html`${nl(9)}${nl(10)}<span data-toggle="popover" title="" data-placement="right"`,
          html`${nl(9)}  \tdata-content="${raw(encodeHtmlAttr(attr.hint))}"`,
          html`${nl(9)}  \tdata-original-title="${raw(encodeHtmlAttr(attr.label))}">`,
          html`${nl(9)}  \t${label} <i class="mi-question-circle"></i></span>${nl(11)}`,
        ]);
  if (!cfEq(attr.type, 'File') || attr.value === '' || cfEq(attr.value, USE_MURA_DEFAULT)) return head;
  const context = raw(legacySettings().context);
  const fileId = raw(encodeUrl(attr.value));
  const preview = IMAGE_EXTENSIONS.has(attr.fileExt.toLowerCase())
    ? join([
        html`${nl(11)}<a href="./index.cfm?muraAction=cArch.imagedetails&siteid=${raw(m.bean.siteID)}&fileid=${fileId}">`,
        html`<img id="assocImage" src="${context}/index.cfm/_api/render/small/?fileid=${fileId}&cacheID=${raw(m.newCacheId())}" />`,
        html`</a>${nl(10)}`,
      ])
    : NOTHING;
  return join([
    head,
    preview,
    html`${nl(11)}<a href="${context}/index.cfm/_api/render/file/?fileID=${fileId}" target="_blank">[Download]</a>`,
    html`${nl(11)}<input type="checkbox" value="true" name="extDelete${raw(String(attr.attributeID))}"/>`,
    html`${nl(11)}Delete${nl(10)}`,
  ]);
}

/** One attribute's control group; a Hidden attribute is edited as a TextBox. */
function renderAttribute(attr: ExtendAttributeView, m: EditSiteModel): SafeHtml {
  const control: ExtendAttributeView = cfEq(attr.type, 'Hidden') ? { ...attr, type: 'TextBox' } : attr;
  return join([
    html`${nl(7)}<div class="mura-control-group">`,
    html`${nl(9)}<label>${renderAttributeLabel(attr, m)}${nl(8)}</label>`,
    html`${nl(9)}${nl(9)}${renderAttributeControl(control, m)}`,
    html`${nl(8)}</div>${nl(6)}`,
  ]);
}

/** One extend set: its `span.extendset` wrapper with the set's raw style, hidden set id, heading and attribute groups. */
function renderExtendSet(set: ExtendSetView, m: EditSiteModel): SafeHtml {
  const id = raw(set.extendSetID);
  return join([
    html`${nl(6)}<span class="extendset" extendsetid="${id}" categoryid="${raw(set.categoryID)}" ${raw(set.style)}>`,
    html`${nl(5)}<input name="extendSetID" type="hidden" value="${id}"/>`,
    html`${nl(5)}<div class="block block-bordered">`,
    html`${nl(7)}<h2>${raw(set.name)}</h2>${nl(7)}`,
    join(set.attributes.map((attr) => renderAttribute(attr, m))),
    html`${nl(6)}</div>`,
    html`${nl(5)}</span>${nl(5)}`,
  ]);
}

/** The `tabExtendedAttributes` pane, or nothing when the site's Default subtype has no active extend sets. */
export function renderExtendedAttributesTab(m: EditSiteModel): SafeHtml {
  if (m.extendSets.length === 0) return NOTHING;
  return join([
    html`${nl(4)}<div id="tabExtendedAttributes" class="tab-pane">`,
    html`${nl(3)}<div class="block block-bordered">`,
    html`${nl(4)}<!-- block header -->`,
    html`${nl(3)}  <div class="block-header">`,
    html`${nl(5)}<h3 class="block-title">Extended Attributes</h3>`,
    html`${nl(3)}  </div>`,
    html`${nl(3)}  <!-- /block header -->`,
    html`${nl(3)}  <div class="block-content">\t\t\t\t\t`,
    join(m.extendSets.map((set) => renderExtendSet(set, m))),
    html`${nl(3)}</div> `,
    html`${nl(2)}</div> `,
    html`${nl(1)}</div> ${nl(2)}`,
  ]);
}
