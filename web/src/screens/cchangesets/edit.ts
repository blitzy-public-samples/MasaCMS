// `cChangesets.edit`, also rendered by `cChangesets.save`: the change-set form of `admin/core/views/cchangesets/edit.cfm`.
// Whitespace between tags is what ACF whitespace management leaves, as captured from the legacy server.
import {
  cfDateTimeFormat,
  cfHour,
  cfListToArray,
  cfLsDateFormat,
  cfLsTimeFormat,
  cfMinute,
  cfToBoolean,
  cfToNumber,
  cfUuid,
} from '@opt2/platform/legacy-compat';
import { formatDateField, isMoreThanFiftyYearsAfter, parseLegacyDate } from '@/lib/dates';
import { okBody } from '@/lib/gateway-client';
import { encodeHtml, encodeHtmlAttr, encodeJs, encodeUrl, html, join, raw, type SafeHtml } from '@/lib/html';
import type { PageScreen, Rc, ScreenContext } from '../registry';
import { renderCategoriesNest, type ChangesetCategoryNode } from './dsp_categories_nest';
import { renderChangesetsMenu } from './secondary-menu';

/** The change set `changesetManager.read(rc.changesetID)` returns, saved or new. */
export interface ChangesetEditChangeset {
  readonly changesetId: string;
  readonly siteId: string;
  readonly name: string;
  readonly description: string;
  readonly closeDate: Date | null;
  readonly publishDate: Date | null;
  readonly lastUpdate: Date | null;
  readonly published: boolean;
  readonly isNew: boolean;
  /** `changeset.hasPendingApprovals()`; false for a published change set, whose view never asks. */
  readonly hasPendingApprovals: boolean;
  /** Comma list. */
  readonly tags: string;
  /** Comma list of assigned category ids. */
  readonly categoryId: string;
  /** The bean's error struct as `[key, message]` pairs, in struct order. */
  readonly errors: ReadonlyArray<readonly [key: string, message: string]>;
}

/** What the edit view renders: the change set, the site's category tree and the menu's preview URL. */
export interface ChangesetEditData {
  readonly changeset: ChangesetEditChangeset;
  /** `categoryManager.getCategoryCount(rc.siteid)`; the Categorization tab renders only when non-zero. */
  readonly categoryCount: number;
  readonly categories: readonly ChangesetCategoryNode[];
  /** The edit-case `rc.previewLink`; absent when the menu renders no preview button. */
  readonly previewLink?: string;
}

/** Options of {@link renderChangesetEditView}. */
export interface ChangesetEditViewOptions {
  /** `rc.changesetID` when the view runs; defaults to the request's. */
  readonly rcChangesetId?: string;
}

/** Arguments of `<cf_datetimeselector>`, defaulted as its `cfparam`s. */
export interface DateTimeSelectorArgs {
  readonly name: string;
  readonly datetime: Date | null;
  readonly defaultHour?: number;
  readonly defaultMinute?: number;
  readonly required?: boolean;
  readonly message?: string;
  readonly dateClass?: string;
  readonly dateSpanClass?: string;
}

/** The session values `<cf_datetimeselector>` reads, and the request clock its 50-year rule compares against. */
export interface DateTimeSelectorSession {
  readonly dateKeyFormat: string;
  readonly localeHasDayParts: boolean;
  readonly now: Date;
}

type ShellView = Awaited<ReturnType<PageScreen<ChangesetEditData>['render']>>;

type Struct = Readonly<Record<string, unknown>>;

/** A category row of the screen model; `parentID` is null or empty at the top of the tree. */
interface CategoryRow {
  readonly categoryId: string;
  readonly parentId: string;
  readonly node: Omit<ChangesetCategoryNode, 'children'>;
}

const isStruct = (value: unknown): value is Struct =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A struct member by case-insensitive key, as CFML reads it; undefined when absent. */
function member(struct: Struct, key: string): unknown {
  if (Object.hasOwn(struct, key)) return struct[key];
  const lower = key.toLowerCase();
  const name = Object.keys(struct).find((candidate) => candidate.toLowerCase() === lower);
  return name === undefined ? undefined : struct[name];
}

/** A simple member as CFML text; absent and SQL NULL read as `''`, complex values throw. */
function text(struct: Struct, key: string): string {
  const value = member(struct, key);
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new TypeError(`${key} is not a simple value`);
}

/** A struct member; throws when it is not a struct. */
function structOf(struct: Struct, key: string): Struct {
  const value = member(struct, key);
  if (!isStruct(value)) throw new TypeError(`${key} is not a struct`);
  return value;
}

/** A date member: null when empty, as a bean holds `''` for no date; throws when the text is not a date. */
function dateOf(struct: Struct, key: string): Date | null {
  const value = text(struct, key);
  if (value === '') return null;
  const date = parseLegacyDate(value);
  if (date === null) throw new TypeError(`${key} is not a date: ${value}`);
  return date;
}

/** The rows of a query member; throws when it is not a list of structs. */
function rowsOf(struct: Struct, key: string): readonly Struct[] {
  const value = member(struct, key);
  if (!Array.isArray(value) || !value.every(isStruct)) throw new TypeError(`${key} is not a list of rows`);
  return value;
}

/** Join key of a category id as SQL Server compares the `char(35)` CI_AS columns: case and trailing spaces ignored. */
const idKey = (id: string): string => id.replace(/ +$/, '').toLowerCase();

/** Nests the site's category rows by `parentID`, siblings in the given order; rows unreachable from the top are left out. */
function categoryTree(rows: readonly CategoryRow[]): ChangesetCategoryNode[] {
  const byParent = new Map<string, CategoryRow[]>();
  for (const row of rows) {
    const parent = idKey(row.parentId);
    const siblings = byParent.get(parent);
    if (siblings === undefined) byParent.set(parent, [row]);
    else siblings.push(row);
  }
  const nest = (parent: string): ChangesetCategoryNode[] =>
    (byParent.get(parent) ?? []).map((row) => ({ ...row.node, children: nest(idKey(row.categoryId)) }));
  return nest('');
}

/** A category query row: `categoryID`, `parentID`, `name`, `isOpen` and the computed `permitted`. */
function categoryRow(row: Struct): CategoryRow {
  const categoryId = text(row, 'categoryID');
  return {
    categoryId,
    parentId: text(row, 'parentID'),
    node: {
      categoryId,
      name: text(row, 'name'),
      isOpen: cfToBoolean(member(row, 'isOpen')),
      permitted: cfToBoolean(member(row, 'permitted')),
    },
  };
}

/** The bean's error struct as ordered pairs; an absent struct is the empty one a loaded bean holds. */
function errorsOf(changeset: Struct): ReadonlyArray<readonly [string, string]> {
  if (member(changeset, 'errors') === undefined) return [];
  const errors = structOf(changeset, 'errors');
  return Object.keys(errors).map((key) => [key, text(errors, key)] as const);
}

/**
 * The edit data of a strategies-content screen model: `rc.changeset` (the bean's values with `errors`),
 * `rc.hasPendingApprovals` (read only for an unpublished change set), `rc.categoryCount`, `rc.categories` (the site's
 * category rows) and the optional `rc.previewLink`.
 */
function changesetEditData(rc: Struct): ChangesetEditData {
  const changeset = structOf(rc, 'changeset');
  const published = cfToBoolean(member(changeset, 'published'));
  return {
    changeset: {
      changesetId: text(changeset, 'changesetID'),
      siteId: text(changeset, 'siteID'),
      name: text(changeset, 'name'),
      description: text(changeset, 'description'),
      closeDate: dateOf(changeset, 'closeDate'),
      publishDate: dateOf(changeset, 'publishDate'),
      lastUpdate: dateOf(changeset, 'lastUpdate'),
      published,
      isNew: cfToBoolean(member(changeset, 'isNew')),
      hasPendingApprovals: !published && cfToBoolean(member(rc, 'hasPendingApprovals')),
      tags: text(changeset, 'tags'),
      categoryId: text(changeset, 'categoryID'),
      errors: errorsOf(changeset),
    },
    categoryCount: cfToNumber(member(rc, 'categoryCount')),
    categories: categoryTree(rowsOf(rc, 'categories').map(categoryRow)),
    previewLink: member(rc, 'previewLink') === undefined ? undefined : text(rc, 'previewLink'),
  };
}

/** `rc.changesetID`, which the controller and view read unguarded. */
function rcChangesetIdOf(rc: Rc): string {
  const changesetId = rc.changesetID;
  if (changesetId === undefined) {
    throw new TypeError('Element CHANGESETID is undefined in a CFML structure referenced as part of an expression.');
  }
  return changesetId;
}

/**
 * Loads `changesetManager.read(rc.changesetID)` with the view's category and approval data, then the CSRF pair of the
 * change set. An empty id reads a fresh CF UUID, which no change set holds, so the service answers a new bean as legacy
 * does; `rc` is left unchanged. Gateway unavailability propagates.
 * @throws GatewayDenialError When strategies-content refuses the read (401 or 403).
 * @throws TypeError When `rc.changesetID` is absent or the screen model lacks a value the view reads.
 */
export async function loadChangesetEdit(ctx: ScreenContext): Promise<ChangesetEditData> {
  const requested = rcChangesetIdOf(ctx.req.rc);
  const response = await ctx.gateway.strategiesContent.call('get', '/v1/sites/{siteid}/changesets/{changesetid}', {
    params: { siteid: ctx.req.rc.siteid ?? '', changesetid: requested === '' ? cfUuid() : requested },
  });
  const data = changesetEditData(okBody(response, 'strategies-content', 'getChangeset').rc);
  await ctx.csrf.prefetch([data.changeset.changesetId]);
  return data;
}

/** `utility.displayErrors`: every message but `siteID`'s, unencoded and in struct order, spaced as ACF emits them. */
export function renderDisplayErrors(errors: ReadonlyArray<readonly [key: string, message: string]>): SafeHtml {
  return join(
    errors.flatMap(([key, message], index) =>
      // The `<br>` test counts every key, `siteID` included.
      key.toLowerCase() === 'siteid' ? [] : [raw(`${message} ${errors.length > index + 1 ? '<br> ' : ''}`)],
    ),
  );
}

/** `<option>`s `from`..`to` as cf_timeselector loops them, `selected` on `chosen`. */
function timeOptions(from: number, to: number, chosen: number, label: (n: number) => string): string {
  let out = '';
  for (let n = from; n <= to; n += 1) out += `<option value="${n}" ${n === chosen ? 'selected' : ''}>${label(n)}</option>`;
  return out;
}

/** The text a ColdFusion date value prints as: `{ts 'yyyy-mm-dd HH:nn:ss'}`. */
function cfDateString(date: Date): string {
  return `{ts '${cfDateTimeFormat(date, 'yyyy-mm-dd HH:nn:ss')}'}`;
}

/**
 * `<cf_datetimeselector>` with its nested `<cf_timeselector>`: the date field, the hour, minute and (for locales with
 * day parts) AM/PM selects, the hidden value and the change script.
 */
export function renderDateTimeSelector(args: DateTimeSelectorArgs, session: DateTimeSelectorSession): SafeHtml {
  const { name, datetime, defaultHour = 0, defaultMinute = 0, required = false, message = '' } = args;
  const { dateClass = '', dateSpanClass = 'span3' } = args;
  // `attributes.time` defaults before the 50-year rule clears `datetime`, so the selects keep the original time.
  const kept = datetime !== null && isMoreThanFiftyYearsAfter(datetime, session.now) ? null : datetime;
  const hour = datetime === null ? defaultHour : cfHour(datetime);
  const minute = datetime === null ? defaultMinute : cfMinute(datetime);
  const field = encodeHtmlAttr(name);
  const script = encodeJs(name);
  // The tag's empty class attributes leave one space, not two, in the legacy output.
  const dateClasses = ['datepicker', dateClass, dateSpanClass]
    .filter((c) => c !== '')
    .map(encodeHtmlAttr)
    .concat(`mura-datepicker${field}`)
    .join(' ');
  // legacy quirk: the tag clears the select names after deriving the select ids from them, so each posts as "".
  const attrs = `class="time mura-datepicker${field}" name=""`;
  const twoDigits = (n: number): string => String(n).padStart(2, '0');
  const minutes = `<select id="mura-${field}Minute" ${attrs}>${timeOptions(0, 59, minute, twoDigits)}</select>`;
  let selects: string;
  if (session.localeHasDayParts) {
    const clockHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const hours = `<select id="mura-${field}Hour" ${attrs}>${timeOptions(1, 12, clockHour, String)}</select>`;
    const pm = hour >= 12 ? 'selected' : '';
    const dayPart = `<select id="mura-${field}DayPart" ${attrs}><option value="AM">AM</option><option value="PM" ${pm}>PM</option></select>`;
    selects = `\n\t\t${hours}\n\t\n\n\t${minutes}\n\n\t\n\t\t${dayPart}\n\t\n`;
  } else {
    const hours = `<select  id="mura-${field}Hour" ${attrs}>${timeOptions(0, 23, hour, String)}</select>`;
    selects = `\n\t\t${hours}\n\t\n\n\t${minutes}\n\n\t\n`;
  }
  const hiddenValue = encodeHtmlAttr(kept === null ? '' : cfDateString(kept));
  return raw(
    [
      `\n<input type="text" autocomplete="off" class="${dateClasses}"`,
      ` value="${formatDateField(kept, session.dateKeyFormat, session.now)}" maxlength="12" id="mura-datepicker-${field}"/> `,
      selects,
      `<input type="hidden" id="mura-${field}" name="${field}" value="${hiddenValue}"`,
      // legacy quirk: the tag writes `data-required` twice, the second holding the message.
      ` data-required="${encodeHtmlAttr(String(required))}" data-required="${encodeHtmlAttr(message)}"/>\n`,
      `<script>\n\t$(function(){\n\t\t$('.mura-datepicker${script}').change(\n\t\t\tfunction(){\n`,
      `\t\t\t\tparseDateTimeSelector('${script}');\n\t\t\t}\n\t\t);\n\t});\n</script>\n`,
    ].join(''),
  );
}


/** The `tablist`/`tablabellist` pair: ids and labels as CFML lists, so a label holding `,` shifts the labels after it. */
function renderTabs(ctx: ScreenContext, hasCategories: boolean): SafeHtml {
  const tabs = hasCategories ? ['basic', 'categorization', 'tags'] : ['basic', 'tags'];
  const ids = tabs.map((tab) => `tab${tab.charAt(0).toUpperCase()}${tab.slice(1)}`);
  const labels = cfListToArray(tabs.map((tab) => ctx.rb.rbKey(`sitemanager.content.tabs.${tab}`)).join(','));
  return join(
    ids.map((id, index) => {
      const label = labels[index];
      if (label === undefined) {
        throw new RangeError(`Invalid list index ${index + 1}: the tab label list has ${labels.length} elements.`);
      }
      const active = index === 0 ? raw(' class="active"') : '';
      return html`\n        \n             <li${active}><a href="#${raw(id)}" onclick="return false;"><span>${raw(label)}</span></a></li>`;
    }),
  );
}

/** `LSDateFormat(date, session.dateKeyFormat) LSTimeFormat(date, 'medium')` under the session locale; ' ' for no date. */
function publishedDate(ctx: ScreenContext, date: Date | null): SafeHtml {
  if (date === null) return raw(' ');
  const { dateKeyFormat, locale } = ctx.req.session;
  return raw(`${cfLsDateFormat(date, dateKeyFormat, locale)} ${cfLsTimeFormat(date, 'medium', locale)}`);
}

/** One `<span class="tag">` per element of the change set's tag list. */
function renderTags(tags: string): SafeHtml {
  return join(
    cfListToArray(tags).map(
      (tag) => html`
                  <span class="tag">
                  ${raw(encodeHtml(tag))} <a><i class="mi-times-circle"></i></a>
                  <input name="tags" type="hidden" value="${raw(encodeHtmlAttr(tag))}">
                  </span>
                `,
    ),
  );
}

/** The Categorization pane of a site with categories, its tree checked against the change set's category ids. */
function renderCategorization(ctx: ScreenContext, data: ChangesetEditData): SafeHtml {
  const nest = renderCategoriesNest({ nodes: data.categories, categoryIds: data.changeset.categoryId, nestLevel: 0 });
  return html`
        <div id="tabCategorization" class="tab-pane">

          <div class="block block-bordered">
            <!-- block header -->
            <div class="block-header">
\t\t\t       <h3 class="block-title">Categories</h3>
            </div> <!-- /.block header -->
            <div class="block-content">

              <div class="mura-control-group">
\n              <label>${raw(ctx.rb.rbKey('changesets.categoryassignments'))}</label>
                <div id="mura-list-tree" class="mura-control justify">
                ${nest}
            </div>
          </div>
        </div>
      </div>

        </div> \n    `;
}

/** The form buttons: Add for a new change set, else Delete, Update and Publish Now or Roll Back by the change set's state. */
function renderActions(ctx: ScreenContext, data: ChangesetEditData, rcChangesetId: string): SafeHtml {
  const { changeset } = data;
  const label = (key: string): SafeHtml => raw(ctx.rb.rbKey(`changesets.${key}`));
  const id = raw(changeset.changesetId);
  const hiddenId = html`<input type=hidden name="changesetID" value="${id}">`;
  if (rcChangesetId === '') {
    return html`<button type="button" class="btn mura-primary" onclick="submitForm(document.forms.form1,'add');"><i class="mi-check-circle"></i>${label('add')}</button>
          ${hiddenId}`;
  }
  const csrfTokens = ctx.csrf.render(changeset.changesetId, 'url');
  const siteid = raw(encodeUrl(changeset.siteId));
  const confirmCall = (key: string, action: string): SafeHtml =>
    html`confirmDialog('${raw(encodeJs(ctx.rb.rbKey(`changesets.${key}`)))}','./?muraAction=cChangesets.${raw(action)}&changesetID=${id}&siteid=${siteid}${csrfTokens}')`;
  // Legacy puts the tokens on the publish URL as well, though `cChangesets.publish` never validates them.
  const publishNow =
    !changeset.published && !changeset.hasPendingApprovals
      ? html`\n            <button class="btn mura-primary" type="button" onclick="${confirmCall('publishnowconfirm', 'publish')}"><i class="mi-check-circle"></i> ${label('publishnow')}</button>\n          `
      : '';
  const rollback = changeset.published
    ? html`\n            <button class="btn" type="button" onclick="${confirmCall('rollbackconfirm', 'rollback')}"><i class="mi-history"></i> ${label('rollback')}</button>\n          `
    : '';
  return html`<button class="btn" type="button" onclick="${confirmCall('deleteconfirm', 'delete')}"><i class="mi-trash"></i> ${label('delete')}</button>
          <button class="btn" type="button" onclick="submitForm(document.forms.form1,'update');"><i class="mi-check-circle"></i>${label('update')}</button>
          ${publishNow}${rollback}
           ${hiddenId}`;
}

/**
 * The edit view body. `rcChangesetId` picks the Add or Edit heading and buttons; the secondary menu follows
 * `ctx.req.item`, so `cChangesets.save` gets an empty one.
 */
export function renderChangesetEditView(
  ctx: ScreenContext,
  data: ChangesetEditData,
  opts: ChangesetEditViewOptions = {},
): SafeHtml {
  const { req, rb } = ctx;
  const { changeset } = data;
  const rcChangesetId = opts.rcChangesetId ?? rcChangesetIdOf(req.rc);
  const label = (key: string): SafeHtml => raw(rb.rbKey(key));
  const attrLabel = (key: string): SafeHtml => raw(encodeHtmlAttr(rb.rbKey(key)));
  const session: DateTimeSelectorSession = {
    dateKeyFormat: req.session.dateKeyFormat,
    localeHasDayParts: req.session.localeHasDayParts,
    now: ctx.now,
  };
  const menu = renderChangesetsMenu(req, rb, {
    changesetId: changeset.changesetId,
    published: changeset.published,
    isNew: changeset.isNew,
    previewLink: data.previewLink,
  }).html;
  const errors =
    changeset.errors.length === 0
      ? ''
      : html`      <div class="alert alert-error"><span>${renderDisplayErrors(changeset.errors)}</span></div>\n`;
  let notice: SafeHtml | string = '';
  if (changeset.published) {
    notice = html`      <div class="alert alert-info"><span>${label('changesets.publishednotice')}</span></div>\n`;
  } else if (changeset.hasPendingApprovals) {
    notice = html`        <div class="alert alert-error"><span>${label('changesets.haspendingapprovals')}</span></div>\n`;
  }
  const hasCategories = data.categoryCount !== 0;
  const closeDate = changeset.published
    ? html`\n                ${publishedDate(ctx, changeset.closeDate ?? changeset.lastUpdate)}\n              \n`
    : renderDateTimeSelector({ name: 'closeDate', datetime: changeset.closeDate, defaultHour: 23, defaultMinute: 59 }, session);
  const publishDate = changeset.published
    ? html`\n          ${publishedDate(ctx, changeset.lastUpdate)}\n        \n`
    : renderDateTimeSelector({ name: 'publishDate', datetime: changeset.publishDate }, session);

  return html`
<div class="mura-header">
  <h1>${label(rcChangesetId === '' ? 'changesets.addchangeset' : 'changesets.editchangeset')}</h1>

  \n\t${menu}


</div> <!-- /.mura-header -->



${errors}${notice}      \n<div class="block block-constrain">
      \n      <ul class="mura-tabs nav-tabs" data-toggle="tabs">${renderTabs(ctx, hasCategories)}
        \n        </ul>

      <form novalidate="novalidate" action="./?muraAction=cChangesets.save&siteid=${raw(encodeUrl(req.rc.siteid ?? ''))}" method="post" name="form1" onsubmit="return validate(this);">

      <div class="block-content tab-content">
      <div id="tabBasic" class="tab-pane active">
        <div class="block block-bordered">
          <!-- block header -->
          <div class="block-header">
\t\t\t       <h3 class="block-title">Basic Settings</h3>
          </div> <!-- /.block header -->
          <div class="block-content">
          <div class="mura-control-group">
            <label>
          ${label('changesets.name')}
        </label>
            <input name="name" type="text" required="true" message="${label('changesets.titlerequired')}" value="${raw(encodeHtmlAttr(changeset.name))}" maxlength="50">
      </div>

          <div class="mura-control-group">
            <label>
          ${label('changesets.description')}
        </label>
            <textarea name="description" rows="6">${raw(encodeHtml(changeset.description))}</textarea>
      </div>

          <div class="mura-control-group">
            <label>
    <span data-toggle="popover" title="" data-placement="right"
      data-content="${attrLabel('tooltip.changesetclosedate')}"
      data-original-title="${attrLabel('changesets.closedate')}">${label('changesets.closedate')} <i class="mi-question-circle"></i></span>
          </label>
           ${closeDate}
        </div>

            <div class="mura-control-group">
              <label>
      <span data-toggle="popover" title="" data-placement="right"
        data-content="${attrLabel('tooltip.changesetpublishdate')}"
        data-original-title="${attrLabel('changesets.publishdate')}">
            ${label('changesets.publishdate')} <i class="mi-question-circle"></i></span>
          </label>
          ${publishDate}
            </div>

        </div>
      </div>
      </div> \n
      ${hasCategories ? renderCategorization(ctx, data) : ''}\n
      <div id="tabTags" class="tab-pane">

        <div class="block block-bordered">
          <!-- block header -->
          <div class="block-header">
\t\t\t       <h3 class="block-title">Tags</h3>
          </div> <!-- /.block header -->
          <div class="block-content">

        <div class="mura-control-group">
          <label>
          ${label('sitemanager.content.fields.tags')}
          </label>
          <input type="text" name="tags">
            <div id="tags" class="mura-control justify tagSelector">
              ${renderTags(changeset.tags)}
          </div>

          <script>
          $(document).ready(function(){
            $.get('?muraAction=cChangesets.loadtagarray&siteid=' + siteid).done(function(data){
            var tagArray=eval('(' + data + ')');
            $('#tags').tagSelector(tagArray, 'tags');
            });
          });
        </script>
      </div>
    </div>
  </div>
    </div> \n
  </div> \n  <div class="mura-actions">
      <div class="form-actions">
        \n          ${renderActions(ctx, data, rcChangesetId)}
        \n        <input type="hidden" name="action" value="">
        ${ctx.csrf.render(changeset.changesetId, 'form')}
      </div>
    </div>
  </form>

</div> <!-- /.block-constrain -->
`;
}

/** `cChangesets.edit` without the circuit gate, which `./index.ts` adds. */
export const changesetEditScreen: Omit<PageScreen<ChangesetEditData>, 'gate'> = Object.freeze({
  circuit: 'cchangesets',
  action: 'edit',
  mode: 'page',
  owner: 'strategies-content',
  load: loadChangesetEdit,
  render: (ctx: ScreenContext, data: ChangesetEditData): ShellView => ({ body: renderChangesetEditView(ctx, data) }),
});

