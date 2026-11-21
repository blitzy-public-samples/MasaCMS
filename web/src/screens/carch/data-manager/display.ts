// Display-fields panel of the form data manager (`admin/core/views/carch/data_manager/dsp_display.cfm`).
import { encodeHtml, encodeHtmlAttr, html, join, raw, type SafeHtml } from '@/lib/html';
import type { RbLookup } from '@/lib/resource-bundles/rb';

// Legacy markup verbatim, defects included (duplicate `class` attributes, typeless button). Whitespace is what ACF
// emits: CFML tags and comments keep their surrounding whitespace, but whitespace-only text between two is dropped.

/** What the panel reads from the screen context: the session's admin label lookup. */
export type DataDisplayCtx = { readonly rb: RbLookup };

/** The values `dsp_display.cfm` reads from `rc`, the content bean and the session, resolved by the caller. */
export interface DataDisplayInput {
  /** `rc.fieldnames`: the form's full field list, comma-delimited. */
  readonly fieldnames: string;
  /** Content bean `responseDisplayFields`, `<detail fields>~<summary fields>`, each `^`-delimited. */
  readonly responseDisplayFields: string;
  /** Content bean `nextN`. */
  readonly nextN: number | string;
  /** Content bean `sortBy`, not `rc.sortBy`. */
  readonly sortBy: string;
  /** Content bean `sortDirection`. */
  readonly sortDirection: string;
  readonly contentid: string;
  readonly moduleid: string;
  /** `session.siteid`, which the hidden `siteid` field carries. */
  readonly sessionSiteId: string;
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const RECORDS_PER_PAGE: readonly number[] = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

/** CFML list iteration: the items between `delimiter`s, empty items dropped. */
function listItems(list: string, delimiter: string): string[] {
  return list.split(delimiter).filter((item) => item !== '');
}

/** Java `String.trim`, which ACF applies before reading a string as a number. */
function javaTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s.charCodeAt(start) <= 0x20) start++;
  while (end > start && s.charCodeAt(end - 1) <= 0x20) end--;
  return s.slice(start, end);
}

function isCfNumber(s: string): boolean {
  return DECIMAL.test(s) && Number.isFinite(Number(s)) && !s.endsWith('.');
}

/** CFML `eq`: numeric when both trimmed sides are numbers, otherwise case-insensitive string equality. */
function cfEq(a: string, b: string): boolean {
  const x = javaTrim(a);
  const y = javaTrim(b);
  if (isCfNumber(x) && isCfNumber(y)) return Number(x) === Number(y);
  return a.toLowerCase() === b.toLowerCase();
}

/** A label as legacy echoes `rbFactory.getKeyValue`, unencoded. */
function label(rb: RbLookup, key: string): SafeHtml {
  return raw(rb.rbKey(`sitemanager.content.fields.${key}`));
}

/** `selected` when legacy's `<cfif>` holds; nothing otherwise, which leaves the space before `>`. */
function selected(isSelected: boolean): SafeHtml {
  return raw(isSelected ? 'selected' : '');
}

function fieldOption(f: string, indent: string, tail: string): SafeHtml {
  return raw(`\n${indent}<option value="${encodeHtmlAttr(f)}">${encodeHtml(f)}</option>\n${tail}`);
}

/** Lines 77-78: `detailList` is `ListFirst(rdf,'~')` and `summaryList` `ListLast(rdf,'~')`, guarded by edge `~`s. */
function displayLists(rdf: string): { readonly detailList: string; readonly summaryList: string } {
  const parts = listItems(rdf, '~');
  return {
    detailList: rdf.startsWith('~') ? '' : (parts[0] ?? ''),
    summaryList: rdf.endsWith('~') ? '' : (parts.at(-1) ?? ''),
  };
}

/** The `cfhtmlhead` script of the panel, with the core version unencoded as legacy writes it. */
export function dataDisplayHtmlHead(coreVersion: string): SafeHtml {
  return raw(`<script src="assets/js/manageData.js?coreversion=${coreVersion}" type="text/javascript"></script>`);
}

/** The bytes the `dsp_display.cfm` include emits, from its leading newline through `</form>` and its newline. */
export function renderDataDisplay(ctx: DataDisplayCtx, input: DataDisplayInput): SafeHtml {
  const { rb } = ctx;
  const fields = listItems(input.fieldnames, ',');
  const { detailList, summaryList } = displayLists(input.responseDisplayFields);
  const nextN = String(input.nextN);
  const availableOptions = join(fields.map((f) => fieldOption(f, '        ', '      ')));
  const summaryOptions = join(listItems(summaryList, '^').map((f) => fieldOption(f, '                ', '              ')));
  const detailOptions = join(listItems(detailList, '^').map((f) => fieldOption(f, '                ', '              ')));
  const nextNOptions = join(
    RECORDS_PER_PAGE.map((n) => {
      const r = raw(String(n));
      return html`
      <option value="${r}" ${selected(cfEq(String(n), nextN))}>${r}</option>
    `;
    }),
  );
  const sortByOptions = join(
    fields.map(
      (f) => html`
      <option value="${raw(encodeHtmlAttr(f))}" ${selected(cfEq(f, input.sortBy))}>${raw(encodeHtml(f))}</option>
    `,
    ),
  );
  // `#summaryList#` and `#detailList#` are written into the hidden values unencoded, as legacy does.
  return html`
<script type="text/javascript">
function setFields(){
document.getElementById('responseDisplayFields').value=document.getElementById('summaryList2').value + '~' + document.getElementById('detailList2').value;
}
</script>


  <form novalidate="novalidate" name="frmDisplayFields" method="post" action="index.cfm">

<div class="mura-control-group">

  <div class="mura-control-group half">
  <label>${label(rb, 'availablefields')}</label>
    <select name="availableFields" size="10" id="availableFields" class="multiSelect">
      ${availableOptions}
    </select>
  </div>
  <div class="mura-control-group half">
    <table class="mura-control-table">
      <tr>
        <td class="nested"><input type="button" class="btn btn-sm" value=">>" onclick="dataManager.addObject('availableFields','summaryList','summaryList2');" class="objectNav btn">
          <br />
          <input type="button" class="btn btn-sm" value="<<" onclick="dataManager.deleteObject('summaryList','summaryList2');" class="objectNav btn">            </td>
        <td class="nested" style="width:76%;"> <label>${label(rb, 'summarydisplayfields')}</label><br />
          <select name="summaryList" id="summaryList" size="4" style="width:100%;" class="multiSelect">
            ${summaryOptions}
          </select>
          <input type="hidden" name="summaryList2" id="summaryList2" value="${raw(summaryList)}" class="multiSelect"></td>
        <td  class="nested"><input type="button" class="btn btn-sm" value="${label(rb, 'up')}" onclick="dataManager.moveUp('summaryList','summaryList2');" class="objectNav btn">
          <br />
          <input type="button" class="btn btn-sm" value="${label(rb, 'down')}" onclick="dataManager.moveDown('summaryList','summaryList2');" class="objectNav btn"></td>
      </tr>
      <tr>
        <td class="nested"><input type="button" class="btn btn-sm" value=">>" onclick="dataManager.addObject('availableFields','detailList','detailList2');" class="objectNav btn">
          <br />
          <input type="button" class="btn btn-sm" value="<<" onclick="dataManager.deleteObject('detailList','detailList2');" class="objectNav btn"></td>
        <td class="nested"><label>${label(rb, 'detaildisplayfields')}</label><br />
          <select name="detailList"  id="detailList" size="4" style="width:100%;">
            ${detailOptions}
          </select>
          <input type="hidden" name="detailList2" id="detailList2" value="${raw(detailList)}"></td>
        <td  class="nested"><input type="button" class="btn btn-sm" value="${label(rb, 'up')}" onclick="dataManager.moveUp('detailList','detailList2');" class="objectNav btn">
          <br />
          <input type="button" class="btn btn-sm" value="${label(rb, 'down')}" onclick="dataManager.moveDown('detailList','detailList2');" class="objectNav btn"></td>
      </tr>
    </table>
  </div>
</div>

<div class="mura-control-group">
  <label>${label(rb, 'recordsperpage')}
  </label>
  <select name="nextN" class="dropdown mura-constrain mura-numeric">
    ${nextNOptions}
  </select>
</div>

<div class="mura-control-group">
  <label>${label(rb, 'sortby')}</label>
  <select name="sortBy" class="dropdown mura-constrain">
    ${sortByOptions}
  </select>
  <select name="sortDirection" class="dropdown mura-constrain">
    <option value="asc" ${selected(cfEq(input.sortDirection, 'asc'))}>${label(rb, 'ascending')}</option>
    <option value="desc" ${selected(cfEq(input.sortDirection, 'desc'))}>${label(rb, 'descending')}</option>
  </select>
</div>

<div class="mura-actions">
  <div class="form-actions">
    <button class="btn mura-primary" onclick="submitForm(document.forms.frmDisplayFields,'setDisplay');"><i class="mi-check-circle"></i>${label(rb, 'update')}</button>
  </div>
</div>

<input type="hidden" value="setDisplay" name="action">
<input type="hidden" name="muraAction" value="cArch.datamanager" />
<input type="hidden" name="contentid" value="${raw(encodeHtmlAttr(input.contentid))}" />
<input type="hidden" name="siteid" value="${raw(encodeHtmlAttr(input.sessionSiteId))}" />
<input type="hidden" name="moduleid" value="${raw(encodeHtmlAttr(input.moduleid))}" />

</form>
`;
}
