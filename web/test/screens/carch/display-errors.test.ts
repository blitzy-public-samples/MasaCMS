import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSafeHtml, toString } from '@/lib/html';
import { renderSiteFull } from '@/screens/carch/form/full';
import { displayErrors, type DisplayErrors } from '@/screens/carch/partials/display-errors';

const here = import.meta.dirname ?? __dirname;
const DSP_FULL = path.resolve(here, '../../../../admin/core/views/carch/form/dsp_full.cfm');

describe('displayErrors', () => {
  it.each<[string, DisplayErrors, string]>([
    ['no errors', {}, ''],
    ['one error', { title: 'The title is required.' }, 'The title is required. '],
    ['two errors in order', [['title', 'A'], ['body', 'B']], 'A <br> B '],
    ['a trailing siteID', [['title', 'A'], ['siteID', 'default']], 'A <br> '],
    ['a leading siteid', [['siteid', 'default'], ['title', 'A']], 'A '],
    ['siteID alone', [['SiteID', 'default']], ''],
    ['a struct with siteID last', { title: 'A', body: 'B', siteID: 'default' }, 'A <br> B <br> '],
    ['message markup unencoded', [['title', '<strong>A</strong> &amp; B']], '<strong>A</strong> &amp; B '],
  ])('renders %s', (_, errors, expected) => {
    const markup = displayErrors(errors);
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(expected);
  });
});

describe('renderSiteFull', () => {
  it('matches form/dsp_full.cfm', () => {
    const source = readFileSync(DSP_FULL, 'utf8').replaceAll('\r\n', '\n');
    const body = source.slice(source.indexOf('<cfoutput>') + '<cfoutput>'.length, source.lastIndexOf('</cfoutput>'));
    const markup = renderSiteFull();
    expect(isSafeHtml(markup)).toBe(true);
    expect(toString(markup)).toBe(body.trimStart());
  });
});
