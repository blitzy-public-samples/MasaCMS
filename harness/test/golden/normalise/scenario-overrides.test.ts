import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { cfHash } from '@opt2/platform/legacy-compat';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, scenarioSchema, type Scenario } from '../../../src/golden/catalogue.js';
import {
  compareNormalised,
  createNormaliseState,
  loadRules,
  normaliseStep,
  type Difference,
  type NormaliseRules,
} from '../../../src/golden/normalise/index.js';
import type { StepRecord } from '../../../src/golden/steps.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=UTF-8';
const ORIGIN = 'http://127.0.0.1:8500';
const PAGE = 'gs-co-09-approval-page';
const NEXT_PAGE = 'gs-co-09-approval-page1';

let rules: NormaliseRules;
let approvals: Scenario;
let clients: Scenario;
let exportJobs: Scenario;
let tinyPdf: Buffer;

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  const catalogue = await loadCatalogue();
  approvals = scenarioById(catalogue, 'GS-CO-09');
  clients = scenarioById(catalogue, 'GS-ID-08');
  exportJobs = scenarioById(catalogue, 'GS-RE-01');
  tinyPdf = readFileSync(fileURLToPath(new URL('../../fixtures/exports/tiny.pdf', import.meta.url)));
});

/** A step record of `name` as the step runner records a 200 response; a JSON body carries its legacy ETag. */
function record(name: string, routeKey: string, contentType: string, body: string | Buffer): StepRecord {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (contentType === JSON_TYPE && typeof body === 'string') headers.etag = cfHash(body);
  return {
    name,
    index: 0,
    routeKey,
    request: { method: 'GET', url: '/admin/', headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers,
      contentType,
      sha256: createHash('sha256').update(body).digest('hex'),
      hops: [],
      ...(typeof body === 'string' ? { text: body } : { bytesBase64: body.toString('base64') }),
    },
    extracted: {},
  };
}

/** Differences between one-step runs of `golden` and `replay` under `scenario`, each side with fresh state. */
async function differences(scenario: Scenario, golden: StepRecord, replay: StepRecord): Promise<Difference[]> {
  const side = async (step: StepRecord) => ({
    steps: [await normaliseStep(step, { state: createNormaliseState(), rules, scenario })],
    sideEffects: {},
  });
  return compareNormalised(await side(golden), await side(replay), { rules, scenario });
}

describe('GS-CO-09 overrides', () => {
  const ids = {
    contentid: '04FAE8CF-9E4F-40AF-DC65641B2B037D12',
    contenthistid: '04FAFC03-BC66-C9B8-C05F179A8CDA01FF',
  };
  const otherIds = {
    contentid: '0570707D-C6CB-5A6B-B9EB7BC45C68F32E',
    contenthistid: '05708A24-EB26-4815-94E4935CCCEB8F65',
  };
  const RENDERED = `${ORIGIN}/index.cfm/_api/json/v1/tenant-a/content/_path`;
  const DRAFTS = './?muraAction=cArch.list&report=mydrafts&siteID=tenant-a';

  /** The saved-version read of the scenario's page, with `data` fields replaced by `changes`. */
  const savedVersion = (changes: Record<string, unknown> = {}, id = ids): StepRecord => {
    const data = {
      ...id,
      siteid: 'tenant-a',
      title: 'GS-CO-09 Approval Page',
      filename: PAGE,
      urltitle: PAGE,
      url: `${ORIGIN}/${PAGE}/`,
      assocurl: `${ORIGIN}/${PAGE}/`,
      body: '<p>GS-CO-09 Approval Page</p>',
      links: { rendered: `${RENDERED}/${PAGE}` },
      ...changes,
    };
    const envelope = { apiversion: 'v1', method: 'findOne', params: { siteid: 'tenant-a', id: id.contentid }, data };
    return record('saved-version', 'api:content.findone', JSON_TYPE, JSON.stringify(envelope));
  };

  /** The requester's edit form of the page: filename, URL title, body, preview link and header draft badge. */
  const editForm = (page = PAGE, body = 'GS-CO-09 Approval Page v2', drafts = '2', id = ids): StepRecord =>
    record(
      'submit-form',
      'admin:carch.edit',
      HTML_TYPE,
      `<html><head><title>Masa CMS</title></head><body>` +
        `<a href="${DRAFTS}"><span class="badge">${drafts}</span> Drafts</a>` +
        `<form id="contentForm" action="./?muraAction=cArch.update" method="post">` +
        `<input type="hidden" name="contentid" value="${id.contentid}">` +
        `<input type="text" name="filename" value="${page}"><input type="text" name="urlTitle" value="${page}">` +
        `<textarea name="body">&lt;p&gt;${body}&lt;/p&gt;</textarea></form>` +
        `<a href="${ORIGIN}/${page}/?previewid=${id.contenthistid}">Preview</a></body></html>`,
    );

  it('compares a run with other ids but the same values as equal', async () => {
    expect(await differences(approvals, savedVersion(), savedVersion({}, otherIds))).toStrictEqual([]);
    expect(await differences(approvals, editForm(), editForm(PAGE, undefined, undefined, otherIds))).toStrictEqual([]);
  });

  it.each<[string, () => StepRecord, string]>([
    ['filename', () => savedVersion({ filename: NEXT_PAGE }), 'envelope.data.filename'],
    ['URL title', () => savedVersion({ urltitle: NEXT_PAGE }), 'envelope.data.urltitle'],
    ['url', () => savedVersion({ url: `${ORIGIN}/${NEXT_PAGE}/` }), 'envelope.data.url'],
    ['assocurl', () => savedVersion({ assocurl: `${ORIGIN}/${NEXT_PAGE}/` }), 'envelope.data.assocurl'],
    ['rendered link', () => savedVersion({ links: { rendered: `${RENDERED}/${NEXT_PAGE}` } }), 'envelope.data.links.rendered'],
    ['body', () => savedVersion({ body: '<p>GS-CO-09 Approval Page v9</p>' }), 'envelope.data.body'],
  ])('reports a wrong %s in the saved version', async (_label, wrong, path) => {
    const found = await differences(approvals, savedVersion(), wrong());
    expect(found.map((difference) => [difference.path, difference.classification])).toStrictEqual([
      [path, 'difference'],
    ]);
  });

  it.each<[string, () => StepRecord, string[]]>([
    [
      'filename',
      () => editForm(NEXT_PAGE),
      ['domModel.controls[1].value', 'domModel.controls[2].value', 'domModel.links[1].href'],
    ],
    ['rendered body', () => editForm(PAGE, 'GS-CO-09 Approval Page v9'), ['domModel.controls[3].value']],
    ['draft count', () => editForm(PAGE, undefined, '3'), ['domModel.links[0].text']],
  ])('reports a wrong %s on the edit form', async (_label, wrong, paths) => {
    const found = await differences(approvals, editForm(), wrong());
    expect(found.map((difference) => difference.path)).toStrictEqual(paths);
  });
});

describe('GS-ID-08 domUnordered accounts', () => {
  const ACCOUNTS: readonly [string, string][] = [
    ['27C4FCE2-1996-41A1-26530CB53D4B2C83', 'Keshawn Abbott'],
    ['2E65064D-9DE9-98C9-FAD8C648035B90DF', 'Montana Abbott'],
    ['6FE42537-3D85-3E65-4640A5622E7EC6BF', 'Russel Abbott'],
    ['9AF28F80-F0B4-610E-7FE9BDEB630A9A00', 'Jacinthe Abbott'],
  ];
  const SELECTED = ACCOUNTS[2]![0];
  const SECRET = createHash('sha256').update('opt2-gs-id-08').digest('hex').toUpperCase();

  /** The cwebservice.edit form with `accounts` as Connected Account options, `selected` marked selected. */
  const editPage = (accounts: readonly (readonly [string, string])[], selected: string = SELECTED): StepRecord =>
    record(
      'new',
      'admin:cwebservice.edit',
      HTML_TYPE,
      `<html><head><title>Masa CMS</title></head><body><form name="form1" method="post">` +
        `<input type="hidden" name="clientsecret" value="${SECRET}">` +
        `<label>Connected Account</label>\n<select name="userid">\n<option value="">-- Select Account --</option>\n` +
        accounts
          .map(([id, name]) => `<option value="${id}"${id === selected ? ' selected' : ''}>${name}</option>`)
          .join('\n') +
        `\n</select></form><a href="./?muraAction=cUsers.edituser&userid=${SELECTED}">Owner</a></body></html>`,
    );

  const reversed = [...ACCOUNTS].reverse();

  it.each<[string, () => StepRecord, boolean]>([
    ['reversed options', () => editPage(reversed), true],
    ['options in another order', () => editPage([ACCOUNTS[1]!, ACCOUNTS[3]!, ACCOUNTS[0]!, ACCOUNTS[2]!]), true],
    ['a missing option', () => editPage(ACCOUNTS.slice(1)), false],
    ['an extra option', () => editPage([...ACCOUNTS, ['A1B2C3D4-E5F6-A7B8-C9D0E1F2A3B4C5D6', 'Zed Extra']]), false],
    ['another selected option', () => editPage(reversed, ACCOUNTS[0]![0]), false],
    ['no selected option', () => editPage(ACCOUNTS, ''), false],
    ['a renamed account', () => editPage([...ACCOUNTS.slice(0, 3), [ACCOUNTS[3]![0], 'Jacinthe Abbot']]), false],
  ])('compares %s as equal: %s', async (_label, replay, equal) => {
    const found = await differences(clients, editPage(ACCOUNTS), replay());
    expect(found.length === 0, JSON.stringify(found)).toBe(equal);
  });

  it('keeps the options in document order without the override', async () => {
    const plain = scenarioSchema.parse({ ...clients, normalisationOverrides: { extraTokenFields: ['clientsecret'] } });
    const found = await differences(plain, editPage(ACCOUNTS), editPage(reversed));
    expect(found.length).toBeGreaterThan(0);
  });

  // Canonical markup lists attributes by name, so the selected option (`selected` before `value`) sorts first.
  it('models the sorted options with the secret masked and the selected account kept', async () => {
    const step = await normaliseStep(editPage(reversed), { state: createNormaliseState(), rules, scenario: clients });
    const userid = step.domModel?.controls.find((control) => control.name === 'userid');
    expect(userid?.options?.map((option) => [option.label, option.selected])).toStrictEqual([
      ['Russel Abbott', true],
      ['-- Select Account --', false],
      ['Jacinthe Abbott', false],
      ['Keshawn Abbott', false],
      ['Montana Abbott', false],
    ]);
    expect(step.domModel?.controls[0]?.value).toBe(rules.tokens.placeholder);
    expect(JSON.stringify(step)).not.toContain(SECRET);
  });
});

describe('GS-RE-01 dropPaths export byte hashes', () => {
  const TYPES = {
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    pdf: 'application/pdf',
  } as const;
  type Format = keyof typeof TYPES;
  const FORMATS = Object.keys(TYPES) as Format[];
  const JOB_IDS: Record<Format, string> = {
    xlsx: '56856E16-008F-601A-E2F97704648B4AA3',
    csv: '5A1F7C20-11B2-4C3D-8E9F0A1B2C3D4E5F',
    pdf: '5B2E8D31-22C3-4D4E-9FA01B2C3D4E5F60',
  };
  const TIMESHEET_ID = '7EDFAD01-DC76-57C6-993CE5D531B1DBC7';

  const fileHash = (side: string, format: Format): string =>
    createHash('sha256').update(`${side} ${format} bytes`).digest('hex');

  /** A done job of `format` whose file `side` produced, with `changes` over its fields. */
  const job = (format: Format, side: string, changes: Record<string, unknown> = {}) => ({
    job_id: JOB_IDS[format],
    format,
    state: 'done',
    content_type: TYPES[format],
    file_name: `export-${JOB_IDS[format]}.${format}`,
    output_sha256: fileHash(side, format),
    ...changes,
  });

  const envelope = (data: unknown): string => JSON.stringify({ apiversion: 'v1', method: 'reporting.exports', data });

  const poll = (format: Format, side: string, changes?: Record<string, unknown>): StepRecord =>
    record(`${format}-poll`, 'fixture:reporting/exports/{id}@get', JSON_TYPE, envelope(job(format, side, changes)));

  /** The job list; `pdfChanges` apply to its PDF job. */
  const list = (side: string, pdfChanges?: Record<string, unknown>): StepRecord =>
    record(
      'list',
      'fixture:reporting/exports@get',
      JSON_TYPE,
      envelope({ endindex: 3, items: FORMATS.map((f) => job(f, side, f === 'pdf' ? pdfChanges : {})) }),
    );

  const download = (format: Format, body: string | Buffer): StepRecord =>
    record(`${format}-download`, 'fixture:reporting/exports/{id}/download@get', TYPES[format], body);

  const csv = (status: string): string => `timesheet_id,status\r\n${TIMESHEET_ID},${status}\r\n`;

  const workbook = async (status: string): Promise<Buffer> => {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('export').addRows([['timesheet_id', 'status'], [TIMESHEET_ID, status]]);
    return Buffer.from(await book.xlsx.writeBuffer());
  };

  // Same-length text keeps tiny.pdf's stream length and xref offsets valid.
  const pdf = (text: string): Buffer => Buffer.from(tinyPdf.toString('latin1').replace('page 1', text), 'latin1');

  it.each<[string, () => Promise<[StepRecord, StepRecord]>, string[]]>([
    ['xlsx-poll with another file hash', async () => [poll('xlsx', 'legacy'), poll('xlsx', 'target')], []],
    ['csv-poll with another file hash', async () => [poll('csv', 'legacy'), poll('csv', 'target')], []],
    ['pdf-poll with another file hash', async () => [poll('pdf', 'legacy'), poll('pdf', 'target')], []],
    ['list with other file hashes', async () => [list('legacy'), list('target')], []],
    [
      'xlsx-poll with another state',
      async () => [poll('xlsx', 'legacy'), poll('xlsx', 'target', { state: 'failed' })],
      ['envelope.data.state'],
    ],
    [
      'list with another PDF file name',
      async () => [list('legacy'), list('target', { file_name: 'export.pdf' })],
      ['envelope.data.items[2].file_name'],
    ],
    [
      'csv-download with another cell',
      async () => [download('csv', csv('APPROVED')), download('csv', csv('RETURNED'))],
      ['export.rows[1][1]'],
    ],
    [
      'xlsx-download with another cell',
      async () => [download('xlsx', await workbook('APPROVED')), download('xlsx', await workbook('RETURNED'))],
      ['export.sheets[0].rows[1][1]'],
    ],
    [
      'pdf-download with other page text',
      async () => [download('pdf', tinyPdf), download('pdf', pdf('page 2'))],
      ['export.pages[0]'],
    ],
  ])('compares %s with differences at %j', async (_label, sides, paths) => {
    const [golden, replay] = await sides();
    const found = await differences(exportJobs, golden, replay);
    expect(found.map((difference) => [difference.path, difference.classification])).toStrictEqual(
      paths.map((path) => [path, 'difference']),
    );
  });
});
