import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { renderContactInfoTab } from '@/screens/csettings/editsite/contact-info';
import type { EditSiteBean, EditSiteModel } from '@/screens/csettings/editsite/model';
import { fragmentModel } from '../../helpers/dom-model';

type ContactFields = Pick<
  EditSiteBean,
  'contactName' | 'contactAddress' | 'contactCity' | 'contactState' | 'contactZip' | 'contactPhone' | 'contactEmail'
>;

const here = import.meta.dirname ?? __dirname;
// Panes captured from legacy `cSettings.editSite&siteid=default`, before and after storing SPECIAL in `tsettings`.
const readCapture = (file: string): string =>
  readFileSync(path.resolve(here, '../../fixtures/programs-sites', file), 'utf8');

const EMPTY: ContactFields = {
  contactName: '',
  contactAddress: '',
  contactCity: '',
  contactState: '',
  contactZip: '',
  contactPhone: '',
  contactEmail: '',
};

const SPECIAL: ContactFields = {
  contactName: 'Ann "Q" O\'Neil <ops>',
  contactAddress: '12 Main St. & Co, Suite #4',
  contactCity: 'Zürich',
  contactState: 'a>b=c',
  contactZip: '00-123_4',
  contactPhone: '+1 (555) 010/2',
  contactEmail: 'ann+ops@example.com',
};

const LABELS = ['Contact Name', 'Contact Address', 'Contact City', 'Contact State', 'Contact Zip', 'Contact Phone', 'Contact Email'];
const NAMES = Object.keys(EMPTY);

/** Only the bean's contact fields are read by the tab, so the rest of the model is left out. */
function modelWith(contact: ContactFields): EditSiteModel {
  return { bean: contact } as unknown as EditSiteModel;
}

/** Rendered markup of the tab for `contact`. */
function render(contact: ContactFields): string {
  const markup = renderContactInfoTab(modelWith(contact));
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

describe('renderContactInfoTab', () => {
  it.each<[string, ContactFields, string]>([
    ['empty', EMPTY, 'editsite-contactinfo-empty.html'],
    ['special-character', SPECIAL, 'editsite-contactinfo-special.html'],
  ])('reproduces the legacy pane byte for byte for %s values', (_, contact, capture) => {
    expect(render(contact)).toBe(readCapture(capture));
  });

  it('gives the legacy DOM model, with each input holding the stored value', () => {
    const model = fragmentModel(render(SPECIAL));
    expect(model).toEqual(fragmentModel(readCapture('editsite-contactinfo-special.html')));
    expect(model.headings).toEqual(['Contact Info']);
    expect(model.labels).toEqual(LABELS);
    expect(model.controls.map((c) => [c.tag, c.name, c.type, c.value])).toEqual(
      NAMES.map((name) => ['input', name, 'text', SPECIAL[name as keyof ContactFields]]),
    );
  });

  it('nests the seven control groups in the pane, block and block content, keeping the first maxlength', () => {
    const $ = cheerio.load(render(SPECIAL), null, false);
    const groups = $('div#tabContactinfo.tab-pane > div.block.block-bordered > div.block-content > div.mura-control-group');
    expect(groups.length).toBe(7);
    expect($('div.block-header > h3.block-title').text()).toBe('Contact Info');
    groups.each((_, group) => {
      const input = $(group).children('input');
      expect($(group).children('label').text()).toMatch(/^Contact \w+ $/);
      expect([input.attr('size'), input.attr('maxlength')]).toEqual(['50', '50']);
    });
  });
});
