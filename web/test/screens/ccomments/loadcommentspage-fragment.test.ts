// cComments.loadCommentsPage against ccomments/loadcommentspage.cfm: the owner's fragment bytes, relayed unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGate } from '@/lib/access-gate';
import { GatewayDenialError } from '@/lib/gateway-client';
import type { AdminRequest } from '@/lib/request-context';
import { ccommentsLoadCommentsPage } from '@/screens/ccomments/loadcommentspage';
import { CCOMMENTS_OWNER, ccommentsGate } from '@/screens/ccomments/shared';
import type { RawBody, ScreenContext } from '@/screens/registry';
import { adminS2Request, editorRequest } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeReply } from '../../helpers/fake-gateway';

const PATH = '/v1/raw/ccomments/loadcommentspage';
const ROUTE = routeKey('GET', 'strategies-content', PATH);
// The view's default content type, as the ACF 2023 oracle sends it.
const VIEW_TYPE = 'text/html;charset=UTF-8';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
const FIRST_ID = 'A0000000-0000-0000-0000000000000001';
const REPLY_ID = 'A0000000-0000-0000-0000000000000002';
const NEXT_ID = 'A0000000-0000-0000-0000000000000003';
// Two fixture comments as the view writes them: a Gravatar, a reply, missing-key labels and a more-down anchor.
const PAGE = [
  '\t<div id="commentsPage">',
  `\t\t\t<dl id="detail-${FIRST_ID}">`,
  '\t\t\t\t\t<dd class="gravatar"><img src="http://www.gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346" /></dd>',
  '\t\t\t\t<dt>\n\t\t\t\t\tAda &amp; Co\n\t\t\t\t</dt>',
  '\t\t\t\t<dd class="comment">\n\t\t\t\t\t<p>First &lt;b&gt;post</p>\n\t\t\t\t</dd>',
  '\t\t\t\t<dd class="date-time">\n\t\t\t\t\tJune 30, 2026, 9:15 AM\n\t\t\t\t</dd>\n\t\t\t</dl>',
  `\t\t\t<dl id="detail-${REPLY_ID}">`,
  '\t\t\t\t\t<dd class="gravatar"><img src="/sites/default/cache/file/F1_medium.jpg"></dd>',
  `\t\t\t\t<dt>\n\t\t\t\t\tBo\n\t\t\t\t\t\t<em>(comments.inreplyto_missing: <a href="#" class="inReplyTo" data-parentid="${FIRST_ID}" data-contentid="${CONTENT_ID}">Ada &amp; Co</a>)</em>\n\t\t\t\t</dt>`,
  '\t\t\t\t<dd class="comment">\n\t\t\t\t\t<p>Caf&eacute;</p>\n\t\t\t\t</dd>',
  '\t\t\t\t<dd class="date-time">\n\t\t\t\t\tJune 30, 2026, 9:20 AM\n\t\t\t\t</dd>\n\t\t\t</dl>',
  `\t\t\t<div id="moreCommentsDownContainer"><a id="moreCommentsDown" class="btn btn-small" href="#" data-lowerid="${NEXT_ID}"><i class="mi-arrow-down"></i> comments.morecomments_missing</a></div>`,
  '\t</div>\n',
].join('\n');

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

function contextFor(req: AdminRequest, gateway: FakeGatewayClient): ScreenContext {
  return { req, gateway, csrf: {}, rb: {}, hooks: {}, now: new Date(0) } as unknown as ScreenContext;
}

/** An S2 `comment.js` `loadPage` request carrying `rc`. */
const pageRequest = (rc: Readonly<Record<string, string>>): AdminRequest =>
  adminS2Request({ circuit: 'cComments', item: 'loadCommentsPage', rc });

const viewReply = (body: string, status = 200): FakeReply => ({
  status,
  headers: { 'content-type': VIEW_TYPE },
  body,
});

const render = (req: AdminRequest, gateway: FakeGatewayClient): Promise<RawBody> =>
  Promise.resolve(ccommentsLoadCommentsPage.render(contextFor(req, gateway), undefined));

describe('ccommentsLoadCommentsPage', () => {
  it('declares the carried fragment action under the ccomments gate', () => {
    expect(ccommentsLoadCommentsPage).toMatchObject({
      circuit: 'ccomments',
      action: 'loadcommentspage',
      mode: 'fragment',
      owner: CCOMMENTS_OWNER,
      gate: ccommentsGate,
    });
    expect(ccommentsLoadCommentsPage.load).toBeUndefined();
    expect(Object.isFrozen(ccommentsLoadCommentsPage)).toBe(true);
  });

  it.each<{ name: string; rc: Readonly<Record<string, string>> }>([
    { name: 'the modal open', rc: { contentID: CONTENT_ID, commentID: FIRST_ID } },
    { name: 'more comments up', rc: { contentID: CONTENT_ID, upperID: FIRST_ID } },
    { name: 'more comments down', rc: { contentID: CONTENT_ID, lowerID: NEXT_ID } },
    { name: 'an in-reply-to jump', rc: { contentID: CONTENT_ID, upperID: REPLY_ID } },
  ])('forwards $name fields unchanged over GET', async ({ rc }) => {
    const fields = { ...rc, sortDirection: 'asc', _: '1782810000000' };
    const gateway = fakeGatewayClient({ [ROUTE]: viewReply(PAGE) });

    await render(pageRequest({ ...fields, siteid: 'tenant-a' }), gateway);

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({
      service: 'strategies-content',
      method: 'GET',
      path: PATH,
      query: { siteid: 'tenant-a', ...fields },
    });
    expect(gateway.calls[0]?.form).toBeUndefined();
  });

  it.each([
    { name: 'the #commentsPage fragment', status: 200, body: PAGE },
    { name: 'an empty window', status: 200, body: '\t<div id="commentsPage">\n\t\t\n\t\t\n\t\t\n\t</div>\n' },
    { name: 'a legacy error page', status: 500, body: '<h1>Error</h1>' },
  ])('relays $name with its status, content type and bytes unchanged', async ({ status, body }) => {
    const gateway = fakeGatewayClient({ [ROUTE]: viewReply(body, status) });

    const raw = await render(pageRequest({ contentID: CONTENT_ID, commentID: FIRST_ID }), gateway);

    expect(raw).toEqual({ status, contentType: VIEW_TYPE, body: Buffer.from(body) });
  });

  it('raises GatewayDenialError on a refused view', async () => {
    const gateway = fakeGatewayClient({ [ROUTE]: { status: 403, body: {} } });
    await expect(render(pageRequest({ contentID: CONTENT_ID }), gateway)).rejects.toBeInstanceOf(GatewayDenialError);
  });

  it('lets S2 through and secures a user without comments module access before any gateway call', async () => {
    const gateway = fakeGatewayClient({ [ROUTE]: viewReply(PAGE) });
    const denied = editorRequest({ circuit: 'cComments', item: 'loadCommentsPage', rc: { contentID: CONTENT_ID } });

    expect(await runGate(pageRequest({ contentID: CONTENT_ID }), ccommentsLoadCommentsPage.gate)).toEqual({
      kind: 'allow',
    });
    expect(await runGate(denied, ccommentsLoadCommentsPage.gate)).toEqual({ kind: 'redirect', location: './' });
    expect(gateway.calls).toHaveLength(0);
  });
});
