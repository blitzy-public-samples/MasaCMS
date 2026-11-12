// Admin HTML DOM model of the golden normaliser: what a page shows and submits, with ids, tokens and URLs normalised.
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, parseAdminUrl } from '@opt2/platform/legacy-compat';
import type { IdOrdinals } from './ids.js';
import type { KnownIssueMask, MaskLocation } from './masks.js';
import type { KnownIssueId, NormaliseRules } from './rules.js';
import { normaliseText, normaliseUrl, normaliseValue } from './values.js';

/** A heading `h1`…`h6`: its level and text. */
export interface DomHeading {
  level: number;
  text: string;
}

/** A `<label>`: its `for` attribute and text. */
export interface DomLabel {
  for?: string;
  text: string;
}

/** A `<form>`; `action` passes through {@link canonicalAdminUrl}, `method` is lower-case and defaults to `get`. */
export interface DomForm {
  id?: string;
  name?: string;
  action?: string;
  method: string;
}

/** One `<option>`: its value (the label when the attribute is absent), label text and `selected` attribute. */
export interface DomOption {
  value: string;
  label: string;
  selected: boolean;
}

/**
 * An `input`, `select` or `textarea`; `form` indexes {@link DomModel.forms}, `type` is lower-case (`select` and
 * `textarea` for those), `checked` is set for checkboxes and radios only.
 */
export interface DomControl {
  form?: number;
  name?: string;
  type: string;
  value?: string;
  options?: DomOption[];
  checked?: boolean;
  disabled: boolean;
}

/** An `a[href]`, its `href` passed through {@link canonicalAdminUrl}. */
export interface DomLink {
  text: string;
  href?: string;
}

/** A table's header-row cell texts, and the cell texts of each row that holds a `td`. */
export interface DomTable {
  headers: string[];
  rows: string[][];
}

/** An alert; `kind` is its `alert-*` class, e.g. `alert-error`. */
export interface DomAlert {
  kind: string;
  text: string;
}

/** A text component known-issue mask `mask` lifted out of model text field `path`, which shows its placeholder. */
export interface DomMaskedText {
  mask: KnownIssueId;
  path: string;
  text: string;
}

/** The parts of an admin page the parity comparison looks at, each list in document order. */
export interface DomModel {
  title: string;
  headings: DomHeading[];
  labels: DomLabel[];
  forms: DomForm[];
  controls: DomControl[];
  buttons: string[];
  links: DomLink[];
  tables: DomTable[];
  alerts: DomAlert[];
  /** Lifted text components, in mask, location and document order. */
  maskedText: DomMaskedText[];
}

/**
 * A DOM model plus the model paths (`controls[12].checked`, `forms[0].action`, `maskedText[0]`, …) its known-issue
 * masks cover.
 */
export interface DomModelResult {
  model: DomModel;
  maskedPaths: Record<string, KnownIssueId>;
}

/** Inputs of {@link domModel}: the scenario's id ordinals, the rules and the masks of the step. */
export interface DomModelOptions {
  state: IdOrdinals;
  rules: NormaliseRules;
  masks?: readonly KnownIssueMask[];
}

// cheerio's element types, derived so `domhandler` need not be a direct dependency.
type Selection = ReturnType<ReturnType<CheerioAPI['root']>['find']>;
type Element = Selection[number];
type AnyNode = ReturnType<Selection['closest']>[number];
type TextNode = Extract<AnyNode, { nodeType: 3 }>;
type DomLocation = Extract<MaskLocation, { kind: 'dom' }>;

/** A model entry an element produced, with the fields known-issue masks and lifted text address. */
interface Produced {
  path: string;
  textPath?: string;
  valuePath?: string;
  /** Object entries have fields that mask `attributes` can address. */
  object: boolean;
  /** Entries holding the text of the element's descendants; masks and lifted text of those fall back to them. */
  carriesText: boolean;
}

interface Context {
  $: CheerioAPI;
  state: IdOrdinals;
  rules: NormaliseRules;
  produced: Map<AnyNode, Produced[]>;
}

/** An element a DOM mask location selects, with its `textPattern` hits read before any text is lifted. */
interface Target {
  el: Element;
  textHit: boolean;
  valueHit: boolean;
}

/** A DOM mask location of a mask that applies to the DOM model, and its targets. */
interface Selected {
  mask: KnownIssueId;
  location: DomLocation;
  targets: Target[];
}

/** A text component lifted out of the page: its mask, raw text and the element whose text node holds its start. */
interface Lifted {
  mask: KnownIssueId;
  parent: AnyNode;
  raw: string;
}

const ALWAYS_EXCLUDED = ['script', 'style', 'noscript'];
// Pseudo-selector of `dom.exclude` for comment nodes, which CSS selectors cannot reach.
const COMMENT_EXCLUSION = 'comment()';
const COMMENT_NODE = 8;
const TEXT_NODE = 3;
// Placeholders an earlier lift left; split out so later patterns never match inside them.
const LIFTED_PLACEHOLDER = /(<known-issue:[^<>]*>)/;
// CFML form and URL scopes read names case-insensitively.
const CSRF_NAMES: ReadonlySet<string> = new Set([CSRF_FIELD_TOKEN, CSRF_FIELD_EXPIRES].map((name) => name.toLowerCase()));
const CHECKABLE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio']);
// The header search action is `#` (admin/common/layouts/includes/header.cfm:162); such values are not URLs to rewrite.
const VERBATIM_URL = /^\s*(?:#|javascript:|$)/i;

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const isCsrfName = (name: string | undefined): boolean => name !== undefined && CSRF_NAMES.has(name.toLowerCase());
const matches = (pattern: RegExp, s: string): boolean => s.search(pattern) >= 0;
const isTextNode = (node: AnyNode): node is TextNode => node.nodeType === TEXT_NODE;
// A text location's matches are lifted out of the text rather than masking the fields that hold them.
const isTextLocation = (location: DomLocation): boolean =>
  location.textPattern !== undefined && location.attributes === undefined;

/** Placeholder that known-issue mask `id` leaves in model text where it lifted a text component out. */
export function maskedTextPlaceholder(id: KnownIssueId): string {
  return `<known-issue:${id}>`;
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {
    return raw;
  }
}

/**
 * Query of `url` with `&amp;` read as `&`, non-empty CSRF values as the token placeholder, `muraAction`/`fuseaction`
 * values lower-cased, and parameters stably sorted by name unless `dom.actionUrl.keepParamOrder` is set.
 */
function canonicalQuery(url: string, rules: NormaliseRules): string {
  const hash = url.indexOf('#');
  const head = hash < 0 ? url : url.slice(0, hash);
  const q = head.indexOf('?');
  if (q < 0) return url;
  const { actionUrl } = rules.dom;
  const fold = actionUrl.paramNames === 'case-insensitive' ? (s: string) => s.toLowerCase() : (s: string) => s;
  const actionNames = new Set(actionUrl.lowerCaseValuesOf.map(fold));
  const params = head
    .slice(q + 1)
    .replaceAll('&amp;', '&')
    .split('&')
    .filter((param) => param !== '')
    .map((param) => {
      const eq = param.indexOf('=');
      const rawName = eq < 0 ? param : param.slice(0, eq);
      const value = eq < 0 ? '' : param.slice(eq + 1);
      const name = decodeName(rawName);
      const key = fold(name);
      if (value !== '' && isCsrfName(name)) return { key, text: `${rawName}=${rules.tokens.placeholder}` };
      if (value !== '' && actionNames.has(key)) return { key, text: `${rawName}=${value.toLowerCase()}` };
      return { key, text: param };
    });
  // Sorting is the rules' choice: normalise.yaml sets keepParamOrder, so a reordered legacy query stays a difference.
  if (!actionUrl.keepParamOrder) params.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return `${head.slice(0, q + 1)}${params.map((param) => param.text).join('&')}${hash < 0 ? '' : url.slice(hash)}`;
}

/**
 * Admin URL `url` normalised: one carrying `muraAction`/`fuseaction` goes through {@link normaliseUrl} with its query
 * made canonical before and after (so id ordinals follow the canonical order); any other URL through
 * {@link normaliseUrl} only. Empty, `#…` and `javascript:` values are returned verbatim.
 */
export function canonicalAdminUrl(url: string, state: IdOrdinals, rules: NormaliseRules): string {
  if (VERBATIM_URL.test(url)) return url;
  if (parseAdminUrl(url) === undefined) return normaliseUrl(url, state, rules);
  return canonicalQuery(normaliseUrl(canonicalQuery(url, rules), state, rules), rules);
}

function textOf(ctx: Context, raw: string): string {
  const s = ctx.rules.dom.whitespace === 'collapse-and-trim' ? collapse(raw) : raw;
  return normaliseText(s, ctx.state, ctx.rules);
}

function valueOf(ctx: Context, raw: string, key: string | undefined): string {
  return String(normaliseValue(raw, ctx.state, ctx.rules, key));
}

function select(ctx: Context, selector: string): Element[] {
  return ctx.$.root().find(selector).toArray();
}

function produce(ctx: Context, el: Element, entry: Produced): void {
  const list = ctx.produced.get(el);
  if (list === undefined) ctx.produced.set(el, [entry]);
  else list.push(entry);
}

function removeExcluded($: CheerioAPI, rules: NormaliseRules): void {
  for (const selector of new Set([...ALWAYS_EXCLUDED, ...rules.dom.exclude])) {
    if (selector === COMMENT_EXCLUSION) {
      $.root()
        .find('*')
        .addBack()
        .contents()
        .filter((_, node) => node.nodeType === COMMENT_NODE)
        .remove();
    } else {
      $.root().find(selector).remove();
    }
  }
}

function titleOf(ctx: Context): string {
  const el = select(ctx, ctx.rules.dom.extract.title.selector)[0];
  if (el === undefined) return '';
  produce(ctx, el, { path: 'title', object: false, carriesText: true });
  return textOf(ctx, ctx.$(el).text());
}

function headingsOf(ctx: Context): DomHeading[] {
  return select(ctx, ctx.rules.dom.extract.headings.selector).map((el, i) => {
    const path = `headings[${i}]`;
    produce(ctx, el, { path, textPath: `${path}.text`, object: true, carriesText: true });
    return { level: Number(el.tagName.slice(1)), text: textOf(ctx, ctx.$(el).text()) };
  });
}

function labelsOf(ctx: Context): DomLabel[] {
  return select(ctx, ctx.rules.dom.extract.labels.selector).map((el, i) => {
    const path = `labels[${i}]`;
    produce(ctx, el, { path, textPath: `${path}.text`, object: true, carriesText: true });
    const label = ctx.$(el);
    const htmlFor = label.attr('for');
    const text = textOf(ctx, label.text());
    return htmlFor === undefined ? { text } : { for: normaliseText(htmlFor, ctx.state, ctx.rules), text };
  });
}

/** Forms with their element index and id index, which controls resolve their owner form through. */
interface FormIndex {
  forms: DomForm[];
  byElement: Map<AnyNode, number>;
  byId: Map<string, number>;
}

function formsOf(ctx: Context): FormIndex {
  const index: FormIndex = { forms: [], byElement: new Map(), byId: new Map() };
  for (const el of select(ctx, ctx.rules.dom.extract.forms.selector)) {
    const i = index.forms.length;
    const sel = ctx.$(el);
    const id = sel.attr('id');
    const name = sel.attr('name');
    const action = sel.attr('action');
    const form: DomForm = { method: (sel.attr('method') || 'get').toLowerCase() };
    if (id !== undefined) form.id = normaliseText(id, ctx.state, ctx.rules);
    if (name !== undefined) form.name = normaliseText(name, ctx.state, ctx.rules);
    if (action !== undefined) form.action = canonicalAdminUrl(action, ctx.state, ctx.rules);
    index.forms.push(form);
    index.byElement.set(el, i);
    if (id !== undefined && !index.byId.has(id)) index.byId.set(id, i);
    produce(ctx, el, { path: `forms[${i}]`, object: true, carriesText: false });
  }
  return index;
}

// The owner form: the one the `form` attribute names, else the enclosing one.
function formOf(ctx: Context, el: Element, index: FormIndex): number | undefined {
  const owner = ctx.$(el).attr('form');
  if (owner !== undefined) return index.byId.get(owner);
  const enclosing = ctx.$(el).closest('form')[0];
  return enclosing === undefined ? undefined : index.byElement.get(enclosing);
}

// Raw value as submitted: an input's value attribute, a textarea's content, an option's value or else its text.
function rawValueOf(ctx: Context, el: Element): string | undefined {
  const sel = ctx.$(el);
  switch (el.tagName) {
    case 'textarea':
      return sel.text();
    case 'option':
      // cheerio answers attr('value') of an option with its text even without the attribute.
      return sel.is('[value]') ? (sel.attr('value') ?? '') : collapse(sel.text());
    case 'select':
      return undefined;
    default:
      return sel.attr('value');
  }
}

function optionsOf(ctx: Context, el: Element, path: string, key: string | undefined): DomOption[] {
  const selector = ctx.rules.dom.extract.controls.options?.selector ?? 'option';
  return ctx
    .$(el)
    .find(selector)
    .toArray()
    .map((option, j) => {
      const optionPath = `${path}.options[${j}]`;
      produce(ctx, option, {
        path: optionPath,
        textPath: `${optionPath}.label`,
        valuePath: `${optionPath}.value`,
        object: true,
        carriesText: true,
      });
      const sel = ctx.$(option);
      const label = textOf(ctx, sel.text());
      const value = sel.is('[value]') ? valueOf(ctx, sel.attr('value') ?? '', key) : label;
      return { value, label, selected: sel.is('[selected]') };
    });
}

function controlsOf(ctx: Context, index: FormIndex): DomControl[] {
  const rule = ctx.rules.dom.extract.controls;
  const tokenInputs = ctx.rules.tokens.htmlInputs.join(',');
  return select(ctx, rule.selector).map((el, i) => {
    const path = `controls[${i}]`;
    const valuePath = `${path}.value`;
    const tag = el.tagName;
    // A textarea's value is its text.
    const textarea = tag === 'textarea';
    produce(ctx, el, {
      path,
      valuePath,
      ...(textarea ? { textPath: valuePath } : {}),
      object: true,
      carriesText: textarea,
    });
    const sel = ctx.$(el);
    const type = tag === 'select' || tag === 'textarea' ? tag : (sel.attr('type') || 'text').toLowerCase();
    const rawName = sel.attr('name');
    const control: DomControl = { type, disabled: sel.is('[disabled]') };
    const form = formOf(ctx, el, index);
    if (form !== undefined) control.form = form;
    if (rawName !== undefined) control.name = normaliseText(rawName, ctx.state, ctx.rules);
    const raw = rawValueOf(ctx, el);
    const omitted = Object.entries(rule.omitValueWhen ?? {}).some(
      ([attr, when]) => (attr === 'type' ? type : sel.attr(attr)) === when,
    );
    if (raw !== undefined && !omitted) {
      const token = raw !== '' && (isCsrfName(rawName) || (tokenInputs !== '' && sel.is(tokenInputs)));
      control.value = token ? ctx.rules.tokens.placeholder : valueOf(ctx, raw, rawName);
    }
    if (tag === 'select') control.options = optionsOf(ctx, el, path, rawName);
    if (CHECKABLE_TYPES.has(type)) control.checked = sel.is('[checked]');
    return control;
  });
}

function buttonsOf(ctx: Context): string[] {
  return select(ctx, ctx.rules.dom.extract.buttons.selector).map((el, i) => {
    const path = `buttons[${i}]`;
    const input = el.tagName === 'input';
    // An input button's text is its value attribute.
    produce(ctx, el, { path, ...(input ? { valuePath: path } : {}), object: false, carriesText: true });
    const sel = ctx.$(el);
    return textOf(ctx, input ? (sel.attr('value') ?? '') : sel.text());
  });
}

function linksOf(ctx: Context): DomLink[] {
  return select(ctx, ctx.rules.dom.extract.links.selector).map((el, i) => {
    const path = `links[${i}]`;
    produce(ctx, el, { path, textPath: `${path}.text`, object: true, carriesText: true });
    const sel = ctx.$(el);
    const href = sel.attr('href');
    const canonical = href === undefined ? undefined : canonicalAdminUrl(href, ctx.state, ctx.rules);
    const text = textOf(ctx, sel.text());
    return canonical === undefined ? { text } : { text, href: canonical };
  });
}

// Rows of nested tables belong to those tables; a row whose cells hold no `td` is a header row.
function tablesOf(ctx: Context): DomTable[] {
  const rule = ctx.rules.dom.extract.tables;
  const rowSelector = rule.rows ?? 'tr';
  const cellSelector = rule.cells ?? 'th,td';
  return select(ctx, rule.selector).map((table, t) => {
    const path = `tables[${t}]`;
    produce(ctx, table, { path, object: true, carriesText: false });
    const headers: string[] = [];
    const rows: string[][] = [];
    const own = ctx
      .$(table)
      .find(rowSelector)
      .toArray()
      .filter((tr) => ctx.$(tr).closest(rule.selector)[0] === table);
    for (const tr of own) {
      const cells = ctx.$(tr).children(cellSelector).toArray();
      if (cells.length === 0) continue;
      if (cells.some((cell) => cell.tagName === 'td')) {
        const r = rows.length;
        rows.push(
          cells.map((cell, c) => {
            produce(ctx, cell, { path: `${path}.rows[${r}][${c}]`, object: false, carriesText: true });
            return textOf(ctx, ctx.$(cell).text());
          }),
        );
      } else {
        for (const cell of cells) {
          produce(ctx, cell, { path: `${path}.headers[${headers.length}]`, object: false, carriesText: true });
          headers.push(textOf(ctx, ctx.$(cell).text()));
        }
      }
    }
    return { headers, rows };
  });
}

// `kind` is the first `alert-*` class; an alert without one is `alert`, other matches their sorted class list.
function alertKind(classAttr: string | undefined): string {
  const classes = (classAttr ?? '').split(/\s+/).filter((name) => name !== '');
  return (
    classes.find((name) => name.startsWith('alert-')) ??
    (classes.includes('alert') ? 'alert' : [...classes].sort().join(' '))
  );
}

function alertsOf(ctx: Context): DomAlert[] {
  return select(ctx, ctx.rules.dom.extract.alerts.selector).map((el, i) => {
    const path = `alerts[${i}]`;
    produce(ctx, el, { path, textPath: `${path}.text`, object: true, carriesText: true });
    const sel = ctx.$(el);
    return { kind: alertKind(sel.attr('class')), text: textOf(ctx, sel.text()) };
  });
}

// Nearest ancestor entries that hold the node's text, for nodes that produce no entry of their own.
function textCarriersOf(ctx: Context, node: AnyNode): Produced[] {
  for (const parent of ctx.$(node).parents().toArray()) {
    const carriers = (ctx.produced.get(parent) ?? []).filter((entry) => entry.carriesText);
    if (carriers.length > 0) return carriers;
  }
  return [];
}

// A text location hits on the element's own `value` attribute only; others on its text or raw value, as served.
function targetOf(ctx: Context, el: Element, location: DomLocation): Target {
  const pattern = location.textPattern;
  if (pattern === undefined) return { el, textHit: false, valueHit: false };
  if (isTextLocation(location)) {
    const value = el.attribs['value'];
    return { el, textHit: false, valueHit: value !== undefined && matches(pattern, value) };
  }
  const raw = rawValueOf(ctx, el);
  return {
    el,
    textHit: matches(pattern, collapse(ctx.$(el).text())),
    valueHit: raw !== undefined && matches(pattern, raw),
  };
}

// Masks limited to other compare kinds do not apply to the DOM model.
function selectLocations(ctx: Context, masks: readonly KnownIssueMask[]): Selected[] {
  return masks
    .filter((mask) => mask.compareKinds === undefined || mask.compareKinds.includes('dom'))
    .flatMap((mask) =>
      mask.locations.flatMap((location): Selected[] => {
        if (location.kind !== 'dom') return [];
        const targets = select(ctx, location.selector).map((el) => targetOf(ctx, el, location));
        return [{ mask: mask.id, location, targets }];
      }),
    );
}

function textNodesOf(node: AnyNode, out: TextNode[] = []): TextNode[] {
  if (isTextNode(node)) out.push(node);
  else if ('children' in node) for (const child of node.children) textNodesOf(child, out);
  return out;
}

// `[start, end)` offsets of the non-empty matches of `global` in `text`, outside earlier lifts' placeholders.
function matchSpans(text: string, global: RegExp): [number, number][] {
  const spans: [number, number][] = [];
  let offset = 0;
  text.split(LIFTED_PLACEHOLDER).forEach((part, i) => {
    if (i % 2 === 0) {
      for (const { 0: match, index } of part.matchAll(global)) {
        if (match !== '') spans.push([offset + index, offset + index + match.length]);
      }
    }
    offset += part.length;
  });
  return spans;
}

/**
 * Replaces each non-empty match of the text locations' patterns in their targets' text with the mask placeholder.
 * A target's text is its descendant text nodes joined, as `.text()` reads it; a match spanning nodes leaves the
 * placeholder in the node where it starts and is removed from the others.
 */
function liftText(selected: readonly Selected[]): Lifted[] {
  const lifted: Lifted[] = [];
  for (const { mask, location, targets } of selected) {
    const pattern = location.textPattern;
    if (pattern === undefined || !isTextLocation(location)) continue;
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const placeholder = maskedTextPlaceholder(mask);
    for (const { el } of targets) {
      const nodes = textNodesOf(el);
      const text = nodes.map((node) => node.data).join('');
      const spans = matchSpans(text, global);
      if (spans.length === 0) continue;
      let nodeStart = 0;
      for (const node of nodes) {
        const data = node.data;
        const nodeEnd = nodeStart + data.length;
        let kept = '';
        let at = 0;
        for (const [start, end] of spans) {
          if (end <= nodeStart || start >= nodeEnd) continue;
          kept += data.slice(at, Math.max(start - nodeStart, 0));
          if (start >= nodeStart) {
            kept += placeholder;
            lifted.push({ mask, parent: node.parent ?? el, raw: text.slice(start, end) });
          }
          at = Math.min(end, nodeEnd) - nodeStart;
        }
        node.data = kept + data.slice(at);
        nodeStart = nodeEnd;
      }
    }
  }
  return lifted;
}

/**
 * One entry per model text field carrying each lifted component: the parent's own text-carrying entries, else its
 * nearest carrying ancestors. A component no model text carries is dropped.
 */
function maskedTextOf(ctx: Context, lifted: readonly Lifted[]): DomMaskedText[] {
  return lifted.flatMap(({ mask, parent, raw }) => {
    const own = (ctx.produced.get(parent) ?? []).filter((entry) => entry.carriesText);
    const carriers = own.length > 0 ? own : textCarriersOf(ctx, parent);
    const paths = [...new Set(carriers.map((entry) => entry.textPath ?? entry.path))];
    if (paths.length === 0) return [];
    const text = textOf(ctx, raw);
    return paths.map((path) => ({ mask, path, text }));
  });
}

/**
 * Model paths one target covers. A text location covers the value fields of a target whose own `value` attribute
 * it matches, its text matches being lifted into `maskedText`. Other locations cover the listed `attributes` of
 * object entries, else whole entries; with a `textPattern`, only when it matched the target's text or value.
 */
function locationPaths(ctx: Context, { el, textHit, valueHit }: Target, location: DomLocation): string[] {
  const own = ctx.produced.get(el);
  if (isTextLocation(location)) {
    return valueHit ? (own ?? []).flatMap((entry) => (entry.valuePath === undefined ? [] : [entry.valuePath])) : [];
  }
  if (location.textPattern !== undefined && !textHit && !valueHit) return [];
  const entries = own ?? textCarriersOf(ctx, el);
  return entries.flatMap((entry) => {
    if (location.attributes !== undefined) {
      return entry.object ? location.attributes.map((attribute) => `${entry.path}.${attribute}`) : [];
    }
    return [entry.path];
  });
}

// Location paths, then `maskedText[k]` under the mask that lifted it; the first mask to claim a path keeps it.
function maskedPathsOf(
  ctx: Context,
  selected: readonly Selected[],
  maskedText: readonly DomMaskedText[],
): Record<string, KnownIssueId> {
  const masked: Record<string, KnownIssueId> = {};
  const claim = (path: string, id: KnownIssueId): void => {
    if (!Object.hasOwn(masked, path)) masked[path] = id;
  };
  for (const { mask, location, targets } of selected) {
    for (const target of targets) {
      for (const path of locationPaths(ctx, target, location)) claim(path, mask);
    }
  }
  maskedText.forEach((entry, k) => claim(`maskedText[${k}]`, entry.mask));
  return masked;
}

/**
 * DOM model of admin page `html`, after removing `script`, `style`, `noscript` and the `dom.exclude` selectors, with
 * the model paths the step's DOM mask locations resolve to. Text a DOM mask's `textPattern` matches (without
 * `attributes`) is lifted into `maskedText`, leaving {@link maskedTextPlaceholder} in the model text. Texts are
 * whitespace-collapsed and go through {@link normaliseText}; control values through {@link normaliseValue}, CSRF
 * values becoming the token placeholder. Ordinals are assigned in model order (title, headings, labels, forms,
 * controls, buttons, links, tables, alerts, maskedText).
 */
export function domModel(html: string, opts: DomModelOptions): DomModelResult {
  const $ = cheerio.load(html);
  removeExcluded($, opts.rules);
  const ctx: Context = { $, state: opts.state, rules: opts.rules, produced: new Map() };
  const selected = selectLocations(ctx, opts.masks ?? []);
  const lifted = liftText(selected);
  const title = titleOf(ctx);
  const headings = headingsOf(ctx);
  const labels = labelsOf(ctx);
  const formIndex = formsOf(ctx);
  const controls = controlsOf(ctx, formIndex);
  const buttons = buttonsOf(ctx);
  const links = linksOf(ctx);
  const tables = tablesOf(ctx);
  const alerts = alertsOf(ctx);
  const maskedText = maskedTextOf(ctx, lifted);
  return {
    model: { title, headings, labels, forms: formIndex.forms, controls, buttons, links, tables, alerts, maskedText },
    maskedPaths: maskedPathsOf(ctx, selected, maskedText),
  };
}
