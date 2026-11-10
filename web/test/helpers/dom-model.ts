import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';

/** One `<option>` of a select: its value (the text when the attribute is absent), text and `selected` flag. */
export interface DomOption {
  value: string;
  label: string;
  selected: boolean;
}

/** A form control; `type` follows the DOM: `text` for a typeless input, `select-one`/`select-multiple`, `textarea`. */
export interface DomControl {
  tag: 'input' | 'select' | 'textarea';
  name: string;
  type: string;
  value: string;
  checked: boolean;
  selected: string[];
  options: DomOption[];
}

/** A `<button>` (typeless means `submit`) or an `input` of type submit, button or reset. */
export interface DomButton {
  text: string;
  type: string;
  hasOnclick: boolean;
}

/** An `a[href]`, with the href passed through {@link normaliseAdminUrl}. */
export interface DomLink {
  href: string;
  text: string;
}

/** A table's header texts and the cell texts of its other rows. */
export interface DomTable {
  headers: string[];
  rows: string[][];
}

/** An element whose class list contains `alert`. */
export interface DomAlert {
  text: string;
  className: string;
}

/** The parts of an admin page the parity comparison looks at, each list in document order. */
export interface DomModel {
  title: string;
  headings: string[];
  labels: string[];
  controls: DomControl[];
  buttons: DomButton[];
  links: DomLink[];
  tables: DomTable[];
  alerts: DomAlert[];
}

/** cheerio's element selection, derived so `domhandler` need not be a direct dependency. */
type Selection = ReturnType<ReturnType<CheerioAPI['root']>['find']>;

const BUTTON_INPUT_TYPES = new Set(['submit', 'button', 'reset']);
const MURA_ACTION = 'muraAction';
const TOKEN = '<token>';
// The platform's isCfUuid is anchored, so scanning needs its own pattern; hex look-arounds keep it to whole ids.
const CF_UUID = /(?<![0-9A-F])[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}(?![0-9A-F])/gi;
const URL_TOKEN_PARAMS = /([?&])(csrf_token|csrf_token_expires|access_token|refresh_token|authToken|returnID)=[^&#]*/gi;
const CSRF_FIELDS = new Set([CSRF_FIELD_TOKEN.toLowerCase(), CSRF_FIELD_EXPIRES.toLowerCase()]);

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const textOf = (sel: Selection): string => collapse(sel.text());
// A selector test, because cheerio's attr('value') on an option answers its text even without the attribute.
const hasAttr = (sel: Selection, name: string): boolean => sel.is(`[${name}]`);
// An empty or missing type attribute is the element's default type, as in the DOM.
const typeOf = (sel: Selection, fallback: string): string => (sel.attr('type') || fallback).toLowerCase();
const isButtonInput = (sel: Selection): boolean => sel.is('input') && BUTTON_INPUT_TYPES.has(typeOf(sel, 'text'));
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function control($: CheerioAPI, sel: Selection): DomControl {
  const name = sel.attr('name') ?? '';
  if (sel.is('select')) {
    const options = sel
      .find('option')
      .toArray()
      .map((el): DomOption => {
        const option = $(el);
        const label = textOf(option);
        const value = hasAttr(option, 'value') ? (option.attr('value') ?? '') : label;
        return { value, label, selected: hasAttr(option, 'selected') };
      });
    const selected = options.filter((o) => o.selected).map((o) => o.value);
    const type = hasAttr(sel, 'multiple') ? 'select-multiple' : 'select-one';
    return { tag: 'select', name, type, value: selected[0] ?? '', checked: false, selected, options };
  }
  if (sel.is('textarea')) {
    // A textarea's value is its raw content; whitespace in it is data, not layout.
    return { tag: 'textarea', name, type: 'textarea', value: sel.text(), checked: false, selected: [], options: [] };
  }
  const value = sel.attr('value') ?? '';
  return { tag: 'input', name, type: typeOf(sel, 'text'), value, checked: hasAttr(sel, 'checked'), selected: [], options: [] };
}

function button(sel: Selection): DomButton {
  const text = sel.is('input') ? collapse(sel.attr('value') ?? '') : textOf(sel);
  return { text, type: typeOf(sel, 'submit'), hasOnclick: hasAttr(sel, 'onclick') };
}

function table($: CheerioAPI, sel: Selection): DomTable {
  const own = sel
    .find('tr')
    .toArray()
    .filter((tr) => $(tr).closest('table')[0] === sel[0])
    .map((tr) => $(tr));
  const cells = (tr: Selection): string[] => tr.children('td, th').toArray().map((cell) => textOf($(cell)));
  const inHead = (tr: Selection): boolean => tr.parent().is('thead');
  let head = own.filter(inHead);
  let body = own.filter((tr) => !inHead(tr));
  const first = own[0];
  if (head.length === 0 && first !== undefined) {
    const firstCells = first.children('td, th');
    if (firstCells.length > 0 && firstCells.filter('th').length === firstCells.length) {
      head = [first];
      body = own.slice(1);
    }
  }
  // Header rows keep any td cells too, so no header text drops out of the model.
  return { headers: head.flatMap(cells), rows: body.map(cells) };
}

function extract($: CheerioAPI, title: string): DomModel {
  const all = (selector: string): Selection[] =>
    $.root()
      .find(selector)
      .toArray()
      .map((el) => $(el));
  return {
    title,
    headings: all('h1, h2, h3, h4').map(textOf),
    labels: all('label').map(textOf),
    controls: all('input, select, textarea')
      .filter((sel) => !isButtonInput(sel))
      .map((sel) => control($, sel)),
    buttons: all('button, input')
      .filter((sel) => sel.is('button') || isButtonInput(sel))
      .map(button),
    links: all('a[href]').map((sel) => ({ href: normaliseAdminUrl(sel.attr('href') ?? ''), text: textOf(sel) })),
    tables: all('table').map((sel) => table($, sel)),
    alerts: all('.alert').map((sel) => ({ text: textOf(sel), className: collapse(sel.attr('class') ?? '') })),
  };
}

/** Model of a full admin page, parsed in document mode. */
export function domModel(html: string): DomModel {
  const $ = cheerio.load(html);
  return extract($, textOf($('title').first()));
}

/** Model of a bare fragment (`carch.loaddiff`, HTML carried in JSON); no document is synthesised and the title is empty. */
export function fragmentModel(html: string): DomModel {
  return extract(cheerio.load(html, null, false), '');
}

/** Canonical `muraAction` href: action first, lower-cased, other parameters sorted by name; other hrefs unchanged. */
export function normaliseAdminUrl(href: string): string {
  if (/^\s*javascript:/i.test(href)) return href;
  const hashAt = href.indexOf('#');
  const base = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = base.indexOf('?');
  if (queryAt < 0) return href;
  const params = [...new URLSearchParams(base.slice(queryAt + 1))];
  // CFML's URL scope is case-insensitive, so `muraaction` names the same parameter.
  const isAction = ([name]: [string, string]): boolean => name.toLowerCase() === MURA_ACTION.toLowerCase();
  const actions = params.filter(isAction).map(([, value]): [string, string] => [MURA_ACTION, value.toLowerCase()]);
  if (actions.length === 0) return href;
  const rest = params.filter((p) => !isAction(p)).sort(([a], [b]) => byCodeUnit(a.toLowerCase(), b.toLowerCase()));
  const fragment = hashAt < 0 ? '' : href.slice(hashAt);
  return `${base.slice(0, queryAt)}?${new URLSearchParams([...actions, ...rest]).toString()}${fragment}`;
}

/** Deep copy with CF UUIDs as `<id:N>` (by first appearance in field order) and CSRF and token values as `<token>`. */
export function normaliseIds(model: DomModel): DomModel {
  const ids = new Map<string, string>();
  const mask = (s: string): string =>
    s.replace(CF_UUID, (id) => {
      const key = id.toUpperCase();
      const known = ids.get(key);
      if (known !== undefined) return known;
      const placeholder = `<id:${ids.size + 1}>`;
      ids.set(key, placeholder);
      return placeholder;
    });
  // Property initialisers run in source order, which fixes the numbering order.
  return {
    title: mask(model.title),
    headings: model.headings.map(mask),
    labels: model.labels.map(mask),
    controls: model.controls.map((c) => ({
      tag: c.tag,
      name: mask(c.name),
      type: mask(c.type),
      value: CSRF_FIELDS.has(c.name.toLowerCase()) ? TOKEN : mask(c.value),
      checked: c.checked,
      selected: c.selected.map(mask),
      options: c.options.map((o) => ({ value: mask(o.value), label: mask(o.label), selected: o.selected })),
    })),
    buttons: model.buttons.map((b) => ({ text: mask(b.text), type: mask(b.type), hasOnclick: b.hasOnclick })),
    links: model.links.map((l) => ({ href: mask(l.href.replace(URL_TOKEN_PARAMS, `$1$2=${TOKEN}`)), text: mask(l.text) })),
    tables: model.tables.map((t) => ({ headers: t.headers.map(mask), rows: t.rows.map((row) => row.map(mask)) })),
    alerts: model.alerts.map((a) => ({ text: mask(a.text), className: mask(a.className) })),
  };
}
