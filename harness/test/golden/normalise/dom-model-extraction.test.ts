// Unit tests for the admin HTML DOM model and admin URL canonicalisation against the committed rules.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { canonicalAdminUrl, domModel, type DomModelResult } from '../../../src/golden/normalise/dom-model.js';
import { createIdOrdinals } from '../../../src/golden/normalise/ids.js';
import { masksFor, type KnownIssueMask } from '../../../src/golden/normalise/masks.js';
import { loadRules, type NormaliseRules } from '../../../src/golden/normalise/rules.js';

const LOGIN_PAGE = readFileSync(fileURLToPath(new URL('../../fixtures/html/admin-login.html', import.meta.url)), 'utf8');
const A = '2B3C4D5E-6F7A-4B8C-9D0E1F2A3B4C5D6E';
const B = '3C4D5E6F-7A8B-4C9D-8E0F1A2B3C4D5E6F';
const DATE_PATTERN = /\b\d{1,2}\/\d{2,3}\/\d{4}\b/;

let rules: NormaliseRules;
let sortingRules: NormaliseRules;

beforeAll(() => {
  rules = loadRules(undefined, { PORT: '8500' });
  sortingRules = { ...rules, dom: { ...rules.dom, actionUrl: { ...rules.dom.actionUrl, keepParamOrder: false } } };
});

const model = (html: string, r: NormaliseRules = rules, masks?: KnownIssueMask[]): DomModelResult =>
  domModel(html, { state: createIdOrdinals(), rules: r, ...(masks === undefined ? {} : { masks }) });

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
      { id: 'loginForm', name: 'frmLogin', action: './?muraAction=clogin.login', method: 'post' },
      { id: 'sendLogin', name: 'sendLogin', action: './?muraAction=clogin.main', method: 'post' },
    ]);
    const byName = (name: string) => m.controls.filter((control) => control.name === name);
    expect(byName('password')).toStrictEqual([{ form: 0, name: 'password', type: 'password', disabled: false }]);
    expect(byName('rememberMe')).toStrictEqual([
      { form: 0, name: 'rememberMe', type: 'checkbox', value: '1', checked: false, disabled: false },
    ]);
    expect(byName('rb')[0]?.options?.slice(3, 5)).toStrictEqual([
      { value: 'nl', label: 'Dutch', selected: false },
      { value: 'fr', label: 'Français', selected: false },
    ]);
    expect([...byName('csrf_token'), ...byName('csrf_token_expires')].map((c) => [c.form, c.value])).toStrictEqual([
      [0, '<token>'],
      [1, '<token>'],
      [0, '<token>'],
      [1, '<token>'],
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

  it('resolves the edit-user known-issue masks to model paths and keeps the masked entries', () => {
    const { model: m, maskedPaths } = model(userPage(CAPTURE), rules, masksFor('GS-ID-05', 'admin:cusers.edituser', rules));
    expect(maskedPaths).toStrictEqual({
      'controls[5].value': 'date-mask',
      'tables[0].rows[0][0]': 'date-mask',
      'forms[0]': 'header-search-404',
      'controls[0]': 'header-search-404',
      'controls[1]': 'header-search-404',
      'controls[2]': 'header-search-404',
      'controls[3].checked': 'default-member',
      'controls[4].checked': 'default-member',
    });
    expect(m.forms[0]).toStrictEqual({ id: 'globalSearch', name: 'globalSearch', action: '#', method: 'get' });
    expect(m.controls[5]?.value).toBe('<ts:admin-date>');
    expect(model(userPage(CAPTURE), rules, []).maskedPaths).toStrictEqual({});
  });

  it('narrows DOM mask locations by text pattern, attributes, ancestors and compare kinds', () => {
    const mask = (id: KnownIssueMask['id'], locations: KnownIssueMask['locations'], compareKinds?: KnownIssueMask['compareKinds']) => ({
      id,
      scenarios: ['*'],
      routeKeys: ['*'],
      description: id,
      locations,
      ...(compareKinds === undefined ? {} : { compareKinds }),
    });
    const { maskedPaths } = model(
      `<table><tr><td>10/302/2026</td><td>x</td></tr></table>
       <input class="datepicker" name="d" value="10/302/2026"><input class="datepicker" name="e" value="today">
       <a href="?muraAction=a.b"><span class="meta-label"><span>10/302/2026</span></span></a>
       <dl><dd class="updated">10/302/2026</dd></dl>
       <select name="s"><option value="10/302/2026">10/302/2026</option></select><button>b</button>`,
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
      'tables[0].rows[0][0]': 'date-mask',
      'controls[0].value': 'date-mask',
      'links[0].text': 'date-mask',
      'controls[2].options[0].value': 'date-mask',
      'controls[2].options[0].label': 'date-mask',
      'tables[0].rows[0][1]': 'default-member',
      'controls[2].options[0].selected': 'session-rotation',
    });
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
