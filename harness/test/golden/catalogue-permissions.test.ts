import { readFileSync } from 'node:fs';
import { load } from 'cheerio';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCatalogue, scenarioById, type Scenario, type Step } from '../../src/golden/catalogue.js';
import {
  createScenarioContext,
  resolvePlaceholders,
  session,
  type ScenarioContext,
  type SecretStore,
  type SeedStore,
} from '../../src/golden/session.js';
import type { FetchLike } from '../../src/lib/http.js';

const SCENARIO_ID = 'GS-ID-07';
const LEGACY_URL = 'http://127.0.0.1:20080';
const PAGE_ID = '7C0D3B1E-2A4F-4C6D-9E8F0A1B2C3D4E5F';
const GROUP_ID = '5E1F0C2A-9B3D-4E7F-8A6B2C4D6E8F0A1B';
const CF_UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{16}$/;
const FIXTURE = new URL('../fixtures/http/cperm-main-default.html', import.meta.url);

const SECRETS: SecretStore = {
  secret: (name) => {
    throw new Error(`${SCENARIO_ID} forms read no secret, asked for ${name}`);
  },
  username: (site, role) => {
    throw new Error(`${SCENARIO_ID} forms read no username, asked for ${site}:${role}`);
  },
  values: () => [],
};

interface Call {
  url: string;
  method: string | undefined;
  body: unknown;
}

interface RenderedGroup {
  group: string;
  names: string[];
  values: string[];
}

let scenario: Scenario;

beforeAll(async () => {
  scenario = scenarioById(await loadCatalogue(), SCENARIO_ID);
});

/** Seed store answering GS-ID-07's seedRefs by dataset path, its group row carrying `groupID`. */
function seedStore(groupID: string): SeedStore {
  const rows: Record<string, unknown> = {
    'masa.content': { contentID: PAGE_ID, siteID: 'tenant-a', type: 'Page' },
    'masa.groups': { groupID, siteID: 'tenant-a', groupname: 'FIXTURE Team' },
  };
  return {
    select: (ref) => {
      if (!Object.hasOwn(rows, ref.path)) throw new Error(`unexpected seedRef path ${ref.path}`);
      return rows[ref.path];
    },
    businessDate: () => '2026-03-02',
  };
}

/** Fetch stub answering 200, recording each request. */
function recordingFetch(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    return new Response('ok', { status: 200 });
  };
  return { fetch, calls };
}

function contextFor(groupID: string, fetch: FetchLike): ScenarioContext {
  return createScenarioContext(scenario, {
    origin: 'legacy',
    env: { LEGACY_ORIGIN: LEGACY_URL },
    fetch,
    secrets: SECRETS,
    seed: seedStore(groupID),
  });
}

function stepNamed(name: string): Step & { form: Record<string, string> } {
  const step = scenario.steps.find((candidate) => candidate.name === name);
  if (step?.form === undefined) throw new Error(`${SCENARIO_ID} has no form step ${name}`);
  return step as Step & { form: Record<string, string> };
}

/** Permission rows of the cPerm.main capture paired with group ids from its cUsers.list links. */
function renderedGroups(): { groups: RenderedGroup[]; ids: Map<string, string> } {
  const $ = load(readFileSync(FIXTURE, 'utf8'));
  const ids = new Map<string, string>();
  for (const link of $('section[data-route*="cUsers.list"] td.var-width a').toArray()) {
    const id = new URL($(link).attr('href') ?? '', LEGACY_URL).searchParams.get('userid');
    if (id !== null) ids.set($(link).text().trim(), id);
  }
  const groups = $('section[data-route*="cPerm.main"] tr')
    .toArray()
    .map((row) => {
      const radios = $(row).find('input[type="radio"]').toArray();
      return {
        group: $(row).find('td.var-width').text().trim(),
        names: [...new Set(radios.map((radio) => $(radio).attr('name') ?? ''))],
        values: radios.map((radio) => $(radio).attr('value') ?? ''),
      };
    })
    .filter((row) => row.values.length > 0);
  return { groups, ids };
}

describe('GS-ID-07 permission forms', () => {
  it.each([
    ['grant-node', 'author'],
    ['restore-node', 'none'],
  ])('%s posts the group permission as p plus the dashless group id', async (name, value) => {
    const { fetch, calls } = recordingFetch();
    const ctx = contextFor(GROUP_ID, fetch);
    const step = stepNamed(name);
    const form = resolvePlaceholders(step.form, ctx);
    await session(ctx, step.as).post(resolvePlaceholders(step.route, ctx), { form });

    const expected =
      `p5E1F0C2A9B3D4E7F8A6B2C4D6E8F0A1B=${value}&chainID=&siteid=tenant-a` +
      '&topid=00000000000000000000000000000000001&moduleid=00000000000000000000000000000000000';
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe(expected);
    expect(new URLSearchParams(form).toString()).toBe(expected);
    const query = new URL(calls[0]?.url ?? '').searchParams;
    expect([query.get('muraAction'), query.get('contentid')]).toEqual(['cPerm.update', PAGE_ID]);
  });

  it('derives the radio name legacy cPerm.main renders for each group', () => {
    const { groups, ids } = renderedGroups();
    const grant = stepNamed('grant-node');
    expect(groups.length).toBeGreaterThan(0);
    for (const { group, names, values } of groups) {
      const id = ids.get(group);
      expect(id, `group id of ${group}`).toMatch(CF_UUID);
      expect(names).toEqual([`p${(id as string).replaceAll('-', '')}`]);
      const form = resolvePlaceholders(grant.form, contextFor(id as string, recordingFetch().fetch));
      const [rendered] = names;
      expect(Object.keys(form)).toContain(rendered);
      expect(values).toContain(form[rendered as string]);
    }
  });
});
