// cfeed.edit against bodies captured from the legacy ACF 2023 server under five renderer and global configurations.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCsrfRenderer } from '@/lib/csrf';
import { resetLegacySettingsForTests } from '@/lib/env';
import { toString } from '@/lib/html';
import { rbFor } from '@/lib/resource-bundles/rb';
import { renderFeedEdit } from '@/screens/cfeed/edit';
import { loadFeedEditModel } from '@/screens/cfeed/edit-model';
import type { ScreenContext } from '@/screens/registry';
import { adminS2Request } from '../../helpers/admin-request';
import { fragmentModel } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type RecordedRequest } from '../../helpers/fake-gateway';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/strategies-content');

/** The CSRF pair the fixtures carry in place of the captured one. */
const CSRF = { token: 'TESTCSRFTOKEN0000000000000000000', expires: '260630150000000' } as const;

/** The feed API endpoint of the capturing server's `default` site. */
const ENDPOINT = 'http://localhost:22380/_api/feed/v1/default';

/** The core content renderer's `defaultCollectionDisplayList`, which the installed theme inherits. */
const CORE_LIST = 'Date,Title,Image,Summary,Credits';

/** The content version holding both captured display object instances. */
const INSTANCE_HISTORY = '3BE4B6EE-B691-7668-7949CEF63B83E540';

type Row = Record<string, unknown>;

/** A legacy configuration: the site renderer's metadata and the `MURA_` variables the server started with. */
interface LegacyConfig {
  readonly useLayoutManager: boolean;
  readonly defaultCollectionDisplayList: string;
  readonly env: Readonly<Record<string, string>>;
}

const PROXY_SERVER = { MURA_PROXYSERVER: 'proxy.example.test' } as const;
const PROXY_USER = { MURA_PROXYUSER: 'proxyuser' } as const;

/** `base`: the installed theme (layout manager on); `lmoff`: a theme renderer with its own list, no layout manager. */
const CONFIGS = {
  base: { useLayoutManager: true, defaultCollectionDisplayList: CORE_LIST, env: {} },
  lmoff: { useLayoutManager: false, defaultCollectionDisplayList: 'Title,Summary,Date', env: {} },
  'proxyboth-usageoff': {
    useLayoutManager: true,
    defaultCollectionDisplayList: CORE_LIST,
    env: { ...PROXY_SERVER, ...PROXY_USER, MURA_SHOWUSAGETABS: 'false' },
  },
  'proxyserver-only': { useLayoutManager: true, defaultCollectionDisplayList: CORE_LIST, env: PROXY_SERVER },
  'proxyuser-only': { useLayoutManager: true, defaultCollectionDisplayList: CORE_LIST, env: PROXY_USER },
} as const satisfies Record<string, LegacyConfig>;

type ConfigName = keyof typeof CONFIGS;

/** The advanced filter row legacy stores for a Local collection saved without filters. */
const EMPTY_FILTER: Row = { param: 1, relationship: '', field: '', condition: '', criteria: '', dataType: 'varchar' };

/** A saved collection's `getAllValues()`: its `tcontentfeeds` row (NULL as '') over the feedBean defaults. */
function savedFeed(values: Row): Row {
  return {
    siteID: 'default',
    parentID: '',
    altName: '',
    lang: 'en-us',
    isActive: 1,
    showNavOnly: 1,
    showExcludeSearch: 0,
    isPublic: 0,
    isDefault: 0,
    description: '',
    contentID: '',
    categoryID: '',
    maxItems: 20,
    allowHTML: 1,
    isFeaturesOnly: 0,
    restricted: 0,
    restrictGroups: '',
    version: 'RSS 2.0',
    channelLink: '',
    authtype: 'DEFAULT',
    type: 'Local',
    sortBy: 'lastUpdate',
    sortDirection: 'desc',
    nextN: 20,
    displayName: 0,
    displayRatings: 0,
    displayComments: 0,
    isNew: 0,
    params: [],
    errors: {},
    imageSize: 'small',
    imageHeight: 'AUTO',
    imageWidth: 'AUTO',
    displayList: 'Date,Title,Image,Summary,Credits,Tags',
    viewalllink: '',
    viewalllabel: '',
    autoimport: 0,
    isLocked: 0,
    cssClass: '',
    useCategoryIntersect: 0,
    contentpoolid: 'default',
    ...values,
  };
}

const LOCAL_EMPTY = savedFeed({
  feedID: '4AF5606F-A1BC-7084-A6DCD411EEEB1BE7',
  name: 'Cap Local Empty List',
  displayList: '',
  params: [EMPTY_FILTER],
});
const LOCAL_DEFAULT = savedFeed({
  feedID: '4AF5706E-A446-2599-71A4084CF819763A',
  name: 'Cap Local Default',
  params: [EMPTY_FILTER],
});
const remoteFeed = (feedID: string, name: string, authtype: string): Row => {
  const channelLink = `https://example.com/${authtype.toLowerCase()}.xml`;
  return savedFeed({ feedID, name, type: 'Remote', authtype, channelLink });
};

/** A captured `cFeed.edit`: its query and the collection, plus any screen model members it adds. */
interface Capture {
  readonly rc: Readonly<Record<string, string>>;
  readonly feedBean: Row;
  readonly model?: Row;
}

const instance = (feedBean: Row, orderno: string, params: string): Capture => ({
  rc: {
    type: 'Local',
    feedID: String(feedBean.feedID),
    assignmentID: INSTANCE_HISTORY,
    regionID: '2',
    orderno,
    compactDisplay: 'true',
  },
  feedBean,
  model: { rsDisplayObject: [{ object: 'feed', params }] },
});

const CAPTURES = {
  'local-empty': { rc: { type: 'Local', feedID: String(LOCAL_EMPTY.feedID) }, feedBean: LOCAL_EMPTY },
  'local-default': { rc: { type: 'Local', feedID: String(LOCAL_DEFAULT.feedID) }, feedBean: LOCAL_DEFAULT },
  'local-instance-plain': instance(LOCAL_EMPTY, '1', ''),
  'local-instance-json': instance(LOCAL_DEFAULT, '2', '{"displayList":"","maxItems":"7"}'),
  'remote-ntlm': {
    rc: { type: 'Remote', feedID: '4AF58CC6-A051-F03A-01C23C09441E9DFC' },
    feedBean: remoteFeed('4AF58CC6-A051-F03A-01C23C09441E9DFC', 'Cap Remote NTLM', 'NTLM'),
  },
  'remote-proxy': {
    rc: { type: 'Remote', feedID: '4AF594AD-0587-C7BE-88D73322E0CB5B03' },
    feedBean: remoteFeed('4AF594AD-0587-C7BE-88D73322E0CB5B03', 'Cap Remote PROXY', 'PROXY'),
  },
} as const satisfies Record<string, Capture>;

type CaptureName = keyof typeof CAPTURES;

/** The `getFeed` screen model strategies-content serves for `capture` on a site renderer configured as `config`. */
function screenModel(capture: Capture, config: LegacyConfig): Row {
  return {
    feedBean: capture.feedBean,
    rsRestrictGroups: [],
    rslist: [],
    rsExtendedAttributes: [],
    hasCategories: 0,
    categories: [],
    imageSizes: [{ name: 'carouselimage' }],
    contentPool: [{ siteID: 'default', site: 'Default' }],
    rsUsage: [],
    useLayoutManager: config.useLayoutManager,
    defaultCollectionDisplayList: config.defaultCollectionDisplayList,
    endpoint: ENDPOINT,
    ...capture.model,
  };
}

/** The screen's body for `capture` under `config`, read through a gateway serving its screen model. */
async function renderCapture(configName: ConfigName, captureName: CaptureName): Promise<string> {
  const config: LegacyConfig = CONFIGS[configName];
  const capture: Capture = CAPTURES[captureName];
  for (const key of Object.keys(process.env)) if (key.startsWith('MURA_')) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(config.env)) vi.stubEnv(key, value);
  resetLegacySettingsForTests();

  const req = adminS2Request({
    circuit: 'cfeed',
    item: 'edit',
    rc: capture.rc,
    site: { hasComments: true, hasFeedManager: true },
  });
  const gateway = fakeGatewayClient({
    [routeKey('GET', 'strategies-content', `/v1/sites/default/feeds/${String(capture.feedBean.feedID)}`)]: {
      status: 200,
      body: { rc: screenModel(capture, config) },
    },
    [routeKey('POST', 'identity', '/v1/csrf/tokens')]: (sent: RecordedRequest) => ({
      status: 200,
      body: {
        tokens: (sent.json as { contexts: string[] }).contexts.map((context) => ({
          context,
          [CSRF_FIELD_TOKEN]: CSRF.token,
          [CSRF_FIELD_EXPIRES]: CSRF.expires,
        })),
      },
    }),
  });
  const ctx: ScreenContext = {
    req,
    gateway,
    csrf: createCsrfRenderer(gateway),
    rb: rbFor('en'),
    hooks: { secondaryMenus: {} },
    now: new Date('2026-11-13T09:46:00Z'),
  };
  // As the screen's load and render do: the loader replaces `ctx.req` with the defaulted request.
  const model = await loadFeedEditModel(ctx.req, ctx);
  return toString((await renderFeedEdit(ctx.req, ctx, model, { fuseaction: 'edit' })).body);
}

/** A captured legacy body, CSRF pair replaced; Local bodies run through the `setSearchButtons` script. */
const fixture = (configName: ConfigName, captureName: CaptureName): string =>
  readFileSync(path.join(FIXTURES, `cfeed-edit-${configName}-${captureName}.html`), 'utf8');

/** Markup with whitespace runs collapsed to one space and dropped next to tag delimiters. */
const collapsed = (markup: string): string =>
  markup.replace(/\s+/g, ' ').replace(/> /g, '>').replace(/ </g, '<').trim();

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  restore();
});

describe('cfeed.edit under legacy renderer and global configurations', () => {
  it.each<[ConfigName, CaptureName]>([
    ['base', 'remote-ntlm'],
    ['lmoff', 'remote-ntlm'],
    ['proxyboth-usageoff', 'remote-ntlm'],
    ['proxyserver-only', 'remote-proxy'],
    ['proxyuser-only', 'remote-ntlm'],
  ])('reproduces the %s %s capture byte for byte', async (configName, captureName) => {
    expect(await renderCapture(configName, captureName)).toBe(fixture(configName, captureName));
  });

  // The Local branch's markup differs from legacy's only in inter-tag whitespace, so it is held to the DOM model.
  it.each<[ConfigName, CaptureName]>([
    ['base', 'local-default'],
    ['lmoff', 'local-empty'],
    ['lmoff', 'local-instance-plain'],
    ['lmoff', 'local-instance-json'],
    ['proxyboth-usageoff', 'local-default'],
  ])('reproduces the %s %s capture up to whitespace', async (configName, captureName) => {
    const body = await renderCapture(configName, captureName);
    const expected = fixture(configName, captureName);
    expect(fragmentModel(body)).toEqual(fragmentModel(expected));
    expect(collapsed(body)).toBe(collapsed(expected));
  });
});
