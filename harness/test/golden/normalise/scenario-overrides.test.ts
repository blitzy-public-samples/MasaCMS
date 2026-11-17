import { createHash } from 'node:crypto';
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

beforeAll(async () => {
  rules = loadRules(undefined, { PORT: '8500' });
  const catalogue = await loadCatalogue();
  approvals = scenarioById(catalogue, 'GS-CO-09');
  clients = scenarioById(catalogue, 'GS-ID-08');
});

/** A step record of `name` as the step runner records a 200 response; a JSON body carries its legacy ETag. */
function record(name: string, routeKey: string, contentType: string, text: string): StepRecord {
  const headers: Record<string, string> = { 'content-type': contentType };
  if (contentType === JSON_TYPE) headers.etag = cfHash(text);
  return {
    name,
    index: 0,
    routeKey,
    request: { method: 'GET', url: '/admin/', headers: {}, body: { kind: 'none' } },
    response: {
      status: 200,
      headers,
      contentType,
      sha256: createHash('sha256').update(text).digest('hex'),
      hops: [],
      text,
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
