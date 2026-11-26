// cChangesets removeitem and delete as registered behind before(), and the withheld rollback's implementation on the
// request before() leaves (cchangesets.cfc 149-192): the relayed strategies-content write on tenant-a, then FW/1's
// redirect (framework.cfc 723-783) whatever the CSRF outcome.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { components } from '@/generated/clients/strategies-content';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { encodeUrl } from '@/lib/html';
import { applyCchangesetsDefaults, cchangesetsScreens } from '@/screens/cchangesets';
import { changesetRollbackScreen } from '@/screens/cchangesets/rollback';
import type { Rc, RedirectScreen, SubmitResult } from '@/screens/registry';
import { CONTENT_HIST_IDS } from '../../fixtures/strategies-content/carch';
import { CHANGESET_IDS } from '../../fixtures/strategies-content/changesets';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeRoute } from '../../helpers/fake-gateway';
import { FIXED_CSRF, makeScreenContext } from '../../helpers/screen-context';

type AdminWriteResult = components['schemas']['AdminWriteResult'];
type Fields = Readonly<Record<string, string>>;

const SITE = 'tenant-a';
const SERVICE = 'strategies-content';
const KEYWORDS = 'home page&x';
const CSRF_FIELDS: Fields = { csrf_token: FIXED_CSRF.token, csrf_token_expires: FIXED_CSRF.expires };

const changesetPath = (changesetId: string): ServicePath => `/v1/sites/${SITE}/changesets/${changesetId}`;

/** One post action: the owner's contract route, the request fields and the controller's FW/1 redirect. */
interface WriteCase {
  readonly action: 'rollback' | 'removeitem' | 'delete';
  readonly path: ServicePath;
  readonly rc: Fields;
  /** `redirect(action="cChangesets.<target>", append=<append>, path="./")`. */
  readonly target: string;
  readonly append: readonly string[];
  readonly location: string;
}

const ASSIGNMENTS_LOCATION = `./?muraAction=cChangesets.assignments&changesetID=${CHANGESET_IDS.open}&siteID=${SITE}`;

const REMOVE_ITEM: WriteCase = {
  action: 'removeitem',
  path: `${changesetPath(CHANGESET_IDS.open)}/items/${CONTENT_HIST_IDS.aboutUs}/remove`,
  rc: {
    siteid: SITE,
    changesetID: CHANGESET_IDS.open,
    contentHistID: CONTENT_HIST_IDS.aboutUs,
    keywords: KEYWORDS,
    ...CSRF_FIELDS,
  },
  target: 'assignments',
  append: ['changesetID', 'siteID', 'keywords'],
  location: `${ASSIGNMENTS_LOCATION}&keywords=${encodeUrl(KEYWORDS)}`,
};

// publish has no case: it writes the withheld tcontenteventreminders table, so it stays legacy with no web screen.
const CASES: readonly WriteCase[] = [
  {
    action: 'rollback',
    path: `${changesetPath(CHANGESET_IDS.published)}/rollback`,
    rc: { siteid: SITE, changesetID: CHANGESET_IDS.published, keywords: KEYWORDS, ...CSRF_FIELDS },
    target: 'edit',
    append: ['changesetID', 'siteID'],
    location: `./?muraAction=cChangesets.edit&changesetID=${CHANGESET_IDS.published}&siteID=${SITE}`,
  },
  REMOVE_ITEM,
  {
    action: 'delete',
    path: `${changesetPath(CHANGESET_IDS.open)}/delete`,
    rc: { siteid: SITE, changesetID: CHANGESET_IDS.open, keywords: KEYWORDS, ...CSRF_FIELDS },
    target: 'list',
    append: ['changesetID', 'siteID'],
    location: `./?muraAction=cChangesets.list&changesetID=${CHANGESET_IDS.open}&siteID=${SITE}`,
  },
];

/** The registered definition of `cchangesets.<action>`, its submit behind the circuit's `before()` defaults. */
function registered(action: WriteCase['action']): RedirectScreen {
  const screen = cchangesetsScreens.find((candidate) => candidate.action === action);
  if (screen?.mode !== 'redirect') throw new TypeError(`cchangesets.${action} is not a registered post action`);
  return screen;
}

/** The submit of `cchangesets.<action>`: the registered one, or the withheld rollback's on the defaulted request. */
function submitOf(action: WriteCase['action']): RedirectScreen['submit'] {
  if (action !== 'rollback') return registered(action).submit;
  return (ctx) => {
    ctx.req = { ...ctx.req, rc: applyCchangesetsDefaults(ctx.req.rc) };
    return changesetRollbackScreen.submit(ctx);
  };
}

/** The S2 admin posting `rc` to `cchangesets.<action>`. */
const requestFor = (action: WriteCase['action'], rc: Fields) =>
  adminS2Request({ circuit: 'cchangesets', item: action, rc });

/** strategies-content's answer: `saved` as the token validated, and the controller's redirect over the posted form. */
function ownerAnswer(c: WriteCase, saved: boolean): FakeRoute {
  return ({ form = {} }) => {
    const params = c.append.flatMap((key): Array<[string, string]> => {
      const value = Object.entries(form).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
      return typeof value === 'string' ? [[key, value]] : [];
    });
    const redirect = { circuit: 'cChangesets', action: c.target, params };
    const body: AdminWriteResult = { saved, errors: {}, redirect };
    return { status: 200, body };
  };
}

// Built here rather than through fw1RedirectTarget, which @/lib/urls holds outside this suite's dependencies.
/** The non-SES `Location` FW/1 `redirect()` sends for `result`, url-encoding each listed `append` key `rc` holds. */
function locationOf(result: SubmitResult, rc: Rc): string {
  if (result.kind === 'location') return result.location;
  if (result.kind !== 'redirect') throw new TypeError(`A ${result.kind} outcome is not a redirect`);
  const appended = (result.append ?? '').split(',').flatMap((key) => {
    const value = rc[key];
    return value === undefined ? [] : [`${key}=${encodeUrl(value)}`];
  });
  const query = [...appended, result.queryString ?? ''].filter((part) => part !== '').join('&');
  return `${result.path ?? ''}?muraAction=${result.action}${query === '' ? '' : `&${query}`}`;
}

let restore: () => void;
beforeEach(() => {
  restore = useTestEnv();
});
afterEach(() => {
  restore();
});

describe.each(CASES)('cChangesets.$action', (c) => {
  const route = routeKey('POST', SERVICE, c.path);

  it.each([
    { outcome: 'writes', saved: true },
    { outcome: 'skips the write', saved: false },
  ])('relays the request before() leaves and redirects as legacy when the owner $outcome', async ({ saved }) => {
    const req = requestFor(c.action, c.rc);
    const ctx = makeScreenContext({ req, gateway: fakeGatewayClient({ [route]: ownerAnswer(c, saved) }) });

    const result = await submitOf(c.action)(ctx);

    expect(ctx.gateway.calls).toEqual([
      {
        service: SERVICE,
        method: 'POST',
        path: c.path,
        form: Object.fromEntries(Object.entries(applyCchangesetsDefaults(req.rc))),
      },
    ]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject(c.rc);
    expect(locationOf(result, ctx.req.rc)).toBe(c.location);
  });

  it('fails closed when the gateway is unavailable', async () => {
    const gateway = fakeGatewayClient();
    const outage = new GatewayUnavailableError(SERVICE);
    gateway.failWith(outage);
    const ctx = makeScreenContext({ req: requestFor(c.action, c.rc), gateway });

    await expect(submitOf(c.action)(ctx)).rejects.toBe(outage);
    expect(gateway.calls).toHaveLength(1);
  });
});

describe('cChangesets.removeitem keywords', () => {
  const withoutKeywords = Object.fromEntries(Object.entries(REMOVE_ITEM.rc).filter(([name]) => name !== 'keywords'));

  it.each([
    { keywords: 'left to the before() default', rc: withoutKeywords },
    { keywords: 'empty', rc: { ...withoutKeywords, keywords: '' } },
  ])('appends an empty keywords when $keywords', async ({ rc }) => {
    const route = routeKey('POST', SERVICE, REMOVE_ITEM.path);
    const gateway = fakeGatewayClient({ [route]: ownerAnswer(REMOVE_ITEM, true) });
    const ctx = makeScreenContext({ req: requestFor('removeitem', rc), gateway });

    const result = await registered('removeitem').submit(ctx);

    expect(gateway.calls[0]?.form).toMatchObject({ keywords: '' });
    expect(locationOf(result, ctx.req.rc)).toBe(`${ASSIGNMENTS_LOCATION}&keywords=`);
  });
});
