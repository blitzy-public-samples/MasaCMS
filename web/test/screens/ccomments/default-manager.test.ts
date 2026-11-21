// The Comments Manager header toolbar of ccomments/default.cfm:104: S2 or the private-pool Admin of getSite(rc.siteid).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toString } from '@/lib/html';
import { ccommentsDefault } from '@/screens/ccomments/default';
import { COMMENTS_MODULE_ID, commentsSiteId } from '@/screens/ccomments/shared';
import { fragmentModel, normaliseAdminUrl } from '../../helpers/dom-model';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey } from '../../helpers/fake-gateway';
import { REQUESTED_SITE_CASES } from '../../helpers/requested-site';
import { makeScreenContext } from '../../helpers/screen-context';

const MANAGER = { circuit: 'ccomments', item: 'default' } as const;

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

describe('ccommentsDefault header toolbar', () => {
  it.each(REQUESTED_SITE_CASES)('renders for $who only when it administers that site', async ({ request, administers }) => {
    const req = request(MANAGER);
    const siteid = commentsSiteId(req);
    const gateway = fakeGatewayClient({
      [routeKey('GET', 'strategies-content', `/v1/sites/${siteid}/comments`)]: { status: 200, body: { rc: {} } },
    });
    const ctx = makeScreenContext({ req, gateway });

    const model = await ccommentsDefault.load!(ctx);
    const markup = toString((await ccommentsDefault.render(ctx, model)).body);

    expect(model.canManage).toBe(administers);
    const permissions = `./?muraAction=cPerm.module&contentid=${COMMENTS_MODULE_ID}&siteid=${siteid}&moduleid=${COMMENTS_MODULE_ID}`;
    expect(fragmentModel(markup).links.map(({ href }) => href)).toEqual(
      administers ? [normaliseAdminUrl(permissions)] : [],
    );
  });
});
