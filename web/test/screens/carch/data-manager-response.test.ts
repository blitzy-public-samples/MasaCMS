import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CsrfFormat, CsrfRenderer } from '@/lib/csrf';
import { isSafeHtml, raw, toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import {
  renderDataResponses,
  type DataResponseRow,
  type DataResponsesInput,
} from '@/screens/carch/data-manager/response';

// The `dsp_response.cfm` include captured from the legacy ACF 2023 server for a Form with three seeded responses, cut
// from the two newlines before `<div id="manage-data">` to its close; CSRF token values are `<token>`.
const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/strategies-content/datamanager-responses-${name}.html`, import.meta.url), 'utf8');

const FORM_ID = 'F0000000-0000-0000-0000000000000001';
const ROW_ANN: DataResponseRow = {
  responseId: 'A1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D',
  entered: '2026-06-01 13:05:00',
  data: {
    NAME: 'Ann <b>',
    EMAIL: 'a@b.com',
    RESUMEATTACHMENT: 'C1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D',
    MESSAGE: 'line one\nsee http://x.com/a',
  },
};
const ROW_INVALID: DataResponseRow = {
  responseId: 'B1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D',
  entered: '2026-06-15 10:00:00',
  data: null,
};
const ROW_BOB: DataResponseRow = {
  responseId: 'D1B2C3D4-E5F6-1A2B-3C4D5E6F7A8B9C0D',
  entered: '2026-06-30 09:41:00',
  data: { name: 'Bob' },
};

// The unfiltered view: no rc dates, so the preamble resolves them to the first and last entries.
const DEFAULT_VIEW: DataResponsesInput = {
  countEntered: 3,
  firstEntered: '2026-06-01 13:05:00',
  lastEntered: '2026-06-30 09:41:00',
  date1: { value: '2026-06-01 13:05:00', raw: "{ts '2026-06-01 13:05:00'}" },
  date2: { value: '2026-06-30 09:41:00', raw: "{ts '2026-06-30 09:41:00'}" },
  fieldnames: 'email,message,name,resumeattachment',
  sortBy: 'Entered',
  sortDirection: 'asc',
  filterBy: '',
  keywords: '',
  sessionFilterBy: '',
  sessionDataKeywords: '',
  contentid: FORM_ID,
  siteid: 'default',
  sessionSiteId: 'default',
  moduleid: '00000000000000000000000000000000004',
  columns: 'fixed',
  siteScheme: 'http',
  siteDomain: 'localhost',
  serverPort: ':25680',
  context: '',
  dateKeyFormat: 'MM/DD/YYYY',
  locale: 'en_US',
};
// View Data from 06/01/2026 00:00 to 06/30/2026 23:59; rc.hour1 is 0 while the From hour select follows the first entry.
const FILTERED_VIEW: DataResponsesInput = {
  ...DEFAULT_VIEW,
  date1: { value: '2026-06-01', raw: '06/01/2026' },
  date2: { value: '2026-06-30', raw: '06/30/2026' },
  hour1: '0',
  minute1: '0',
  hour2: '23',
  minute2: '59',
};
const KEYWORD_SEARCH = {
  sortBy: 'name',
  sortDirection: 'desc',
  filterBy: 'name',
  keywords: 'Bob',
  sessionFilterBy: 'name',
  sessionDataKeywords: 'Bob',
} as const;

/** A renderer that records its calls and renders the fixture's normalised tokens. */
function recordingCsrf(): { csrf: CsrfRenderer; prefetched: string[]; rendered: [string, CsrfFormat | undefined][] } {
  const prefetched: string[] = [];
  const rendered: [string, CsrfFormat | undefined][] = [];
  const csrf: CsrfRenderer = {
    tokens: () => Promise.reject(new Error('the panel only prefetches and renders')),
    prefetch: async (contexts) => {
      prefetched.push(...contexts);
    },
    render: (context, format) => {
      if (!prefetched.includes(context)) throw new Error(`CSRF tokens for context "${context}" have not been fetched`);
      rendered.push([context, format]);
      return raw('&csrf_token=<token>&csrf_token_expires=<token>');
    },
  };
  return { csrf, prefetched, rendered };
}

async function render(input: DataResponsesInput, csrf: CsrfRenderer = recordingCsrf().csrf): Promise<string> {
  const markup = await renderDataResponses({ csrf, rb: rbFor('en') }, input);
  expect(isSafeHtml(markup)).toBe(true);
  return toString(markup);
}

describe('renderDataResponses', () => {
  it.each<[string, DataResponsesInput]>([
    ['default', DEFAULT_VIEW],
    ['empty', { ...DEFAULT_VIEW, countEntered: 0, firstEntered: null, lastEntered: null }],
    ['filtered', { ...FILTERED_VIEW, results: { kind: 'rows', rows: [ROW_ANN, ROW_INVALID, ROW_BOB] } }],
    ['filtered-keywords', { ...FILTERED_VIEW, ...KEYWORD_SEARCH, results: { kind: 'rows', rows: [ROW_BOB] } }],
    ['deleted', { ...FILTERED_VIEW, ...KEYWORD_SEARCH, results: { kind: 'deleted', count: 1 } }],
  ])('matches the legacy %s view', async (name, input) => {
    expect(await render(input)).toBe(fixture(name));
  });

  it('issues CSRF tokens once, in url format, with each rendered response id as context', async () => {
    const { csrf, prefetched, rendered } = recordingCsrf();
    await render({ ...FILTERED_VIEW, results: { kind: 'rows', rows: [ROW_ANN, ROW_INVALID, ROW_BOB] } }, csrf);
    expect(prefetched).toEqual([ROW_ANN.responseId, ROW_BOB.responseId]);
    expect(rendered).toEqual([
      [ROW_ANN.responseId, 'url'],
      [ROW_BOB.responseId, 'url'],
    ]);
  });

  it.each<[string, DataResponsesInput['results']]>([
    ['no rows', { kind: 'rows', rows: [] }],
    ['a delete of no rows', { kind: 'deleted', count: 0 }],
    ['no query', undefined],
  ])('renders no results for %s', async (_, results) => {
    const markup = await render({ ...FILTERED_VIEW, results });
    expect(markup.endsWith('</form>\n\n</div>\n')).toBe(true);
  });

  it('selects field options by CFML eq, numerically for numbers', async () => {
    const markup = await render({ ...DEFAULT_VIEW, fieldnames: '01,Name', sortBy: '1.0', sessionFilterBy: 'NAME' });
    expect(markup).toContain('<option value="01" selected>01</option>');
    expect(markup).toContain('\n\t\t\t<option value="Name" selected>Name</option>');
  });

  it('fails as legacy getData does when rows exist without rc.hour2', async () => {
    const { csrf, prefetched } = recordingCsrf();
    const { hour2: _, ...withoutHour2 } = FILTERED_VIEW;
    const input: DataResponsesInput = { ...withoutHour2, results: { kind: 'rows', rows: [ROW_BOB] } };
    await expect(renderDataResponses({ csrf, rb: rbFor('en') }, input)).rejects.toThrow(
      'Element HOUR2 is undefined in RC.',
    );
    expect(prefetched).toEqual([]);
  });

  it('fails as ACF hour() does on an unconvertible first entry', async () => {
    await expect(render({ ...DEFAULT_VIEW, firstEntered: 'not a date' })).rejects.toThrow(RangeError);
  });
});
