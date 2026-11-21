// Unit tests for the csettings secondary menu against `csettings/dsp_secondary_menu.cfm`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import { renderCsettingsSecondaryMenu } from '@/screens/csettings/dsp_secondary_menu';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';

const here = import.meta.dirname ?? __dirname;
const MENU_CFM = path.resolve(here, '../../../../admin/core/views/csettings/dsp_secondary_menu.cfm');
const ADD_SITE_HREF = './?muraAction=cSettings.edit&siteid=';
const WITH_LINK = `<ul class="nav nav-pills"> <li><a href="${ADD_SITE_HREF}">Add New Site</a></li> </ul>`;
const EMPTY_LIST = '<ul class="nav nav-pills"> </ul>';

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The legacy view's output for `rc.originalfuseaction` = `value`, whitespace-collapsed; `cfcase` ignores case. */
function legacyMenu(value: string): string {
  const source = readFileSync(MENU_CFM, 'utf8').replaceAll('\r\n', '\n');
  const body = source.slice(source.indexOf('<ul class='), source.lastIndexOf('</ul>') + '</ul>'.length);
  const cases = new Map(
    [...body.matchAll(/<cfcase value="(\w+)">(.*?)<\/cfcase>/gs)].map(([, key, block]) => [key?.toLowerCase(), block]),
  );
  return collapse(body.replace(/<cfswitch [^>]*>.*<\/cfswitch>/s, () => cases.get(value.toLowerCase()) ?? ''));
}

/** Rendered markup of the menu for `req`. */
function render(req: AdminRequest): string {
  const markup = renderCsettingsSecondaryMenu(req);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

/** `li` count of the single top-level `ul.nav.nav-pills` of `markup`. */
function itemCount(markup: string): number {
  const $ = cheerio.load(markup, null, false);
  expect($.root().children().length).toBe(1);
  const list = $.root().children('ul.nav.nav-pills');
  expect(list.length).toBe(1);
  return list.find('li').length;
}

let restoreEnv: () => void;

beforeEach(() => {
  restoreEnv = useTestEnv();
});

afterEach(() => {
  restoreEnv();
});

describe('renderCsettingsSecondaryMenu', () => {
  it.each(['list', 'LIST', '', 'editsite', 'listplugins'])('matches the legacy view on %j', (value) => {
    const out = render(adminS2Request({ rc: { originalfuseaction: value } }));
    expect(collapse(out)).toBe(legacyMenu(value));
  });

  it('lists Add New Site on list', () => {
    const out = render(adminS2Request({ rc: { originalfuseaction: 'list' } }));
    expect(collapse(out)).toBe(WITH_LINK);
    expect(out).toContain(`href="${ADD_SITE_HREF}"`);
    expect(out).not.toContain('&amp;');
    expect(itemCount(out)).toBe(1);
    expect(fragmentModel(out).links).toEqual([{ href: normaliseAdminUrl(ADD_SITE_HREF), text: 'Add New Site' }]);
    expect(fragmentModel(out).links[0]?.href).toBe('./?muraAction=csettings.edit&siteid=');
  });

  it.each(['LIST', 'List'])('matches %s case-insensitively', (value) => {
    const out = render(adminS2Request({ rc: { originalfuseaction: value } }));
    expect(collapse(out)).toBe(WITH_LINK);
    expect(itemCount(out)).toBe(1);
  });

  it.each(['', 'editsite', 'listplugins'])('renders an empty list on %j', (value) => {
    const out = render(adminS2Request({ rc: { originalfuseaction: value } }));
    expect(collapse(out)).toBe(EMPTY_LIST);
    expect(itemCount(out)).toBe(0);
    expect(fragmentModel(out).links).toEqual([]);
  });

  describe('without rc.originalfuseaction', () => {
    it('falls back to the default item', () => {
      const req = adminS2Request();
      expect('originalfuseaction' in req.rc).toBe(false);
      expect(req.item).toBe('redirect');
      const out = render(req);
      expect(collapse(out)).toBe(EMPTY_LIST);
      expect(fragmentModel(out).links).toEqual([]);
    });

    it('falls back to a list item', () => {
      const req = adminS2Request({ circuit: 'csettings', item: 'list' });
      expect('originalfuseaction' in req.rc).toBe(false);
      expect(req.item).toBe('list');
      const out = render(req);
      expect(collapse(out)).toBe(WITH_LINK);
      expect(itemCount(out)).toBe(1);
    });

    it('prefers rc.originalfuseaction over the item', () => {
      const out = render(adminS2Request({ circuit: 'csettings', item: 'list', rc: { originalfuseaction: 'editsite' } }));
      expect(collapse(out)).toBe(EMPTY_LIST);
    });
  });
});
