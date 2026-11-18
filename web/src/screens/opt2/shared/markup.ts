// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, join } from '@/lib/html';
import type { SafeHtml } from '@/lib/html';

/** Label text: a string is encoded, markup (a bundle label) is kept. */
export type Label = string | SafeHtml;

/** A header button link; `active` marks the screen shown, as legacy secondary menus mark theirs. */
export type HeaderLink = { label: Label; href: string; active?: boolean };

/** Grid cell content: markup is kept, strings and numbers are encoded, `null`/`undefined` render empty. */
export type GridCell = SafeHtml | string | number | null | undefined;

/** A labelled read-only value: `[label, value]`. */
export type ValueRow = readonly [label: Label, value: GridCell];

export type AlertKind = 'error' | 'warning' | 'info';

export type SelectOption = { value: string; label: Label };

/** A submit button; `formAction` sends the form to that URL instead of the form's own action. */
export type FormButton = { label: Label; primary?: boolean; name?: string; value?: string; formAction?: string };

/** Why a refused write's value of one control fails: the message shown beside it; `focus` for the form's first one. */
export interface FieldError {
  readonly message: string;
  readonly focus: boolean;
}

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
const ACTIVE_BUTTON = html` class="btn active"`;

// A run breaks after 24 code points: 24 emoji, the widest common glyph (16.2px in a dd's 13px Inter UI), span 390px of
// the 470px narrowest dd. No-break spaces join a run; marks, skin tones, flags and ZWJ sequences stay with their base.
const UNBROKEN_RUN =
  /([\S\u00a0\u2007\u202f]{24}(?:[\p{M}\p{Emoji_Modifier}\p{RI}]|\u200d\S)*)(?<!\u200d)(?=[^\s\p{M}\p{Emoji_Modifier}\p{RI}\u200d]|[\u00a0\u2007\u202f])/u;

/** `onsubmit` of a write form: legacy `submitForm`, refused while its #action-modal marks a submission in flight. */
export const GUARDED_SUBMIT = html` onsubmit="return document.getElementById('action-modal') === null ? submitForm(this) : false;"`;

/** `onsubmit` of a write form whose buttons post to their own `formaction`: submitted natively under legacy `actionModal`. */
export const GUARDED_NATIVE_SUBMIT = html` onsubmit="if (document.getElementById('action-modal') !== null) return false; actionModal(); return true;"`;

/** Module page header with an optional button group of links. */
export function pageHeader(title: Label, links: readonly HeaderLink[] = []): SafeHtml {
  const nav =
    links.length > 0
      ? html`<div class="nav-module-specific btn-group">${links.map(
          (link) => html`<a${link.active === true ? ACTIVE_BUTTON : BUTTON}${attr('href', link.href)}>${link.label}</a>`,
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

/** What textInput, select or textarea built a control with, read by controlGroup: its id, refusal and hint. */
interface ControlInfo {
  readonly id: string;
  readonly error?: FieldError;
  readonly hint?: Label;
}

const CONTROLS = new WeakMap<SafeHtml, ControlInfo>();

/** Records `info` for `control` and returns `control`. */
function withControlId(control: SafeHtml, id: string, info: Omit<ControlInfo, 'id'> = {}): SafeHtml {
  CONTROLS.set(control, { id, ...info });
  return control;
}

const GROUP = html` class="mura-control-group"`;
const GROUP_WITH_ERROR = html` class="mura-control-group has-error"`;

/** Labelled row of `control` (label for `controlId` or its built id), marked `has-error` when refused. */
export function controlGroup(label: Label, control: SafeHtml, controlId?: string): SafeHtml {
  const info = CONTROLS.get(control);
  const target = controlId ?? info?.id;
  const error =
    info?.error === undefined ? null : html`<p class="help-block"${attr('id', `${info.id}-error`)}>${info.error.message}</p>`;
  const hint =
    info?.hint === undefined ? null : html`<div class="help-block-inline"${attr('id', `${info.id}-hint`)}>${info.hint}</div>`;
  return html`<div${error === null ? GROUP : GROUP_WITH_ERROR}><label${attr('for', target)}>${label}</label>${error}${control}${hint}</div>`;
}

/** `text` HTML-encoded, with a `<wbr>` after every 24 code points of an unbroken run, so it wraps in the narrowest box. */
export function wrappable(text: string): SafeHtml {
  return html`${text.split(UNBROKEN_RUN).map((part, index) => (index % 2 === 1 ? html`${part}<wbr>` : part))}`;
}

/** Read-only label and value pairs, one definition list each, as the legacy status modal shows stored values. */
export function valueRows(rows: readonly ValueRow[]): SafeHtml {
  return html`${rows.map(([label, value]) => html`<dl><dt>${label}</dt><dd>${value}</dd></dl>`)}`;
}

/** `items` in order with a rule between each, or the empty-list message when there are none. */
export function detailList(items: readonly SafeHtml[], emptyMessage: Label): SafeHtml {
  return items.length === 0 ? html`<div class="help-block-empty">${emptyMessage}</div>` : join(items, html`<hr>`);
}

/** Single-line input (id `opts.id`, default `name`) with legacy `data-label`, refusal `error`, standing `hint` and `focus`. */
export function textInput(
  name: string,
  value = '',
  opts: {
    type?: 'text' | 'date' | 'number' | 'file';
    maxlength?: number;
    required?: boolean;
    id?: string;
    label?: Label;
    error?: FieldError;
    hint?: Label;
    focus?: boolean;
  } = {},
): SafeHtml {
  const type = opts.type ?? 'text';
  const id = opts.id ?? name;
  // validateForm writes data-label into its alert as markup, so the attribute holds the label's markup.
  const dataLabel = opts.label === undefined ? null : html`${opts.label}`.value;
  const described = [opts.error === undefined ? '' : `${id}-error`, opts.hint === undefined ? '' : `${id}-hint`]
    .filter((ref) => ref !== '')
    .join(' ');
  return withControlId(
    html`<input${attr('name', name)}${attr('id', id)}${attr('type', type)}${attr(
      'value',
      type === 'file' ? null : value,
    )}${attr('maxlength', opts.maxlength)}${attr('required', opts.required === true ? 'true' : null)}${attr(
      'data-label',
      dataLabel,
    )}${attr('aria-invalid', opts.error === undefined ? null : 'true')}${attr('aria-describedby', described || null)}${attr(
      'autofocus',
      opts.error?.focus === true || opts.focus === true,
    )}>`,
    id,
    { error: opts.error, hint: opts.hint },
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

/** POST write form of `fields` with one primary submit button, sent once; `opts.hidden` carries CSRF fields and ids. */
export function postForm(
  actionUrl: string,
  fields: SafeHtml,
  submitLabel: Label,
  opts: { multipart?: boolean; hidden?: SafeHtml } = {},
): SafeHtml {
  const enctype = opts.multipart === true ? html` enctype="multipart/form-data"` : null;
  return html`<form novalidate="novalidate"${attr('action', actionUrl)} method="post"${enctype} name="form1"${GUARDED_SUBMIT}>${fields}${formActions(
    [{ label: submitLabel, primary: true }],
    opts.hidden,
  )}</form>`;
}

/** One-button POST form of `hidden` fields and `extra` markup, submitted once; `opts.download` submits natively. */
export function actionButton(
  label: Label,
  actionUrl: string,
  hidden: Readonly<Record<string, string>> = {},
  extra?: SafeHtml,
  opts: { download?: boolean } = {},
): SafeHtml {
  const onsubmit = opts.download === true ? null : GUARDED_SUBMIT;
  return html`<form method="post"${attr('action', actionUrl)}${onsubmit}>${hiddenFields(hidden)}${extra}<button class="btn" type="submit">${label}</button></form>`;
}
