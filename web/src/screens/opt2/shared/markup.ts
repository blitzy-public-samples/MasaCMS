// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import { attr, html, join } from '@/lib/html';
import type { SafeHtml } from '@/lib/html';

export type HeaderLink = { label: string; href: string };

/** Grid cell content: markup is kept, strings and numbers are encoded, `null`/`undefined` render empty. */
export type GridCell = SafeHtml | string | number | null | undefined;

export type AlertKind = 'error' | 'warning' | 'info';

export type SelectOption = { value: string; label: string };

export type FormButton = { label: string; primary?: boolean; name?: string; value?: string };

const VAR_WIDTH = html` class="var-width"`;

const ALERT_CLASS: Readonly<Record<AlertKind, SafeHtml>> = {
  error: html` class="alert alert-error"`,
  warning: html` class="alert alert-warning"`,
  info: html` class="alert alert-info"`,
};

const PRIMARY_BUTTON = html` class="btn mura-primary"`;
const BUTTON = html` class="btn"`;

/** Module page header with an optional button group of links. */
export function pageHeader(title: string, links: readonly HeaderLink[] = []): SafeHtml {
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
 */
export function gridTable(
  headers: readonly string[],
  rows: ReadonlyArray<readonly GridCell[]>,
  emptyMessage: string,
  opts: { varWidthColumn?: number } = {},
): SafeHtml {
  if (rows.length === 0) return html`<div class="help-block-empty">${emptyMessage}</div>`;
  const varWidthColumn = opts.varWidthColumn ?? 0;
  const widthOf = (column: number): SafeHtml | null => (column === varWidthColumn ? VAR_WIDTH : null);
  const head = headers.map((header, column) => html`<th${widthOf(column)}>${header}</th>`);
  const body = rows.map(
    (row) => html`<tr>${row.map((cell, column) => html`<td${widthOf(column)}>${cell}</td>`)}</tr>`,
  );
  return html`<table class="mura-table-grid"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/** Alert box of the given kind. */
export function alertBox(message: string | SafeHtml, kind: AlertKind = 'error'): SafeHtml {
  return html`<div${ALERT_CLASS[kind]}><span>${message}</span></div>`;
}

/** Labelled form control row. */
export function controlGroup(label: string, control: SafeHtml): SafeHtml {
  return html`<div class="mura-control-group"><label>${label}</label>${control}</div>`;
}

/** Single-line input; a `file` input carries no value. */
export function textInput(
  name: string,
  value = '',
  opts: { type?: 'text' | 'date' | 'number' | 'file'; maxlength?: number; required?: boolean } = {},
): SafeHtml {
  const type = opts.type ?? 'text';
  return html`<input${attr('name', name)}${attr('type', type)}${attr('value', type === 'file' ? null : value)}${attr(
    'maxlength',
    opts.maxlength,
  )}${attr('required', opts.required === true ? 'true' : null)}>`;
}

/** Drop-down list with the option whose value equals `selected` marked selected. */
export function select(name: string, options: readonly SelectOption[], selected?: string): SafeHtml {
  const items = options.map(
    (option) =>
      html`<option${attr('value', option.value)}${attr('selected', option.value === selected)}>${option.label}</option>`,
  );
  return html`<select${attr('name', name)}>${items}</select>`;
}

/** Multi-line text input. */
export function textarea(name: string, value = '', rows = 6): SafeHtml {
  return html`<textarea${attr('name', name)}${attr('rows', rows)}>${value}</textarea>`;
}

/** Hidden form field. */
export function hiddenField(name: string, value: string): SafeHtml {
  return html`<input type="hidden"${attr('name', name)}${attr('value', value)}>`;
}

/** One hidden field per entry of `values`, in entry order. */
export function hiddenFields(values: Readonly<Record<string, string>>): SafeHtml {
  return join(Object.entries(values).map(([name, value]) => hiddenField(name, value)));
}

/** Form action bar of submit buttons followed by `hidden` fields. */
export function formActions(buttons: readonly FormButton[], hidden?: SafeHtml): SafeHtml {
  const items = buttons.map(
    (button) =>
      html`<button${button.primary === true ? PRIMARY_BUTTON : BUTTON} type="submit"${attr('name', button.name)}${attr(
        'value',
        button.value,
      )}>${button.label}</button>`,
  );
  return html`<div class="mura-actions"><div class="form-actions">${items}${hidden}</div></div>`;
}

/** POST form of `fields` with one primary submit button; `opts.hidden` carries CSRF fields and ids. */
export function postForm(
  actionUrl: string,
  fields: SafeHtml,
  submitLabel: string,
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
  label: string,
  actionUrl: string,
  hidden: Readonly<Record<string, string>> = {},
  extra?: SafeHtml,
): SafeHtml {
  return html`<form method="post"${attr('action', actionUrl)}>${hiddenFields(hidden)}${extra}<button class="btn" type="submit">${label}</button></form>`;
}
