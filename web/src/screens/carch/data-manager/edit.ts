// Data manager edit form of one form response (`admin/core/views/carch/data_manager/dsp_edit.cfm` lines 76-141).
import type { CsrfRenderer } from '@/lib/csrf';
import { formatDateTimeShort } from '@/lib/dates';
import { encodeHtml, encodeHtmlAttr, encodeJs, html, join, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** The request services the edit form reads. */
export type DataEditCtx = { readonly csrf: CsrfRenderer; readonly rb: RbLookup };

/** The response being edited and the data manager state the form posts back. */
export interface DataEditInput {
  /** `rc.fieldnames`: comma list of the fields shown, in order. */
  readonly fieldnames: string;
  /** `dataCollectionManager.read(rc.responseid)`. */
  readonly response: {
    readonly responseId: string;
    /** `Entered`, for the date/time line. */
    readonly entered: Parameters<typeof formatDateTimeShort>[0];
    /** `Entered` as ColdFusion prints the query value. */
    readonly enteredRaw: string;
    /** The deserialised WDDX struct of `Data`, values in their CF string forms. */
    readonly data: Readonly<Record<string, string>>;
  };
  readonly contentid: string;
  readonly siteid: string;
  readonly moduleid: string;
  readonly hour1: string;
  readonly hour2: string;
  readonly minute1: string;
  readonly minute2: string;
  readonly date1: string;
  readonly date2: string;
  readonly sortBy: string;
  readonly sortDirection: string;
  readonly filterBy: string;
  readonly keywords: string;
  /** `session.dateKeyFormat`. */
  readonly dateKeyFormat: string;
  /** `session.locale`: Java locale of the entered time. */
  readonly locale: string;
}

// The platform's isCfUuid pattern, repeated so this view depends on the web libraries alone.
/** ColdFusion `isValid('uuid', v)`: the 35-character 8-4-4-16 form, either case. */
const CF_UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/;

const ATTACHMENT = /attachment/i;

const attrValue = (value: string): SafeHtml => raw(encodeHtmlAttr(value));

/** `cfloop list=`: the non-empty `,`-separated items. */
function listItems(list: string): string[] {
  return list.split(',').filter((item) => item !== '');
}

/** `info['#f#']` as a case-insensitive struct read; `''` when the key is absent (the template's cftry fallback). */
function fieldValue(data: Readonly<Record<string, string>>, name: string): string {
  if (Object.hasOwn(data, name)) return data[name] ?? '';
  const lower = name.toLowerCase();
  const key = Object.keys(data).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? '' : (data[key] ?? '');
}

// Loop whitespace is the template's as ACF whitespace management emits it, observed on the legacy server.
/** One field: a hidden input for a stored attachment id, else a labelled text input or, past 100 characters, a textarea. */
function renderField(name: string, value: string): SafeHtml {
  if (ATTACHMENT.test(name) && CF_UUID.test(value)) {
    // The id is printed unencoded, as legacy prints `#fvalue#`.
    return html`\t\t<input type="hidden" name="${attrValue(name)}" value="${raw(value)}">\n\t\n`;
  }
  const control =
    value.length > 100
      ? html`\t\t\t\t\t<textarea class="mura-constrain" name="${attrValue(name)}">${raw(encodeHtml(value))}</textarea>\n\t\t\t\t\n`
      : html`\t\t\t\t\t<input class="mura-constrain" type="text" name="${attrValue(name)}" value="${attrValue(value)}">\n  \t\t\t\n`;
  return html`\t\t<div class="mura-control-group">\n  \t\t\t<label>${raw(encodeHtml(name))}</label>\n\t\t\t\t\n${control} \t\t </div>\n\t\n`;
}

/**
 * The `form1` markup that posts `action=update` or `delete` back to `cArch.datamanager`, with CSRF context
 * `responseId`: the include's output from the line break before `<form` through the line break after `</form>`; ACF
 * drops the include's trailing newline after `</cfoutput>`.
 */
export async function renderDataEdit(ctx: DataEditCtx, input: DataEditInput): Promise<SafeHtml> {
  const { response } = input;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(`sitemanager.content.fields.${key}`));
  const entered = formatDateTimeShort(response.entered, input.dateKeyFormat, input.locale);
  const fields = listItems(input.fieldnames).map((name) => renderField(name, fieldValue(response.data, name)));
  await ctx.csrf.tokens(response.responseId);
  const csrf = ctx.csrf.render(response.responseId, 'form');

  // responseID and entered are printed unencoded, as legacy prints them.
  return html`
<form novalidate="novalidate" name="form1" action="index.cfm" method="post">



<div class="mura-control-group">
  <label>Date/Time Entered</label>
  <div class="mura-control">
    ${raw(entered)}
  </div>
</div>


${join(fields)}
<div class="mura-actions">
	<div class="form-actions">
	<button class="btn mura-primary" onclick="submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${label('update')}</button>
	<button type="button" class="btn" onclick="submitForm(document.forms.form1,'delete','${raw(encodeJs(ctx.rb.rbKey('sitemanager.content.fields.deleteresponseconfirm')))}');"><i class="mi-trash"></i>${label('deleteresponse')}</button>
	</div>
</div>

<input type="hidden" name="formid" value="${attrValue(input.contentid)}">
<input type="hidden" name="contentid" value="${attrValue(input.contentid)}">
<input type="hidden" name="siteid" value="${attrValue(input.siteid)}">
<input type="hidden" name="muraAction" value="cArch.datamanager">
<input type="hidden" name="responseID" value="${raw(response.responseId)}">
<input type="hidden" name="hour1" value="${attrValue(input.hour1)}">
<input type="hidden" name="hour2" value="${attrValue(input.hour2)}">
<input type="hidden" name="minute1" value="${attrValue(input.minute1)}">
<input type="hidden" name="minute2" value="${attrValue(input.minute2)}">
<input type="hidden" name="date1" value="${attrValue(input.date1)}">
<input type="hidden" name="date2" value="${attrValue(input.date2)}">
<input type="hidden" name="fieldlist" value="${attrValue(input.fieldnames)}">
<input type="hidden" name="sortBy" value="${attrValue(input.sortBy)}">
<input type="hidden" name="sortDirection" value="${attrValue(input.sortDirection)}">
<input type="hidden" name="filterBy" value="${attrValue(input.filterBy)}">
<input type="hidden" name="keywords" value="${attrValue(input.keywords)}">
<input type="hidden" name="entered" value="${raw(response.enteredRaw)}">
<input type="hidden" name="moduleid" value="${attrValue(input.moduleid)}">
<input type="hidden" name="action" value="update">
${csrf}
</form>
`;
}
