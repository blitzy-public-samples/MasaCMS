// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, join } from '@/lib/html';
import type { SafeHtml } from '@/lib/html';

/** Label text: a string is encoded, markup (a bundle label) is kept. */
export type Label = string | SafeHtml;

export type HeaderLink = { label: Label; href: string };

/** Grid cell content: markup is kept, strings and numbers are encoded, `null`/`undefined` render empty. */
export type GridCell = SafeHtml | string | number | null | undefined;

/** A labelled read-only value: `[label, value]`. */
export type ValueRow = readonly [label: Label, value: GridCell];

export type AlertKind = 'error' | 'warning' | 'info';

export type SelectOption = { value: string; label: Label };

/** A submit button; `formAction` sends the form to that URL instead of the form's own action. */
export type FormButton = { label: Label; primary?: boolean; name?: string; value?: string; formAction?: string };

/** A row action: a link with its legacy `mi-*` icon class. */
export type RowAction = { label: Label; href: string; icon: string };

const VAR_WIDTH = html` class="var-width"`;

const SHOW_ACTIONS = html`<a class="show-actions" href="javascript:;" onclick="showTableControls(this);"><i class="mi-ellipsis-v"></i></a>`;

const ALERT_CLASS: Readonly<Record<AlertKind, SafeHtml>> = {
  error: html` class="alert alert-error"`,
  warning: html` class="alert alert-warning"`,
  info: html` class="alert alert-info"`,
};

const PRIMARY_BUTTON = html` class="btn mura-primary"`;
const BUTTON = html` class="btn"`;

/** Module page header with an optional button group of links. */
export function pageHeader(title: Label, links: readonly HeaderLink[] = []): SafeHtml {
  const nav =
    links.length > 0
      ? html`<div class="nav-module-specific btn-group">${links.map(
          (link) => html`<a class="btn"${attr('href', link.href)}>${link.label}</a>`,
        )}</div>`
      : null;
  return html`<div class="mura-header"><h1>${title}</h1>${nav}</div>`;
}

/** Constrained, bordered content block wrapping `content`. */
export function block(content: SafeHtml): SafeHtml {
  return html`<div class="block block-constrain"><div class="block block-bordered"><div class="block-content">${content}</div></div></div>`;
}

/**
 * Grid table of `rows` under `headers`, or the empty-list message when there are no rows.
 * @param opts.varWidthColumn zero-based column whose header and cells take the variable width; default 0.
 * @param opts.columnClasses classes of each column's header and cells by column index, after `var-width`, such as
 *   legacy `hidden-xs`; `undefined` or `''` adds none.
 */
export function gridTable(
  headers: readonly Label[],
  rows: ReadonlyArray<readonly GridCell[]>,
  emptyMessage: Label,
  opts: { varWidthColumn?: number; columnClasses?: ReadonlyArray<string | undefined> } = {},
): SafeHtml {
  if (rows.length === 0) return html`<div class="help-block-empty">${emptyMessage}</div>`;
  const varWidthColumn = opts.varWidthColumn ?? 0;
  const classOf = (column: number): SafeHtml | null => {
    const extra = opts.columnClasses?.[column] || undefined;
    if (column !== varWidthColumn) return extra === undefined ? null : html` class="${extra}"`;
    return extra === undefined ? VAR_WIDTH : html` class="var-width ${extra}"`;
  };
  const head = headers.map((header, column) => html`<th${classOf(column)}>${header}</th>`);
  const body = rows.map(
    (row) => html`<tr>${row.map((cell, column) => html`<td${classOf(column)}>${cell}</td>`)}</tr>`,
  );
  return html`<table class="mura-table-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Legacy ⋮ row-actions cell content: the toggle legacy `showTableControls` opens and the hidden menu of `actions`.
 * Its grid column takes class `actions`, which that script looks for.
 */
export function rowActionsMenu(actions: readonly RowAction[]): SafeHtml {
  const items = actions.map(
    (action) => html`<li><a${attr('href', action.href)}><i class="${action.icon}"></i>${action.label}</a></li>`,
  );
  return html`${SHOW_ACTIONS}<div class="actions-menu hide"><ul class="actions-list">${items}</ul></div>`;
}

/** Alert box of the given kind. */
export function alertBox(message: string | SafeHtml, kind: AlertKind = 'error'): SafeHtml {
  return html`<div${ALERT_CLASS[kind]}><span>${message}</span></div>`;
}

/** Id of each control built by textInput, select or textarea, read by controlGroup. */
const CONTROL_IDS = new WeakMap<SafeHtml, string>();

/** Records `id` as the id of `control` and returns `control`. */
function withControlId(control: SafeHtml, id: string): SafeHtml {
  CONTROL_IDS.set(control, id);
  return control;
}

/** Labelled form control row whose label targets `controlId`, else the id textInput, select or textarea gave `control`. */
export function controlGroup(label: Label, control: SafeHtml, controlId?: string): SafeHtml {
  const target = controlId ?? CONTROL_IDS.get(control);
  return html`<div class="mura-control-group"><label${attr('for', target)}>${label}</label>${control}</div>`;
}

/** Read-only label and value rows, as legacy edit views show stored values, each value on a line of its own. */
export function valueRows(rows: readonly ValueRow[]): SafeHtml {
  return html`${rows.map(([label, value]) => controlGroup(label, html`<div>${value}</div>`))}`;
}

/** `items` in order with a rule between each, or the empty-list message when there are none. */
export function detailList(items: readonly SafeHtml[], emptyMessage: Label): SafeHtml {
  return items.length === 0 ? html`<div class="help-block-empty">${emptyMessage}</div>` : join(items, html`<hr>`);
}

/** Single-line input with id `opts.id`, default `name`; a `file` input carries no value. */
export function textInput(
  name: string,
  value = '',
  opts: { type?: 'text' | 'date' | 'number' | 'file'; maxlength?: number; required?: boolean; id?: string } = {},
): SafeHtml {
  const type = opts.type ?? 'text';
  const id = opts.id ?? name;
  return withControlId(
    html`<input${attr('name', name)}${attr('id', id)}${attr('type', type)}${attr(
      'value',
      type === 'file' ? null : value,
    )}${attr('maxlength', opts.maxlength)}${attr('required', opts.required === true ? 'true' : null)}>`,
    id,
  );
}

/** Drop-down list with id `opts.id`, default `name`, and the option whose value equals `selected` marked selected. */
export function select(
  name: string,
  options: readonly SelectOption[],
  selected?: string,
  opts: { id?: string } = {},
): SafeHtml {
  const id = opts.id ?? name;
  const items = options.map(
    (option) =>
      html`<option${attr('value', option.value)}${attr('selected', option.value === selected)}>${option.label}</option>`,
  );
  return withControlId(html`<select${attr('name', name)}${attr('id', id)}>${items}</select>`, id);
}

/** Multi-line text input with id `opts.id`, default `name`; `opts.readonly` shows a value without editing. */
export function textarea(name: string, value = '', rows = 6, opts: { id?: string; readonly?: boolean } = {}): SafeHtml {
  const id = opts.id ?? name;
  return withControlId(
    html`<textarea${attr('name', name)}${attr('id', id)}${attr('rows', rows)}${attr(
      'readonly',
      opts.readonly === true,
    )}>${value}</textarea>`,
    id,
  );
}

/** Hidden form field. */
export function hiddenField(name: string, value: string): SafeHtml {
  return html`<input type="hidden"${attr('name', name)}${attr('value', value)}>`;
}

/** One hidden field per entry of `values`, in entry order. */
export function hiddenFields(values: Readonly<Record<string, string>>): SafeHtml {
  return join(Object.entries(values).map(([name, value]) => hiddenField(name, value)));
}

/** One submit button: `btn`, or `btn mura-primary` when `button.primary`. */
export function submitButton(button: FormButton): SafeHtml {
  return html`<button${button.primary === true ? PRIMARY_BUTTON : BUTTON} type="submit"${attr('name', button.name)}${attr(
    'value',
    button.value,
  )}${attr('formaction', button.formAction)}>${button.label}</button>`;
}

/**
 * In-flow form action row of submit buttons followed by `hidden` fields; not a `.mura-actions` bar, which legacy
 * styles pin over the bottom of the page.
 */
export function formActions(buttons: readonly FormButton[], hidden?: SafeHtml): SafeHtml {
  return html`<div class="form-actions">${buttons.map(submitButton)}${hidden}</div>`;
}

/** POST form of `fields` with one primary submit button; `opts.hidden` carries CSRF fields and ids. */
export function postForm(
  actionUrl: string,
  fields: SafeHtml,
  submitLabel: Label,
  opts: { multipart?: boolean; hidden?: SafeHtml } = {},
): SafeHtml {
  const enctype = opts.multipart === true ? html` enctype="multipart/form-data"` : null;
  return html`<form novalidate="novalidate"${attr('action', actionUrl)} method="post"${enctype} name="form1">${fields}${formActions(
    [{ label: submitLabel, primary: true }],
    opts.hidden,
  )}</form>`;
}

/** One-button POST form carrying `hidden` fields and `extra` markup (CSRF fields). */
export function actionButton(
  label: Label,
  actionUrl: string,
  hidden: Readonly<Record<string, string>> = {},
  extra?: SafeHtml,
): SafeHtml {
  return html`<form method="post"${attr('action', actionUrl)}>${hiddenFields(hidden)}${extra}<button class="btn" type="submit">${label}</button></form>`;
}
