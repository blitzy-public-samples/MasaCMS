// Unit tests for the admin HTML DOM model and admin URL canonicalisation against the committed rules.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Scenario } from '../../../src/golden/catalogue.js';
import {
  canonicalAdminUrl,
  domModel,
  maskedTextPlaceholder,
  type DomModelResult,
} from '../../../src/golden/normalise/dom-model.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { compareNormalised, createNormaliseState, normaliseStep } from '../../../src/golden/normalise/index.js';
import { masksFor, type Difference, type KnownIssueMask } from '../../../src/golden/normalise/masks.js';
import { KNOWN_ISSUE_IDS, loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';
import { normaliseText, normaliseValue } from '../../../src/golden/normalise/values.js';
import type { StepRecord } from '../../../src/golden/steps.js';

const LOGIN_PAGE = readFileSync(fileURLToPath(new URL('../../fixtures/html/admin-login.html', import.meta.url)), 'utf8');
const A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const DATE_PATTERN = /\b\d{1,2}\/\d{2,3}\/\d{4}\b/;
const LIFTED_DATE = maskedTextPlaceholder('date-mask');

let rules: NormaliseRules;
let sortingRules: NormaliseRules;
let userCrud: Scenario;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  sortingRules = { ...rules, dom: { ...rules.dom, actionUrl: { ...rules.dom.actionUrl, keepParamOrder: false } } };
  userCrud = scenarioById(await loadCatalogue(), 'GS-ID-05');
});

const model = (html: string, r: NormaliseRules = rules, masks?: KnownIssueMask[]): DomModelResult =>
  domModel(html, { state: createIdOrdinals(), rules: r, ...(masks === undefined ? {} : { masks }) });

const mask = (
  id: KnownIssueMask['id'],
  locations: KnownIssueMask['locations'],
  compareKinds?: KnownIssueMask['compareKinds'],
): KnownIssueMask => ({
  id,
  scenarios: ['*'],
  routeKeys: ['*'],
  description: id,
  locations,
  ...(compareKinds === undefined ? {} : { compareKinds }),
});

// The GS-ID-05 create-form step (cUsers.editUser) answered with `html`.
function userFormRecord(html: string): StepRecord {
  return {
    name: 'create-form',
    index: userCrud.steps.findIndex((step) => step.name === 'create-form'),
    routeKey: 'admin:cusers.edituser',
    request: { method: 'GET', url: '/admin/?muraAction=cUsers.editUser', headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers: { 'content-type': 'text/html' },
      contentType: 'text/html',
      sha256: '',
      hops: [],
      text: html,
    },
    extracted: {},
  };
}

// Golden and replay renders of that step, normalised and compared as the parity replay does.
async function compareUserForm(golden: string, replay: string, r: NormaliseRules = rules): Promise<Difference[]> {
  const run = async (html: string) => ({
    steps: [await normaliseStep(userFormRecord(html), { state: createNormaliseState(), rules: r, scenario: userCrud })],
    sideEffects: {},
  });
  return compareNormalised(await run(golden), await run(replay), { rules: r, scenario: userCrud });
}

type Classified = [path: string, classification: Difference['classification'], maskId: Difference['maskId']];

const classified = (differences: readonly Difference[]): Classified[] =>
  differences.map((d) => [d.path, d.classification, d.maskId]);

// The rules without timestamp class `name`, so values of that class stay literal.
const withoutTimestampClass = (name: string): NormaliseRules => ({
  ...rules,
  timestamps: { ...rules.timestamps, classes: rules.timestamps.classes.filter((cls) => cls.name !== name) },
});

// An edit-user page in legacy markup (header.cfm:162-171, edituser.cfm:134-142,495-500); only the arguments vary.
function userPage(o: { userId: string; token: string; origin: string; login?: string }): string {
  return `<!DOCTYPE html><html><head><title>Masa CMS - Users</title></head><body>
<li class="js-header-search header-search">
  <form class="form-horizontal" action="#" novalidate="novalidate" id="globalSearch" name="globalSearch" method="get">
    <input class="form-control" type="text" id="mura-search-keywords" name="keywords" value="" placeholder="Search">
    <input type="hidden" name="muraAction" value="cArch.list">
    <input type="hidden" name="siteid" value="default">
  </form>
</li>
<div class="mura-header"><h1>User Maintenance Form</h1></div>
<div class="alert alert-error"><span>Blocked until: 10:30 AM <a href="?muraAction=cUsers.edituser&amp;userid=${o.userId}&amp;type=2&amp;siteid=default&amp;removeBlock">[Remove]</a></span></div>
<form novalidate="novalidate" action="${o.origin}/admin/index.cfm?muraAction=cUsers.update&userid=${o.userId}&routeid=" method="post" name="form1">
  <label>User Type</label>
  <label class="radio inline"><input name="isPublic" type="radio" class="radio inline" value="1" Checked> Site Member</label>
  <label class="radio inline"><input name="isPublic" type="radio" class="radio inline" value="0"> System User</label>
  <script>$('input[name="isPublic"]').click(function(e){});</script>
  <input type="text" class="datepicker" name="expires" value="10/302/2026">
  <input type="hidden" name="userid" value="${o.userId}">
  <input type="hidden" name="csrf_token" value="${o.token}" /><input type="hidden" name="csrf_token_expires" value="260630120000000" />
</form>
<table class="mura-table-grid"><tr><th>Last Login</th><th>User</th></tr><tr><td>10/302/2026</td><td>${o.login ?? 'admin'}</td></tr></table>
<a href="${o.origin}/admin/?muraAction=cUsers.editAddress&userid=${o.userId}&siteid=default&csrf_token=${o.token}">Address</a>
</body></html>`;
}

const CAPTURE = { userId: A, token: 'FIXTURECSRFTOKEN0000000000000001', origin: 'http://127.0.0.1:8500' };
const REPLAY = { userId: B, token: 'FIXTURECSRFTOKEN0000000000000099', origin: 'http://127.0.0.1:8100' };

describe('domModel', () => {
  it('models the legacy login page with CSRF values as tokens and the password value omitted', () => {
    const { model: m, maskedPaths } = model(LOGIN_PAGE);
    expect(m.title).toBe('Masa CMS');
    expect(m.headings).toStrictEqual([{ level: 2, text: 'Forget your password?' }]);
    expect(m.forms).toStrictEqual([
      { id: 'loginForm', name: 'frmLogin', action: 'index.cfm', method: 'post' },
      { id: 'sendLogin', name: 'sendLogin', action: './?muraAction=clogin.main', method: 'post' },
    ]);
    const byName = (name: string) => m.controls.filter((control) => control.name === name);
    expect(byName('password')).toStrictEqual([{ form: 0, name: 'password', type: 'password', disabled: false }]);
    expect(byName('rememberMe')).toStrictEqual([
      { form: 0, name: 'rememberMe', type: 'checkbox', value: '1', checked: false, disabled: false },
    ]);
    expect(byName('rb')[0]?.options).toStrictEqual([
      { value: 'en_US', label: 'English', selected: false },
      { value: 'da', label: 'Danish', selected: false },
      { value: 'de', label: 'Deutsch', selected: false },
      { value: 'nl', label: 'Dutch', selected: false },
      { value: 'fil', label: 'Filipino', selected: false },
      { value: 'fr', label: 'Français', selected: false },
      { value: 'hu', label: 'Hungarian', selected: false },
      { value: 'id', label: 'Indonesian', selected: false },
      { value: 'it', label: 'Italian', selected: false },
      { value: 'pt', label: 'Portuguese', selected: false },
      { value: 'ru', label: 'Русский', selected: false },
      { value: 'es', label: 'Spanish', selected: false },
    ]);
    expect([...byName('csrf_token'), ...byName('csrf_token_expires')].map((c) => [c.form, c.value])).toStrictEqual([
      [0, '<token>'],
      [0, '<token>'],
    ]);
    expect(byName('muraAction')).toStrictEqual([
      { form: 0, name: 'muraAction', type: 'hidden', value: 'cLogin.login', disabled: false },
    ]);
    expect(m.buttons).toStrictEqual(['Log In', 'Submit']);
    expect(m.links).toStrictEqual([
      { text: 'Forget your password?', href: '#' },
      { text: 'Return to login', href: '#' },
    ]);
    expect(m.labels[0]).toStrictEqual({ text: 'Username' });
    expect(JSON.stringify(m)).not.toContain('FIXTURECSRFTOKEN');
    expect(maskedPaths).toStrictEqual({});
  });

  it('extracts every category in document order and omits absent fields', () => {
    const { model: m } = model(`<!-- COMMENT-PROBE --><html><head><title> T  </title><style>.opt2-probe{}</style></head><body>
      <h2> Users <small>x</small></h2><h4>Sub</h4>
      <div class="alert alert-error"><span>Bad <b>thing</b></span><a class="close alert-dismiss"><i></i></a></div>
      <div class="alert">Plain</div><p class="help-block error">Help</p>
      <form id="f1" action="?muraAction=cUsers.update&amp;userid=${A}" method="POST">
        <label for="name1">Name <!-- COMMENT-PROBE --></label><input id="name1" name="fname" value="  Ann  ">
        <input type="password" name="password" value="pw">
        <input type="hidden" name="csrf_token" value="FIXTURECSRFTOKEN0000000000000003"><input type="hidden" name="csrf_token_expires" value="">
        <input type="checkbox" name="s2" value="1" checked disabled>
        <select name="siteid"><optgroup><option value="default" selected>Default</option><option> Tenant  A </option></optgroup></select>
        <textarea name="notes">line1
  line2</textarea>
        <button type="submit"> Save <i class="mi-check"></i></button><input type="submit" value="Go"><input type="reset" value="Reset">
      </form>
      <input name="outside" form="f1"><input name="orphan" form="none"><input name="loose">
      <a class="btn" href="javascript:void(0)">Cancel</a><a>no href</a>
      <table><thead><tr><th>Name</th><th>Email</th></tr></thead>
        <tbody><tr><th>Ann</th><td>a@example.com<table><tr><td>nested</td></tr></table></td></tr><tr></tr></tbody></table>
      <script>var probe = 'SCRIPT-PROBE';</script><noscript>NOSCRIPT-PROBE</noscript></body></html>`);
    expect(m.title).toBe('T');
    expect(m.headings).toStrictEqual([
      { level: 2, text: 'Users x' },
      { level: 4, text: 'Sub' },
    ]);
    expect(m.labels).toStrictEqual([{ for: 'name1', text: 'Name' }]);
    expect(m.forms).toStrictEqual([{ id: 'f1', action: '?muraAction=cusers.update&userid=<id:1>', method: 'post' }]);
    expect(m.controls).toStrictEqual([
      { form: 0, name: 'fname', type: 'text', value: '  Ann  ', disabled: false },
      { form: 0, name: 'password', type: 'password', disabled: false },
      { form: 0, name: 'csrf_token', type: 'hidden', value: '<token>', disabled: false },
      { form: 0, name: 'csrf_token_expires', type: 'hidden', value: '', disabled: false },
      { form: 0, name: 's2', type: 'checkbox', value: '1', checked: true, disabled: true },
      {
        form: 0,
        name: 'siteid',
        type: 'select',
        options: [
          { value: 'default', label: 'Default', selected: true },
          { value: 'Tenant A', label: 'Tenant A', selected: false },
        ],
        disabled: false,
      },
      { form: 0, name: 'notes', type: 'textarea', value: 'line1\n  line2', disabled: false },
      { form: 0, type: 'submit', value: 'Go', disabled: false },
      { form: 0, type: 'reset', value: 'Reset', disabled: false },
      { form: 0, name: 'outside', type: 'text', disabled: false },
      { name: 'orphan', type: 'text', disabled: false },
      { name: 'loose', type: 'text', disabled: false },
    ]);
    expect(m.buttons).toStrictEqual(['Save', 'Go', 'Cancel']);
    expect(m.links).toStrictEqual([{ text: 'Cancel', href: 'javascript:void(0)' }]);
    expect(m.tables).toStrictEqual([
      { headers: ['Name', 'Email'], rows: [['Ann', 'a@example.comnested']] },
      { headers: [], rows: [['nested']] },
    ]);
    expect(m.alerts).toStrictEqual([
      { kind: 'alert-error', text: 'Bad thing' },
      { kind: 'alert', text: 'Plain' },
      { kind: 'error help-block', text: 'Help' },
    ]);
    expect(JSON.stringify(m)).not.toMatch(/PROBE|opt2-probe/);
  });

  it('applies dom.exclude overrides and the exact whitespace mode', () => {
    const exact = { ...rules, dom: { ...rules.dom, exclude: [...rules.dom.exclude, '.opt2-probe'], whitespace: 'exact' as const } };
    expect(model('<label> a  b </label><label class="opt2-probe">IGNORE-PROBE</label>', exact).model.labels).toStrictEqual([
      { text: ' a  b ' },
    ]);
  });

  it('gives equal models for renders differing only in ids, CSRF tokens and origins', () => {
    const golden = model(userPage(CAPTURE)).model;
    expect(model(userPage(REPLAY)).model).toStrictEqual(golden);
    expect(model(userPage({ ...REPLAY, login: 'other' })).model).not.toStrictEqual(golden);
    expect(golden.links.at(-1)?.href).toBe(
      '<origin>/admin/?muraAction=cusers.editaddress&userid=<id:1>&siteid=default&csrf_token=<token>',
    );
    expect(golden.controls.filter((c) => c.name === 'isPublic').map((c) => c.checked)).toStrictEqual([true, false]);
  });

  it('resolves the edit-user known-issue masks to model paths, lifting the cell date into maskedText', () => {
    const { model: m, maskedPaths } = model(userPage(CAPTURE), rules, masksFor('GS-ID-05', 'admin:cusers.edituser', rules));
    expect(maskedPaths).toStrictEqual({
      'controls[5].value': 'date-mask',
      'forms[0].action': 'header-search-404',
      'controls[3].checked': 'default-member',
      'controls[4].checked': 'default-member',
      'maskedText[0]': 'date-mask',
    });
    expect(m.forms[0]).toStrictEqual({ id: 'globalSearch', name: 'globalSearch', action: '#', method: 'get' });
    expect(m.controls[5]?.value).toBe('<ts:admin-date>');
    expect(m.tables[0]?.rows).toStrictEqual([[LIFTED_DATE, 'admin']]);
    expect(m.maskedText).toStrictEqual([{ mask: 'date-mask', path: 'tables[0].rows[0][0]', text: '<ts:admin-date>' }]);
    const unmasked = model(userPage(CAPTURE), rules, []);
    expect(unmasked.maskedPaths).toStrictEqual({});
    expect(unmasked.model.tables[0]?.rows).toStrictEqual([['<ts:admin-date>', 'admin']]);
    expect(unmasked.model.maskedText).toStrictEqual([]);
  });

  // `literalDates` drops the admin-date timestamp class, so two dates of that class compare by their text.
  it.each<[string, string, string, boolean, Classified[]]>([
    [
      'changed text beside a date as a difference',
      '10/302/2026 Alice',
      '10/302/2026 Mallory',
      false,
      [['domModel.tables[0].rows[0][0]', 'difference', undefined]],
    ],
    ['a date of the same format class as equal', '10/302/2026 Alice', '10/30/2026 Alice', false, []],
    [
      'a changed literal date alone as known-issue',
      '10/302/2026 Alice',
      '10/30/2026 Alice',
      true,
      [['domModel.maskedText[0].text', 'known-issue', 'date-mask']],
    ],
    [
      'a changed literal date and changed text apart',
      '10/302/2026 Alice',
      '10/30/2026 Mallory',
      true,
      [
        ['domModel.maskedText[0].text', 'known-issue', 'date-mask'],
        ['domModel.tables[0].rows[0][0]', 'difference', undefined],
      ],
    ],
    [
      'a dropped date as a cell difference',
      '10/302/2026 Alice',
      'Alice',
      false,
      [
        ['domModel.maskedText[0]', 'known-issue', 'date-mask'],
        ['domModel.tables[0].rows[0][0]', 'difference', undefined],
      ],
    ],
    ['a date split by inline markup as equal', '10/302/2026 Alice', '10/<span>302</span>/2026 Alice', false, []],
    [
      'a changed literal date split by inline markup alone as known-issue',
      '10/<b>302</b>/2026 Alice',
      '10/30/2026 Alice',
      true,
      [['domModel.maskedText[0].text', 'known-issue', 'date-mask']],
    ],
    [
      'changed text beside a split date as a difference',
      '10/<span>302</span>/2026 Alice',
      '10/302/2026 Mallory',
      false,
      [['domModel.tables[0].rows[0][0]', 'difference', undefined]],
    ],
  ])('classifies %s in a mixed date and text cell', async (_label, golden, replay, literalDates, expected) => {
    const page = (cell: string) => `<table><tr><th>Last Login</th></tr><tr><td>${cell}</td></tr></table>`;
    const r = literalDates ? withoutTimestampClass('admin-date') : rules;
    expect(classified(await compareUserForm(page(golden), page(replay), r))).toStrictEqual(expected);
  });

  it.each(['10/<span>302</span>/2026 Alice', '<b>10/</b>302/2026 Alice', '1<i>0</i>/302/<b>2026</b> Alice'])(
    'lifts the date of %s as it lifts the unsplit date',
    (cell) => {
      const masks = masksFor('GS-ID-05', 'admin:cusers.edituser', rules);
      const page = (text: string) => `<table><tr><td>${text}</td></tr></table>`;
      const plain = model(page('10/302/2026 Alice'), rules, masks);
      expect(plain.model.tables[0]?.rows).toStrictEqual([[`${LIFTED_DATE} Alice`]]);
      expect(plain.model.maskedText).toStrictEqual([
        { mask: 'date-mask', path: 'tables[0].rows[0][0]', text: '<ts:admin-date>' },
      ]);
      expect(model(page(cell), rules, masks)).toStrictEqual(plain);
    },
  );

  it('lifts a date spanning several text nodes once, keeping their text outside it', () => {
    const { model: m, maskedPaths } = model(
      '<table><tr><td>On 1<a href="#a">0</a>/302/<a href="#b">2026 by</a> Alice</td></tr></table>',
      rules,
      masksFor('GS-ID-05', 'admin:cusers.edituser', rules),
    );
    expect(m.tables[0]?.rows).toStrictEqual([[`On ${LIFTED_DATE} by Alice`]]);
    expect(m.links).toStrictEqual([
      { text: '', href: '#a' },
      { text: 'by', href: '#b' },
    ]);
    expect(m.maskedText).toStrictEqual([{ mask: 'date-mask', path: 'tables[0].rows[0][0]', text: '<ts:admin-date>' }]);
    expect(maskedPaths).toStrictEqual({ 'maskedText[0]': 'date-mask' });
  });

  it.each<[string, string, string, Classified]>([
    ['action', 'action="#"', 'action="./"', ['domModel.forms[0].action', 'known-issue', 'header-search-404']],
    ['method', 'method="get"', 'method="post"', ['domModel.forms[0].method', 'difference', undefined]],
    ['input name', 'name="keywords"', 'name="q"', ['domModel.controls[0].name', 'difference', undefined]],
    ['input type', 'type="text" id', 'type="search" id', ['domModel.controls[0].type', 'difference', undefined]],
    [
      'search text',
      'name="keywords" value=""',
      'name="keywords" value="gs"',
      ['domModel.controls[0].value', 'difference', undefined],
    ],
    [
      'hidden input value',
      'name="siteid" value="default"',
      'name="siteid" value="x"',
      ['domModel.controls[2].value', 'difference', undefined],
    ],
    [
      'input disabled state',
      'value="cArch.list">',
      'value="cArch.list" disabled>',
      ['domModel.controls[1].disabled', 'difference', undefined],
    ],
  ])('classifies a changed header search form %s at its exact path only', async (_label, from, to, expected) => {
    const replay = userPage(REPLAY);
    expect(replay).toContain(from);
    expect(classified(await compareUserForm(userPage(CAPTURE), replay.replace(from, to)))).toStrictEqual([expected]);
  });

  it('narrows DOM mask locations by text pattern, attributes, ancestors and compare kinds', () => {
    const { model: m, maskedPaths } = model(
      `<table><tr><td>10/302/2026</td><td>x</td></tr></table>
       <input class="datepicker" name="d" value="10/302/2026"><input class="datepicker" name="e" value="today">
       <a href="?muraAction=a.b"><span class="meta-label"><span>10/302/2026</span></span></a>
       <dl><dd class="updated">10/302/2026</dd></dl>
       <select name="s"><option value="10/302/2026">10/302/2026</option></select><button>b</button>
       <input type="submit" class="datepicker" value="10/302/2026">`,
      rules,
      [
        mask('date-mask', [
          { kind: 'dom', selector: 'td', textPattern: DATE_PATTERN },
          { kind: 'dom', selector: 'input.datepicker[value]', textPattern: new RegExp(DATE_PATTERN.source, 'g') },
          { kind: 'dom', selector: '.meta-label span', textPattern: DATE_PATTERN },
          { kind: 'dom', selector: 'dd.updated', textPattern: DATE_PATTERN },
          { kind: 'dom', selector: 'option', textPattern: DATE_PATTERN },
          { kind: 'header', name: 'X-A' },
        ]),
        mask('default-member', [{ kind: 'dom', selector: 'td' }]),
        mask('header-search-404', [{ kind: 'dom', selector: 'a' }], ['headers']),
        mask('session-rotation', [{ kind: 'dom', selector: 'button,option', attributes: ['selected'] }]),
      ],
    );
    expect(maskedPaths).toStrictEqual({
      'controls[0].value': 'date-mask',
      'controls[3].value': 'date-mask',
      'buttons[1]': 'date-mask',
      'controls[2].options[0].value': 'date-mask',
      'maskedText[0]': 'date-mask',
      'maskedText[1]': 'date-mask',
      'maskedText[2]': 'date-mask',
      'tables[0].rows[0][0]': 'default-member',
      'tables[0].rows[0][1]': 'default-member',
      'controls[2].options[0].selected': 'session-rotation',
    });
    const date = { mask: 'date-mask', text: '<ts:admin-date>' };
    expect(m.maskedText).toStrictEqual(
      ['tables[0].rows[0][0]', 'links[0].text', 'controls[2].options[0].label'].map((path) => ({ ...date, path })),
    );
    expect(m.controls[2]?.options).toStrictEqual([{ value: '<ts:admin-date>', label: LIFTED_DATE, selected: false }]);
  });

  it('lifts every match out of the selected text, attributing it to the nearest model text that carries it', () => {
    const P = LIFTED_DATE;
    const { model: m, maskedPaths } = model(
      `<html><head><title>Updated 10/302/2026</title></head><body>
       <h2>From 1/05/2026 to <span class="d">2/06/2026</span></h2>
       <a class="btn" href="#"><span class="d">3/07/2026</span></a>
       <table><tr><td>4/08/2026 Alice <b>5/09/2026</b></td></tr></table>
       <textarea name="notes">6/10/2026</textarea><p class="d">7/11/2026</p></body></html>`,
      rules,
      [mask('date-mask', [{ kind: 'dom', selector: 'title,h2,.d,td,textarea', textPattern: DATE_PATTERN }])],
    );
    expect(m.title).toBe(`Updated ${P}`);
    expect(m.headings).toStrictEqual([{ level: 2, text: `From ${P} to ${P}` }]);
    expect(m.buttons).toStrictEqual([P]);
    expect(m.links).toStrictEqual([{ text: P, href: '#' }]);
    expect(m.tables).toStrictEqual([{ headers: [], rows: [[`${P} Alice ${P}`]] }]);
    expect(m.controls).toStrictEqual([{ name: 'notes', type: 'textarea', value: P, disabled: false }]);
    const paths = [
      'title',
      'headings[0].text',
      'headings[0].text',
      'buttons[0]',
      'links[0].text',
      'tables[0].rows[0][0]',
      'tables[0].rows[0][0]',
      'controls[0].value',
    ];
    expect(m.maskedText).toStrictEqual(paths.map((path) => ({ mask: 'date-mask', path, text: '<ts:admin-date>' })));
    expect(maskedPaths).toStrictEqual(Object.fromEntries(paths.map((_path, k) => [`maskedText[${k}]`, 'date-mask'])));
  });

  it.each<[string, RegExp, string, string[]]>([
    ['a pattern without the g flag', /alice/i, `${LIFTED_DATE} and ${LIFTED_DATE}`, ['Alice', 'ALICE']],
    ['a global pattern', /alice/gi, `${LIFTED_DATE} and ${LIFTED_DATE}`, ['Alice', 'ALICE']],
    ['a pattern that also matches empty text', /l*/, `A${LIFTED_DATE}ice and ALICE`, ['l']],
  ])('lifts each non-empty match of %s, keeping its other flags', (_label, textPattern, cell, texts) => {
    const { model: m } = model('<table><tr><td>Alice and ALICE</td></tr></table>', rules, [
      mask('date-mask', [{ kind: 'dom', selector: 'td', textPattern }]),
    ]);
    expect(m.tables[0]?.rows).toStrictEqual([[cell]]);
    const path = 'tables[0].rows[0][0]';
    expect(m.maskedText).toStrictEqual(texts.map((text) => ({ mask: 'date-mask', path, text })));
  });

  it('keeps placeholders out of later patterns, reads pattern hits as served and numbers lifted ids last', () => {
    const { model: m, maskedPaths } = model(
      `<h2>ref ${B} on 10/302/2026, mask</h2><a href="?muraAction=a.b&id=${A}">x</a>
       <select name="s"><option> v </option></select>`,
      rules,
      [
        mask('date-mask', [{ kind: 'dom', selector: 'h2', textPattern: /ref \S+|\d+\/\d+\/\d+/ }]),
        mask('default-member', [{ kind: 'dom', selector: 'h2', textPattern: /mask|known/ }]),
        mask('session-rotation', [
          { kind: 'dom', selector: 'h2', textPattern: /\/302\//, attributes: ['level'] },
          { kind: 'dom', selector: 'a', textPattern: /y/, attributes: ['href'] },
          { kind: 'dom', selector: 'option', textPattern: /^v$/, attributes: ['selected'] },
        ]),
      ],
    );
    const member = maskedTextPlaceholder('default-member');
    expect(m.headings).toStrictEqual([{ level: 2, text: `${LIFTED_DATE} on ${LIFTED_DATE}, ${member}` }]);
    expect(m.links).toStrictEqual([{ text: 'x', href: '?muraAction=a.b&id=<id:1>' }]);
    expect(m.maskedText).toStrictEqual([
      { mask: 'date-mask', path: 'headings[0].text', text: 'ref <id:2>' },
      { mask: 'date-mask', path: 'headings[0].text', text: '<ts:admin-date>' },
      { mask: 'default-member', path: 'headings[0].text', text: 'mask' },
    ]);
    expect(maskedPaths).toStrictEqual({
      'headings[0].level': 'session-rotation',
      'controls[0].options[0].selected': 'session-rotation',
      'maskedText[0]': 'date-mask',
      'maskedText[1]': 'date-mask',
      'maskedText[2]': 'default-member',
    });
  });

  it.each(KNOWN_ISSUE_IDS)('leaves the %s placeholder unchanged through text and value normalisation', (id) => {
    const text = `${maskedTextPlaceholder(id)} Alice`;
    expect(normaliseText(text, createIdOrdinals(), rules)).toBe(text);
    expect(normaliseValue(text, createIdOrdinals(), rules, 'notes')).toBe(text);
  });

  it('continues id ordinals from a shared state and models an empty document', () => {
    const state = createIdOrdinals();
    domModel(`<a href="?muraAction=a.b&id=${B}">x</a>`, { state, rules });
    expect(domModel(`<a href="?muraAction=a.b&id=${A}&other=${B}">x</a>`, { state, rules }).model.links).toStrictEqual([
      { text: 'x', href: '?muraAction=a.b&id=<id:2>&other=<id:1>' },
    ]);
    expect(model('').model).toStrictEqual({
      title: '',
      headings: [],
      labels: [],
      forms: [],
      controls: [],
      buttons: [],
      links: [],
      tables: [],
      alerts: [],
      maskedText: [],
    });
  });
});

describe('canonicalAdminUrl', () => {
  it.each(['#', '', '  ', 'javascript:void(0)', 'JavaScript:submitForm()', '#tabBasic'])('keeps %j verbatim', (url) => {
    expect(canonicalAdminUrl(url, createIdOrdinals(), rules)).toBe(url);
  });

  it.each([
    [
      'lower-cases the action, masks CSRF values and reads &amp; as &',
      `./?muraAction=cArch.list&amp;siteid=default&amp;csrf_token=ABC&csrf_token_expires=260630&contentid=${A}`,
      './?muraAction=carch.list&siteid=default&csrf_token=<token>&csrf_token_expires=<token>&contentid=<id:1>',
    ],
    [
      'keeps valueless and empty parameters',
      '?fuseaction=cUsers.EditUser&userid=&removeBlock',
      '?fuseaction=cusers.edituser&userid=&removeBlock',
    ],
    [
      'normalises other URLs through normaliseUrl only',
      'http://localhost:8500/admin/assets/js/Site.js?v=Ab',
      '<origin>/admin/assets/js/Site.js?v=Ab',
    ],
  ])('%s', (_label, url, expected) => {
    expect(canonicalAdminUrl(url, createIdOrdinals(), rules)).toBe(expected);
  });

  it('keeps parameter order under the committed rules and sorts stably when keepParamOrder is off', () => {
    const golden = `http://127.0.0.1:8500/admin/?muraAction=cUsers.edit&userid=${A}&siteid=default&x=2&x=1`;
    const replay = `http://127.0.0.1:8100/admin/?siteid=default&x=2&MURAACTION=cusers.EDIT&x=1&userid=${B}`;
    expect(canonicalAdminUrl(golden, createIdOrdinals(), rules)).toBe(
      '<origin>/admin/?muraAction=cusers.edit&userid=<id:1>&siteid=default&x=2&x=1',
    );
    expect(canonicalAdminUrl(replay, createIdOrdinals(), rules)).toBe(
      '<origin>/admin/?siteid=default&x=2&MURAACTION=cusers.edit&x=1&userid=<id:1>',
    );
    expect(canonicalAdminUrl(golden, createIdOrdinals(), sortingRules)).toBe(
      '<origin>/admin/?muraAction=cusers.edit&siteid=default&userid=<id:1>&x=2&x=1',
    );
    expect(canonicalAdminUrl(replay, createIdOrdinals(), sortingRules)).toBe(
      '<origin>/admin/?MURAACTION=cusers.edit&siteid=default&userid=<id:1>&x=2&x=1',
    );
  });
});
