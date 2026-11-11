// Category assignment tree of `cfeed/dsp_categories_import_nest.cfm`; unused, as no legacy view calls the tag.
import { formatDateField, parseLegacyDate } from '@/lib/dates';
import { html, raw, type SafeHtml } from '@/lib/html';
import type { FeedCategoryNode } from './categories-nest';

/** A `tcontentcategoryassign` row of the tag's `rsCategoryAssign` query. */
export interface CategoryAssignRow {
  readonly categoryID: string;
  readonly contentHistID: string;
  /** 0 assigned, 1 featured, 2 featured between `featureStart` and `featureStop`. */
  readonly isFeature: number;
  readonly featureStart: Date | string | null;
  readonly featureStop: Date | string | null;
}

/** Arguments of `<cf_dsp_categories_import_nest>`: the level's categories and the version's category assignments. */
export interface FeedCategoriesImportNestInput {
  readonly nodes: readonly FeedCategoryNode[];
  readonly nestLevel: number;
  readonly assignments: readonly CategoryAssignRow[];
  /** `newBean.getcontentHistID()`, the version whose assignments mark membership. */
  readonly contentHistId: string;
  /** `session.dateKeyFormat`. */
  readonly dateKeyFormat: string;
}

const HOURS: readonly number[] = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES: readonly number[] = Array.from({ length: 60 }, (_, i) => i);

const selected = (on: boolean): SafeHtml | false => on && raw('selected');

/** `LSDateFormat(value, session.dateKeyFormat)` unencoded, `''` without a date. */
function dateValue(date: Date | null, dateKeyFormat: string): SafeHtml {
  // `now` is the date itself so the date-field 50-year cutoff, which LSDateFormat lacks, never applies.
  return raw(date === null ? '' : formatDateField(date, dateKeyFormat, date));
}

/** Hour options 1-12: the stored hour on the 12-hour clock, else `defaultHour`. */
function hourOptions(date: Date | null, defaultHour: number): SafeHtml[] {
  const hour = date?.getHours();
  return HOURS.map((h) => {
    const on = hour === undefined ? h === defaultHour : hour === h || hour - 12 === h || (hour === 0 && h === 12);
    return html`<option value="${h}" ${selected(on)}>${h}</option>`;
  });
}

/** Minute options 0-59 with zero-padded labels: the stored minute, else `defaultMinute` (none when null). */
function minuteOptions(date: Date | null, defaultMinute: number | null): SafeHtml[] {
  return MINUTES.map((m) => {
    const on = date === null ? m === defaultMinute : date.getMinutes() === m;
    return html`<option value="${m}" ${selected(on)}>${String(m).padStart(2, '0')}</option>`;
  });
}

/** The assignment select and its feature start/stop fields of an open category. */
function assignControls(node: FeedCategoryNode, input: FeedCategoriesImportNestInput): SafeHtml {
  const catTrim = node.categoryID.replaceAll('-', '');
  const member = input.assignments.find(
    (row) => row.categoryID === node.categoryID && row.contentHistID === input.contentHistId,
  );
  const perDates = member?.isFeature === 2;
  const start = parseLegacyDate(member?.featureStart);
  const stop = parseLegacyDate(member?.featureStop);
  // Legacy omits `disabled` from startDayPart and stophour.
  const disabled = !node.permitted && raw('disabled');
  return html`
<select  name="categoryAssign${catTrim}" ${disabled}  onchange="javascript: this.selectedIndex==3?toggleDisplay2('editDates${catTrim}',true):toggleDisplay2('editDates${catTrim}',false);">
<option ${selected(member === undefined)} value="">No</option>
<option ${selected(member !== undefined && !member.isFeature)} value="0">Yes</option>
<option value="1" ${selected(member?.isFeature === 1)}>Feature</option>
<option value="2" ${selected(perDates)}>Feature Per Start/Stop Dates</option>
</select>
\t  <dl id="editDates${catTrim}" ${!perDates && raw('style="display: none;"')}>
\t\t<dt>Start Date / Time</dt>
\t\t<dd><input type="text" name="featureStart${catTrim}" ${disabled}  value="${dateValue(start, input.dateKeyFormat)}" class="textAlt datepicker">
\t\t
\t\t<select name="starthour${catTrim}" ${disabled}>${hourOptions(start, 12)}</select>
\t\t<select name="startMinute${catTrim}" ${disabled}>${minuteOptions(start, null)}</select>
\t\t<select name="startDayPart${catTrim}"><option value="AM">AM</option><option value="PM" ${selected(start !== null && start.getHours() >= 12)}>PM</option></select>
\t\t</dd>
\t\t<dt>Stop Date / Time</dt>
\t\t<dd><input type="text" name="featureStop${catTrim}" ${disabled} value="${dateValue(stop, input.dateKeyFormat)}" class="textAlt datepicker">

\t<select name="stophour${catTrim}">${hourOptions(stop, 11)}</select>
\t\t<select name="stopMinute${catTrim}" ${disabled}>${minuteOptions(stop, 59)}</select>
\t\t<select name="stopDayPart${catTrim}" ${disabled}><option value="AM">AM</option><option value="PM" ${selected(stop === null || stop.getHours() >= 12)}>PM</option></select>
\t\t</dd>
\t\t</dl>
`;
}

/** One `<li><ul><li>`: encoded name, the assignment controls when open, then the children's tree when it has kids. */
function categoryItem(node: FeedCategoryNode, input: FeedCategoriesImportNestInput): SafeHtml {
  // Legacy's recursive call omits rsCategoryAssign and newBean and fails; children reuse the parent's assignments.
  const nested = node.hasKids
    ? renderFeedCategoriesImportNest({ ...input, nodes: node.children, nestLevel: input.nestLevel + 1 })
    : '';
  const open = Number(node.isOpen) === 1;
  // ACF writes whitespace-only text between CFML tags as one space, or nothing after whitespace such as the controls'.
  const gap = !open && !node.name.endsWith(' ') && raw(' ');
  return html`
<li>
<ul>
<li>${node.name}${open ? assignControls(node, input) : gap}${nested}
</li>
</ul>
</li>
`;
}

/** `<cf_dsp_categories_import_nest>` output for a level and its descendants at a buffer's start; '' without nodes. */
export function renderFeedCategoriesImportNest(input: FeedCategoriesImportNestInput): SafeHtml {
  if (input.nodes.length === 0) return html``;
  return html`
<ul>
${input.nodes.map((node) => categoryItem(node, input))}
</ul>
`;
}
