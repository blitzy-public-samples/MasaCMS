// Category tree of the content edit Categorization panel (`carch/form/dsp_categories_nest.cfm`), server-only.
import { cfEq, cfHour, cfLsDateFormat, cfMinute, cfToBoolean } from '@opt2/platform/legacy-compat';
import { parseLegacyDate } from '@/lib/dates';
import { encodeHtml, encodeHtmlAttr, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { ScreenContext } from '../../registry';
import { structOf, structText } from '../model';
import type { EditPageData } from './custom-tags';

// The strings are the tag body's bytes as ACF 2023 emits them: CFML comments are dropped and the text around them
// joins, and every whitespace-only text run of the body follows output ending in whitespace, so none of them prints.

/** `rsIsMember` of one category: the version's assignment row, or the bean values a validation re-render keeps. */
export interface EditCategoryAssignment {
  /** Matching assignment rows; on a re-render, the category's `listFind` position in the bean's `categoryID`. */
  readonly recordcount: number;
  /** `0` not featured, `1` featured, `2` scheduled; `''` without an assignment row. */
  readonly isFeature: string | number;
  /** `{ts '…'}` or ISO date text; null or `''` when unset. */
  readonly featureStart: string | null;
  /** `{ts '…'}` or ISO date text; null or `''` when unset. */
  readonly featureStop: string | null;
}

/** One category of the site's category pool, siblings in `categoryManager.getCategories` order. */
export interface EditCategoryNode {
  readonly categoryId: string;
  readonly name: string;
  /** The checkbox renders only when it is 1. */
  readonly isOpen: 0 | 1;
  /** `''` for SQL NULL. */
  readonly isFeatureable: 0 | 1 | '';
  /** Child count; the nested list renders only when it is non-zero. */
  readonly hasKids: number;
  /** `permUtility.getCategoryPerm(restrictGroups, siteID)` for the session user. */
  readonly permitted: boolean;
  readonly children: readonly EditCategoryNode[];
  readonly assignment: EditCategoryAssignment;
}

/** What the tree reads besides its rows: labels, the session date settings and the edited content bean. */
export interface EditCategoriesNestInput {
  readonly ctx: Pick<ScreenContext, 'rb'> & {
    readonly req: { readonly session: Pick<AdminRequest['session'], 'locale' | 'dateKeyFormat' | 'localeHasDayParts'> };
  };
  /** The edit model; its `rc.contentBean` supplies `data-siteID`. */
  readonly data: EditPageData;
}

/** `<cf_dsp_categories_nest>` attributes, with the level's rows in place of its `getCategories` query. */
export interface EditCategoriesNestOptions {
  /** The level's categories. */
  readonly nodes: readonly EditCategoryNode[];
  /** Default `''`: the top level, which takes the `mura-nodes` id; a nested level starts hidden. */
  readonly parentId?: string;
  /** Accepted as the tag accepts it; no level prints it. */
  readonly nestLevel?: number;
  /** Default false. */
  readonly disabled?: boolean;
  /** `rc.siteID`; accepted as the tag accepts it, the rows being resolved for it already. */
  readonly siteId?: string;
}

/** The tree's markup and `request.opencategorylist`. */
export interface EditCategoriesNestResult {
  readonly html: SafeHtml;
  /** Ids of the assigned categories in render order. */
  readonly openCategoryIds: readonly string[];
}

/** Values every level of the recursion shares. */
interface NestState {
  readonly session: EditCategoriesNestInput['ctx']['req']['session'];
  readonly no: string;
  readonly yes: string;
  readonly contentSiteId: string;
  readonly open: string[];
}

const tabs = (n: number): string => '\t'.repeat(n);

/** A stored feature date: null when empty, ACF's error for text it cannot read as a date. */
function featureDate(value: string | null): Date | null {
  if (value === null || value.trim() === '') return null;
  const date = parseLegacyDate(value);
  if (date === null) throw new RangeError(`The value ${value} cannot be converted to a date.`);
  return date;
}

/** `LSDateFormat(value, mask)` under the session locale; `''` for an empty value. */
function lsDate(state: NestState, date: Date | null, mask: string): string {
  return date === null ? '' : cfLsDateFormat(date, mask, state.session.locale);
}

/** `yesNoFormat(value)` as a boolean: `''` reads No, other values convert as CFML booleans. */
function yesNo(value: string | number): boolean {
  return value !== '' && cfToBoolean(value);
}

/** The window `start&nbsp;-&nbsp;stop` in short dates; only the start is attribute-encoded, as legacy encodes it. */
function featureWindow(state: NestState, assignment: EditCategoryAssignment): string {
  const start = encodeHtmlAttr(lsDate(state, featureDate(assignment.featureStart), 'short'));
  return `${start}&nbsp;-&nbsp;${lsDate(state, featureDate(assignment.featureStop), 'short')}`;
}

/** The quick-edit anchor's icon and label for `isFeature`, as the tag's `cfswitch` writes them. */
function featureIcon(state: NestState, isFeature: string | number, window: string): string {
  const value = String(isFeature);
  if (cfEq(value, '0')) {
    return `\n${tabs(11)}<i class="mi-ban" title="${state.no}"></i>\n${tabs(12)}<span>${state.no}</span>\n${tabs(11)}`;
  }
  if (cfEq(value, '1')) {
    return `\n${tabs(12)}<i class="mi-check" title="${state.yes}"></i>\n${tabs(12)}<span>${state.yes}</span>\n${tabs(11)}`;
  }
  if (cfEq(value, '2')) return `\n${tabs(12)}<i class="mi-calendar" title="${window}"></i>\n${tabs(11)}`;
  return `\n${tabs(12)}<i class="mi-ban" title="${state.no}"></i><span>${state.no}</span>\n${tabs(11)}`;
}

/** One hidden input of a schedule time part. */
const hiddenInput = (field: string, trim: string, value: string): string =>
  `<input type="hidden" id="${field}${trim}" name="${field}${trim}" value="${value}">`;

/**
 * The hour, day part and minute inputs of one end of the window (`start` or `stop`); `plainDayPartTabs` is the
 * indentation of the day part input for locales without day parts, which differs between the two ends.
 */
function timeFields(
  state: NestState,
  end: 'start' | 'stop',
  trim: string,
  date: Date | null,
  plainDayPartTabs: number,
): string {
  const [hourField, dayPartField, minuteField] = [`${end}Hour`, `${end}DayPart`, `${end}Minute`];
  if (date === null) {
    return (
      `\n${tabs(11)}${hiddenInput(hourField, trim, '')}\n${tabs(11)}${hiddenInput(minuteField, trim, '')}` +
      `\n${tabs(11)}${hiddenInput(dayPartField, trim, '')}\n${tabs(10)}`
    );
  }
  const hour = cfHour(date);
  let hourAndDayPart: string;
  if (state.session.localeHasDayParts) {
    const [value, dayPart] = hour < 12 ? [hour, 'AM'] : [hour - 12, 'PM'];
    hourAndDayPart =
      `\n${tabs(13)}${hiddenInput(hourField, trim, String(value))}` +
      `\n${tabs(13)}${hiddenInput(dayPartField, trim, dayPart)}\n${tabs(12)}`;
  } else {
    hourAndDayPart =
      `\n${tabs(12)}${hiddenInput(hourField, trim, String(hour))}` +
      `\n${tabs(plainDayPartTabs)}${hiddenInput(dayPartField, trim, '')}\n${tabs(11)}`;
  }
  return `${hourAndDayPart}\n${tabs(11)}${hiddenInput(minuteField, trim, String(cfMinute(date)))}\n${tabs(10)}`;
}

/** The hidden `categoryAssign<trim>` input, plus the window's date and time inputs of a scheduled assignment. */
function assignmentFields(state: NestState, assignment: EditCategoryAssignment, trim: string): string {
  const assign = (value: string): string =>
    `\n${tabs(10)}<input type="hidden" id="categoryAssign${trim}" name="categoryAssign${trim}" value="${value}"/>`;
  const { recordcount, isFeature } = assignment;
  if (recordcount === 0 || !yesNo(isFeature)) return `${assign('0')}\n${tabs(9)}`;
  if (cfEq(String(isFeature), '1')) return `${assign('1')}\n${tabs(9)}`;
  if (!cfEq(String(isFeature), '2')) return '';
  const { dateKeyFormat } = state.session;
  const start = featureDate(assignment.featureStart);
  const startInput = `\n${tabs(11)}${hiddenInput('featureStart', trim, lsDate(state, start, dateKeyFormat))}`;
  const stop = featureDate(assignment.featureStop);
  const stopInput = `\n${tabs(10)}\n${tabs(10)}${hiddenInput('featureStop', trim, lsDate(state, stop, dateKeyFormat))}`;
  return (
    `${assign('2')}${startInput}\n${tabs(10)}${timeFields(state, 'start', trim, start, 12)}` +
    `${stopInput}\n${tabs(10)}${timeFields(state, 'stop', trim, stop, 13)}`
  );
}

/** The `categoryLabelContainer` of a featureable category: quick-edit anchor and hidden assignment inputs. */
function featureAssignment(state: NestState, node: EditCategoryNode, trim: string, disabled: boolean): string {
  const { assignment } = node;
  const scheduled = cfEq(String(assignment.isFeature), '2');
  const window = scheduled ? featureWindow(state, assignment) : '';
  return (
    `\n${tabs(7)}<div id="categoryLabelContainer${trim}" class="categoryLabelContainer">` +
    `\n${tabs(8)}<div class="categoryassignment${assignment.recordcount !== 0 && scheduled ? ' scheduled' : ''}">` +
    `\n${tabs(9)}\n${tabs(9)}<a class="dropdown-toggle${disabled ? '' : ' mura-quickEditItem'}"` +
    `${scheduled ? ` rel="tooltip" title="${window}"` : ''}>\n${tabs(10)}` +
    `${featureIcon(state, assignment.isFeature, window)}\n${tabs(9)}</a>\n${tabs(9)}` +
    `${assignmentFields(state, assignment, trim)}\n${tabs(8)}</div>\n${tabs(7)}</div>\n\n${tabs(6)}`
  );
}

/** One `<li>`: title with its checkbox, assignment controls, then the children's list when the category has kids. */
function renderItem(state: NestState, node: EditCategoryNode, disabled: boolean): string {
  const id = node.categoryId;
  const trim = id.replaceAll('-', '');
  const checked = node.assignment.recordcount !== 0 ? '\tchecked="true"' : '';
  const disabledAttr = disabled ? `\n${tabs(8)}disabled="true"\n${tabs(7)}` : '';
  const checkbox =
    node.isOpen === 1 ? `<input name="categoryid"${disabledAttr} value="${id}" type="checkbox" ${checked}/> ` : '';
  const hidden = disabled ? `\n${tabs(8)}<input name="categoryid" value="${id}" type="hidden" />\n${tabs(7)}` : '';
  const featureable = (node.isOpen === 1 && node.isFeatureable === 1) || node.isFeatureable === '';
  const assignment = featureable
    ? featureAssignment(state, node, trim, disabled)
    : `\n${tabs(7)}<input type="hidden" id="categoryAssign${trim}" name="categoryAssign${trim}" value="0"/>\n${tabs(6)}`;
  const hasKids = node.hasKids !== 0;
  const nested = hasKids ? renderLevel(state, node.children, id, disabled) : '';
  return (
    `\n${tabs(3)}<li data-siteID="${state.contentSiteId}" data-categoryid="${id}" data-cattrim="${trim}"` +
    ` data-disabled="${disabled}">` +
    `\n${tabs(4)}<dl class="categoryitem">\n${tabs(5)}\n${tabs(5)}<dt class="categorytitle">` +
    `\n${tabs(6)}<span class="${hasKids ? ' hasChildren closed' : ''}"></span>\n${tabs(6)}<label>\n${tabs(7)}` +
    `${checkbox}${encodeHtml(node.name)}</label>\n${tabs(7)}${hidden}` +
    `\n${tabs(5)}</dt>\n${tabs(5)}\n${tabs(5)}<dd class="categoryassignmentwrapper">\n${tabs(6)}${assignment}` +
    `\n${tabs(5)}</dd>\n${tabs(4)}</dl>\n${tabs(4)}${nested}\n${tabs(3)}</li>\n${tabs(2)}`
  );
}

/** One level's `<ul>` and its descendants; `''` when the level has no categories. */
function renderLevel(
  state: NestState,
  nodes: readonly EditCategoryNode[],
  parentId: string,
  inherited: boolean,
): string {
  if (nodes.length === 0) return '';
  // Like legacy's `attributes.disabled`, an unpermitted category disables every later sibling and their subtrees.
  let disabled = inherited;
  const placement = parentId.length > 0 ? ' style="display:none"' : ' id="mura-nodes"';
  let out = `\n\t<ul class="categorylist"${placement}>\n${tabs(2)}`;
  for (const node of nodes) {
    if (node.assignment.recordcount !== 0) state.open.push(node.categoryId);
    if (!disabled && !node.permitted) disabled = true;
    out += renderItem(state, node, disabled);
  }
  return `${out}\n\t</ul>\n`;
}

/** `<cf_dsp_categories_nest>` output for `opts.nodes` and their descendants, with the assigned ids it collects. */
export function renderEditCategoriesNest(
  input: EditCategoriesNestInput,
  opts: EditCategoriesNestOptions,
): EditCategoriesNestResult {
  const { rb, req } = input.ctx;
  const state: NestState = {
    session: req.session,
    no: rb.rbKey('sitemanager.no'),
    yes: rb.rbKey('sitemanager.yes'),
    contentSiteId: structText(structOf(input.data.rc, 'contentBean'), 'siteID'),
    open: [],
  };
  const markup = renderLevel(state, opts.nodes, opts.parentId ?? '', opts.disabled ?? false);
  return { html: raw(markup), openCategoryIds: state.open };
}
