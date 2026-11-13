import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN, isCfUuid, parseAdminUrl } from '@opt2/platform/legacy-compat';
import { canonicalAdminUrl, domModel, type DomLink, type DomModelResult } from '../../../src/golden/normalise/dom-model.js';
import { CF_UUID_IN_TEXT, createIdOrdinals, peekOrdinal, type IdOrdinals } from '../../../src/golden/normalise/ids.js';
import { masksFor, type KnownIssueMask } from '../../../src/golden/normalise/masks.js';
import { loadRules } from '../../../src/golden/normalise/rules.js';

const rules = loadRules(undefined, { PORT: '8500' });
const TOKEN = rules.tokens.placeholder;

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../fixtures/html/${name}`, import.meta.url)), 'utf8');

const LOGIN = fixture('admin-login.html');
const EDIT_USER = fixture('admin-edituser.html');
const LIST = fixture('admin-list.html');
const SITE_MANAGER = JSON.parse(fixture('site-manager.json')) as { html: string; perm: string; sortby: string };
const PAGES: [name: string, html: string][] = [
  ['admin-login.html', LOGIN],
  ['admin-edituser.html', EDIT_USER],
  ['admin-list.html', LIST],
  ['site-manager.json', SITE_MANAGER.html],
];

const cfUuid = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(16)}`;
const USER = cfUuid('1');
const ROW_USERS = ['1', '2', '3'].map(cfUuid);
const TOP_NODE = '00000000000000000000000000000000001';
const TAB_LABELS = ['Basic', 'Address Information', 'Group Memberships', 'Interests', 'Extended Attributes', 'Advanced'];
const PROBES = ['SCRIPT-PROBE', 'opt2-probe', 'IGNORE-PROBE'];

interface PageModel extends DomModelResult {
  state: IdOrdinals;
}

function modelOf(html: string, masks: readonly KnownIssueMask[] = []): PageModel {
  const state = createIdOrdinals();
  return { ...domModel(html, { state, rules, masks }), state };
}

function ordinal(id: string, state: IdOrdinals): string {
  const placeholder = peekOrdinal(id, state, rules.ids);
  if (placeholder === undefined) throw new Error(`${id} was never numbered`);
  return placeholder;
}

// Every string value held anywhere in `value`.
function allStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(allStrings);
  return [];
}

const cfUuidsIn = (strings: readonly string[]): string[] =>
  strings.flatMap((s) => s.match(CF_UUID_IN_TEXT) ?? []).filter(isCfUuid);

const hrefsOf = (links: readonly DomLink[], text: string): (string | undefined)[] =>
  links.filter((link) => link.text === text).map((link) => link.href);

const probeFor = (selector: string): string =>
  selector === 'comment()'
    ? '<!--IGNORE-PROBE-->'
    : selector === 'script'
      ? "<script>var opt2Probe='SCRIPT-PROBE'</script>"
      : selector === 'style'
        ? '<style>.opt2-probe{}</style>'
        : `<${selector}>IGNORE-PROBE</${selector}>`;

describe('domModel on the saved admin fixtures', () => {
  it('models the login page forms, their controls with CSRF values as tokens, and its buttons', () => {
    const { model } = modelOf(LOGIN);
    expect(model.title).toBe('Masa CMS');
    expect(model.forms).toStrictEqual([
      { id: 'loginForm', name: 'frmLogin', action: 'index.cfm', method: 'post' },
      { id: 'sendLogin', name: 'sendLogin', action: './?muraAction=clogin.main', method: 'post' },
    ]);
    expect(model.controls.map(({ form, name, type, value, checked }) => [form, name, type, value, checked])).toStrictEqual([
      [0, 'username', 'text', undefined, undefined],
      [0, 'password', 'password', undefined, undefined],
      [0, 'rememberMe', 'checkbox', '1', false],
      [0, 'rb', 'select', undefined, undefined],
      [0, 'returnUrl', 'hidden', '', undefined],
      [0, 'muraAction', 'hidden', 'cLogin.login', undefined],
      [0, 'isAdminLogin', 'hidden', 'true', undefined],
      [0, 'compactDisplay', 'hidden', 'true', undefined],
      [0, CSRF_FIELD_TOKEN, 'hidden', TOKEN, undefined],
      [0, CSRF_FIELD_EXPIRES, 'hidden', TOKEN, undefined],
      [1, 'email', 'text', undefined, undefined],
      [1, undefined, 'submit', 'Submit', undefined],
      [1, 'status', 'hidden', 'sendlogin', undefined],
      [1, 'returnURL', 'hidden', '', undefined],
      [1, 'isAdminLogin', 'hidden', 'true', undefined],
      [1, 'compactDisplay', 'hidden', 'true', undefined],
    ]);
    expect(model.buttons).toStrictEqual(['Log In', 'Submit']);
  });

  it('models the edit-user tabs, labels, select options and checkables, numbering the user id once across the form', () => {
    const { model, state } = modelOf(EDIT_USER);
    const user = ordinal(USER, state);
    expect(model.title).toBe('Masa CMS - Users');
    expect(model.headings).toStrictEqual([
      { level: 1, text: 'User Maintenance Form' },
      ...['Basic Settings', ...TAB_LABELS.slice(1)].map((text) => ({ level: 3, text })),
    ]);
    expect(model.links.filter((link) => link.href?.startsWith('#tab')).map((link) => link.text)).toStrictEqual(TAB_LABELS);
    expect(model.labels.filter((label) => label.for !== undefined)).toStrictEqual([
      { for: 'fname', text: 'First Name*' },
      { for: 'lname', text: 'Last Name*' },
      { for: 'organization', text: 'Company' },
      { for: 'jobtitle', text: 'Job Title' },
      { for: 'email', text: 'Email*' },
      { for: 'mobilePhone', text: 'Mobile Phone' },
      { for: 'username', text: 'Username*' },
      { for: 'passwordNoCache', text: 'Password**' },
      { for: 'password2', text: 'Confirm Password**' },
      { for: 'newFile', text: 'Profile Image' },
    ]);
    expect(model.controls.filter((control) => control.type === 'select')).toStrictEqual([
      {
        form: 1,
        name: 'subtype',
        type: 'select',
        options: [
          { value: 'Default', label: 'Default', selected: true },
          { value: 'Employee', label: 'Employee', selected: false },
        ],
        disabled: false,
      },
    ]);
    const checkables = model.controls.filter((control) => control.checked !== undefined);
    expect(checkables.map(({ name, type, value, checked }) => [name, type, value, checked])).toStrictEqual([
      ['primaryAddressID', 'radio', ordinal(cfUuid('3'), state), true],
      ['isPublic', 'radio', '1', true],
      ['isPublic', 'radio', '0', false],
      ['groupid', 'checkbox', ordinal(cfUuid('2'), state), false],
      ['groupid', 'checkbox', ordinal(cfUuid('4'), state), true],
      ['categoryID', 'checkbox', ordinal(cfUuid('5'), state), false],
      ['InActive', 'radio', '0', true],
      ['InActive', 'radio', '1', false],
    ]);
    expect(model.controls.filter((control) => control.name === 'userid').map((c) => [c.type, c.value])).toStrictEqual([
      ['hidden', user],
    ]);
    expect(model.forms.find((form) => form.name === 'form1')?.action).toBe(
      `/admin/index.cfm?muraAction=cusers.update&userid=${user}&routeid=`,
    );
    expect(hrefsOf(model.links, 'Add New Address')).toStrictEqual([
      `./?muraAction=cusers.editaddress&userid=${user}&siteid=tenant-a&routeID=&addressID=`,
    ]);
  });

  it('models the user list table, its alerts and the mura-header heading', () => {
    const { model } = modelOf(LIST);
    expect(model.headings[0]).toStrictEqual({ level: 1, text: 'Users & Groups' });
    expect(model.alerts).toStrictEqual([
      { kind: 'alert-success', text: 'Your changes have been saved.' },
      { kind: 'alert-error', text: 'The selected user could not be deleted.' },
    ]);
    expect(model.tables).toStrictEqual([
      {
        headers: ['', '', 'User', 'Email', 'Date Last Update', 'Time Last Update', 'Last Updated By'],
        rows: [1, 2, 3].map((n) => [
          'Edit Delete',
          '',
          `Person0${n}, Fixture`,
          `person0${n}@example.test`,
          '<ts:admin-date>',
          '<ts:admin-time>',
          'Admin Fixture',
        ]),
      },
    ]);
  });

  it.each(rules.dom.exclude)('leaves %s content out of every model field', (selector) => {
    const probe = probeFor(selector);
    const $ = cheerio.load(LIST);
    $('head').append(probe);
    $('div.mura-header h1').append(probe);
    $('#tbl-users td').first().append(probe);
    const injected = $.html();
    expect(injected.split(probe)).toHaveLength(4);
    const { model } = modelOf(injected);
    expect(allStrings(model).filter((s) => PROBES.some((p) => s.includes(p)))).toStrictEqual([]);
    expect(model).toStrictEqual(modelOf(LIST).model);
  });

  it.each(PAGES)('keeps CSRF tokens and CF UUIDs out of %s and models it identically on every run', (_name, html) => {
    expect(html).toContain('FIXTURECSRFTOKEN');
    const first = modelOf(html);
    const strings = allStrings(first.model);
    expect(strings.filter((s) => s.includes('FIXTURECSRFTOKEN'))).toStrictEqual([]);
    expect(cfUuidsIn(strings)).toStrictEqual([]);
    expect(modelOf(html)).toStrictEqual(first);
  });

  it('masks the edit-user datepicker, User Type radios and header search action without dropping them', () => {
    const defaultMember = rules.knownIssues.find((issue) => issue.id === 'default-member');
    const scenario = defaultMember?.appliesTo[0] ?? '';
    const routeKey = defaultMember?.routeKeys.find((key) => key.endsWith('.edituser')) ?? '';
    const masks = masksFor(scenario, routeKey, rules);
    expect(masks.map((mask) => mask.id)).toStrictEqual(['date-mask', 'header-search-404', 'default-member']);

    const plain = modelOf(EDIT_USER, []);
    const masked = modelOf(EDIT_USER, masks);
    const { controls, forms } = plain.model;
    const datepicker = controls.findIndex((control) => control.name === undefined);
    const userType = controls.flatMap((control, i) => (control.name === 'isPublic' ? [i] : []));
    const search = forms.findIndex((form) => form.id === 'globalSearch');
    expect(controls[datepicker]).toMatchObject({ type: 'text', value: '<ts:admin-date>' });
    expect(userType).toHaveLength(2);
    expect(masked.maskedPaths).toStrictEqual({
      [`controls[${datepicker}].value`]: 'date-mask',
      [`forms[${search}].action`]: 'header-search-404',
      ...Object.fromEntries(userType.map((i) => [`controls[${i}].checked`, 'default-member'])),
    });
    expect(plain.maskedPaths).toStrictEqual({});
    expect(masked.model).toStrictEqual(plain.model);
    expect(masked.model.forms[search]).toStrictEqual({ id: 'globalSearch', name: 'globalSearch', action: '#', method: 'get' });
  });

  it('models the Site Manager JSON html, keeping the top node id and numbering the child ids across its links', () => {
    const { model, state } = modelOf(SITE_MANAGER.html);
    const content = ordinal(cfUuid('7'), state);
    const history = ordinal(cfUuid('8'), state);
    expect(isCfUuid(TOP_NODE)).toBe(false);
    expect(content).not.toBe(history);
    expect(model.forms).toStrictEqual([
      {
        name: 'viewUpdate',
        action: `./index.cfm?muraAction=carch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000&topid=${TOP_NODE}`,
        method: 'post',
      },
    ]);
    expect(model.controls.find((control) => control.name === 'orderperm')?.value).toBe(SITE_MANAGER.perm);
    expect(model.controls.find((control) => control.name === 'orderid')?.value).toBe(content);
    expect(model.links.map((link) => link.text).filter((text) => text !== '')).toStrictEqual([
      'Modify View',
      'Home',
      'About Us',
    ]);
    const actionsOn = (param: string): (string[] | undefined)[] =>
      model.links.flatMap(({ href }) => {
        const parsed = href?.includes(param) ? parseAdminUrl(href) : undefined;
        if (parsed === undefined) return [];
        const value = (name: string): string => parsed.params.find(([key]) => key === name)?.[1] ?? '';
        return [[`${parsed.circuit}.${parsed.action}`, value('contentid'), value('contenthistid'), value(CSRF_FIELD_TOKEN)]];
      });
    expect(actionsOn(`contentid=${TOP_NODE}`)).toStrictEqual([
      ['carch.edit', TOP_NODE, ordinal(cfUuid('6'), state), ''],
      ['carch.hist', TOP_NODE, '', ''],
      ['cperm.main', TOP_NODE, '', ''],
    ]);
    expect(actionsOn(`parentid=${TOP_NODE}`)).toStrictEqual([
      ['carch.edit', content, history, ''],
      ['carch.hist', content, '', ''],
      ['cperm.main', content, '', ''],
      ['carch.update', content, '', TOKEN],
    ]);
  });

  it('gives a replay of the list page with other ids and CSRF tokens the same model, and an edited cell another', () => {
    const remapped = new Map<string, string>();
    const replay = LIST.replace(CF_UUID_IN_TEXT, (candidate) => {
      if (!isCfUuid(candidate)) return candidate;
      const next = remapped.get(candidate) ?? `DEADBEEF-0000-0000-${String(remapped.size + 1).padStart(16, '0')}`;
      remapped.set(candidate, next);
      return next;
    }).replace(/FIXTURECSRFTOKEN\d{16}/g, 'FIXTURECSRFTOKEN0000000000000099');
    expect([...remapped.keys()]).toStrictEqual(ROW_USERS);
    expect(replay).toContain('FIXTURECSRFTOKEN0000000000000099');

    const golden = modelOf(LIST).model;
    expect(modelOf(replay).model).toStrictEqual(golden);
    const edited = modelOf(replay.replace('Admin Fixture', 'Other Fixture')).model;
    expect(edited).not.toStrictEqual(golden);
    expect(edited.tables[0]?.rows[0]?.[6]).toBe('Other Fixture');
  });
});

describe('canonicalAdminUrl on the fixture links', () => {
  it.each(ROW_USERS.map((id, row) => ({ row, id })))(
    'gives the row $row links one ordinal and one CF URL-scope reading',
    ({ row, id }) => {
      const { model, state } = modelOf(LIST);
      const user = ordinal(id, state);
      const buildUrl = hrefsOf(model.links, 'Edit')[row];
      const handWritten = hrefsOf(model.links, `Person0${row + 1}, Fixture`)[0];
      // keepParamOrder keeps each link's path and parameter spelling as served; only action values and ids are canonical.
      expect([buildUrl, hrefsOf(model.links, 'Delete')[row], handWritten]).toStrictEqual([
        `/admin/index.cfm?muraAction=cusers.edituser&userid=${user}&siteid=tenant-a`,
        `/admin/index.cfm?muraAction=cusers.update&action=delete&ispublic=1&userid=${user}&siteid=tenant-a&type=1&csrf_token=${TOKEN}&csrf_token_expires=${TOKEN}`,
        `./?muraAction=cusers.edituser&userID=${user}&siteid=tenant-a`,
      ]);
      const asRead = (href: string | undefined) => {
        const parsed = parseAdminUrl(href ?? '');
        return parsed && { ...parsed, params: parsed.params.map(([name, value]) => [name.toLowerCase(), value]) };
      };
      expect(asRead(handWritten)).toStrictEqual(asRead(buildUrl));
      expect(asRead(buildUrl)).toStrictEqual({
        circuit: 'cusers',
        action: 'edituser',
        params: [
          ['userid', user],
          ['siteid', 'tenant-a'],
        ],
      });
    },
  );

  it('gives each row id its own ordinal', () => {
    const { state } = modelOf(LIST);
    expect(new Set(ROW_USERS.map((id) => ordinal(id, state))).size).toBe(ROW_USERS.length);
  });

  it('reads &amp; in an attribute value as & before canonicalising', () => {
    const attribute = `./?muraAction=cUsers.editUser&amp;userID=${USER}&amp;siteid=tenant-a`;
    expect(LIST).toContain(attribute);
    const canonical = canonicalAdminUrl(attribute, createIdOrdinals(), rules);
    expect(canonical).toBe('./?muraAction=cusers.edituser&userID=<id:1>&siteid=tenant-a');
    expect(canonicalAdminUrl(attribute.replaceAll('&amp;', '&'), createIdOrdinals(), rules)).toBe(canonical);
  });

  it.each(
    rules.origins.values.flatMap((value) => {
      const url = new URL(value);
      return rules.origins.hostAliases.map((host) => `${url.protocol}//${url.host.replace(url.hostname, host)}`);
    }),
  )('canonicalises an absolute edit-user link on %s to the origin placeholder', (origin) => {
    const href = `${origin}/admin/index.cfm?muraAction=cUsers.editUser&userid=${USER}&siteid=tenant-a&csrf_token=FIXTURECSRFTOKEN0000000000000004`;
    expect(canonicalAdminUrl(href, createIdOrdinals(), rules)).toBe(
      `${rules.origins.placeholder}/admin/index.cfm?muraAction=cusers.edituser&userid=<id:1>&siteid=tenant-a&csrf_token=${TOKEN}`,
    );
  });
});
