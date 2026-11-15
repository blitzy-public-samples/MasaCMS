// The four ccomments AJAX relays comment.js calls: strategies-content's status, content type and bytes, unchanged.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayUnavailableError, type ServicePath } from '@/lib/gateway-client';
import { ccommentsBulkEdit, ccommentsSingleEdit } from '@/screens/ccomments/ajax';
import { ccommentsLoadComments } from '@/screens/ccomments/loadcomments';
import { ccommentsLoadCommentsPage } from '@/screens/ccomments/loadcommentspage';
import { ccommentsGate } from '@/screens/ccomments/shared';
import type { FragmentScreen, RawBody, RedirectScreen, ScreenContext, SubmitResult } from '@/screens/registry';
import {
  CCOMMENTS_PATHS,
  COMMENT_HTML_ESCAPED,
  COMMENT_HTML_TEXT,
  COMMENT_IDS,
  ajaxEmptyRelay,
  commentsBulkEditWritten,
  commentsSingleEditWritten,
  loadCommentsRelay,
} from '../../fixtures/strategies-content/comments';
import { adminS2Request } from '../../helpers/admin-request';
import { useTestEnv } from '../../helpers/env';
import { fakeGatewayClient, routeKey, type FakeGatewayClient, type FakeRouteTable } from '../../helpers/fake-gateway';
import { makeScreenContext } from '../../helpers/screen-context';

/** The fixture comments' site, which comment.js sends as `siteid`. */
const SITE = 'tenant-a';
const CONTENT_ID = 'C0000000-0000-0000-0000000000000001';
// The raw_ccomments_loadcommentspage 200 media type in the strategies-content contract.
const PAGE_TYPE = 'text/html;charset=UTF-8';

const view = (path: ServicePath): string => routeKey('GET', 'strategies-content', path);
const write = (path: ServicePath): string => routeKey('POST', 'strategies-content', path);
const editPath = (commentid: string): ServicePath => `/v1/sites/${SITE}/comments/${commentid}`;

/** `loadSearch` with the advanced search serialized: status, sort, page size and page set. */
const LOAD_RC = {
  keywords: 'x',
  commentStatus: 'approved',
  startDate: '',
  endDate: '',
  categoryID: '',
  sortBy: 'name',
  sortDirection: 'desc',
  nextN: '10',
  pageNo: '2',
  cacheid: '0.42',
} as const;

/** `loadPage` with every window field the controller reads. */
const PAGE_RC = {
  contentID: CONTENT_ID,
  commentID: COMMENT_IDS.approved,
  upperID: COMMENT_IDS.pending,
  lowerID: COMMENT_IDS.spam,
  sortDirection: 'asc',
  _: '1782810000000',
} as const;

/** The view's markup for two comments, one with escaped HTML, and a more-down anchor. */
const PAGE_BODY = [
  '\t<div id="commentsPage">',
  `\t\t\t<dl id="detail-${COMMENT_IDS.approved}">`,
  '\t\t\t\t<dt>\n\t\t\t\t\tJordan Ellis\n\t\t\t\t</dt>',
  '\t\t\t\t<dd class="comment">\n\t\t\t\t\t<p>Thanks for the clear program update.</p>\n\t\t\t\t</dd>\n\t\t\t</dl>',
  `\t\t\t<dl id="detail-${COMMENT_IDS.withHtml}">`,
  '\t\t\t\t<dt>\n\t\t\t\t\tRiley Morgan\n\t\t\t\t</dt>',
  `\t\t\t\t<dd class="comment">\n\t\t\t\t\t<p>${COMMENT_HTML_ESCAPED}</p>\n\t\t\t\t</dd>\n\t\t\t</dl>`,
  `\t\t\t<div id="moreCommentsDownContainer"><a id="moreCommentsDown" class="btn btn-small" href="#" data-lowerid="${COMMENT_IDS.spam}"><i class="mi-arrow-down"></i> More Comments</a></div>`,
  '\t</div>\n',
].join('\n');

const loadCommentsPageRelay = { status: 200, headers: { 'content-type': PAGE_TYPE }, body: PAGE_BODY } as const;

/** The empty `ajax.cfm` body every edit answers with. */
const AJAX_RAW: RawBody = {
  status: ajaxEmptyRelay.status,
  contentType: ajaxEmptyRelay.headers['content-type'],
  body: Buffer.alloc(0),
};

type Relay = FragmentScreen | RedirectScreen;

/** Each relay with its inventoried action and mode, and the legacy-cased item and rc comment.js sends. */
const RELAYS: ReadonlyArray<{
  readonly def: Relay;
  readonly action: string;
  readonly mode: Relay['mode'];
  readonly item: string;
  readonly rc: Readonly<Record<string, string>>;
}> = [
  { def: ccommentsLoadComments, action: 'loadcomments', mode: 'fragment', item: 'loadComments', rc: LOAD_RC },
  {
    def: ccommentsLoadCommentsPage,
    action: 'loadcommentspage',
    mode: 'fragment',
    item: 'loadcommentspage',
    rc: PAGE_RC,
  },
  {
    def: ccommentsBulkEdit,
    action: 'bulkedit',
    mode: 'redirect',
    item: 'bulkEdit',
    rc: { bulkedit: 'approve', ckUpdate: COMMENT_IDS.pending },
  },
  {
    def: ccommentsSingleEdit,
    action: 'singleedit',
    mode: 'redirect',
    item: 'singleEdit',
    rc: { commentid: COMMENT_IDS.pending, updateaction: 'approve' },
  },
];

let restore: () => void;

beforeEach(() => {
  restore = useTestEnv();
});

afterEach(() => {
  restore();
});

/** The S2 admin's `cComments.<item>` request carrying `rc` on {@link SITE}, over a gateway answering `routes`. */
function contextFor(
  item: string,
  rc: Readonly<Record<string, string>>,
  routes: FakeRouteTable,
): ScreenContext & { gateway: FakeGatewayClient } {
  return makeScreenContext({
    req: adminS2Request({ circuit: 'cComments', item, rc: { siteid: SITE, ...rc } }),
    gateway: fakeGatewayClient(routes),
  });
}

/** `def` answered as the admin handlers call it: a fragment's render without load data, a post action's submit. */
async function answer(def: Relay, ctx: ScreenContext): Promise<RawBody | SubmitResult> {
  return def.mode === 'fragment' ? def.render(ctx, undefined) : def.submit(ctx);
}

/** The relayed body decoded as UTF-8. */
function bodyText({ body }: RawBody): string {
  if (!(body instanceof Uint8Array)) throw new TypeError('The relay answered without bytes');
  return Buffer.from(body).toString('utf8');
}

/** `method path` of each gateway call, in order. */
const callLine = (gateway: FakeGatewayClient): string[] => gateway.calls.map((call) => `${call.method} ${call.path}`);

describe('definitions', () => {
  it.each(RELAYS)('declares $action in $mode mode', ({ def, action, mode }) => {
    expect(def).toMatchObject({ circuit: 'ccomments', owner: 'strategies-content', action, mode });
    expect(def.gate).toBe(ccommentsGate);
  });
});

describe('ccommentsLoadComments', () => {
  const relay = async (): Promise<{ raw: RawBody; gateway: FakeGatewayClient }> => {
    const ctx = contextFor('loadComments', LOAD_RC, { [view(CCOMMENTS_PATHS.loadComments)]: loadCommentsRelay });
    return { raw: await ccommentsLoadComments.render(ctx, undefined), gateway: ctx.gateway };
  };

  it('relays loadcomments bytes', async () => {
    const { raw } = await relay();
    expect(raw).toEqual({
      status: loadCommentsRelay.status,
      contentType: loadCommentsRelay.headers['content-type'],
      body: Buffer.from(loadCommentsRelay.body),
    });
  });

  it('keeps the service encoding', async () => {
    const text = bodyText((await relay()).raw);
    expect(text).not.toContain(COMMENT_HTML_TEXT);
    expect(text).toContain(COMMENT_HTML_ESCAPED);
    expect(text).not.toMatch(/&amp;[lg]t;/);
  });

  it('lists every comment', async () => {
    const text = bodyText((await relay()).raw);
    expect(Object.values(COMMENT_IDS).filter((id) => !text.includes(id))).toEqual([]);
  });

  it('forwards the search fields unchanged', async () => {
    const { gateway } = await relay();
    expect(callLine(gateway)).toEqual([`GET ${CCOMMENTS_PATHS.loadComments}`]);
    expect(gateway.calls[0]).toMatchObject({ service: 'strategies-content', query: { siteid: SITE, ...LOAD_RC } });
  });
});

describe('ccommentsLoadCommentsPage', () => {
  it('relays loadcommentspage bytes and forwards the window fields', async () => {
    const ctx = contextFor('loadcommentspage', PAGE_RC, {
      [view(CCOMMENTS_PATHS.loadCommentsPage)]: loadCommentsPageRelay,
    });

    expect(await ccommentsLoadCommentsPage.render(ctx, undefined)).toEqual({
      status: loadCommentsPageRelay.status,
      contentType: loadCommentsPageRelay.headers['content-type'],
      body: Buffer.from(loadCommentsPageRelay.body),
    });
    expect(callLine(ctx.gateway)).toEqual([`GET ${CCOMMENTS_PATHS.loadCommentsPage}`]);
    expect(ctx.gateway.calls[0]).toMatchObject({ service: 'strategies-content', query: { siteid: SITE, ...PAGE_RC } });
  });
});

describe('ccommentsBulkEdit', () => {
  it.each([
    [COMMENT_IDS.pending, COMMENT_IDS.withHtml],
    [COMMENT_IDS.withHtml, COMMENT_IDS.pending],
  ])('approves ckUpdate %s,%s in order, then relays the empty ajax body', async (first, second) => {
    // The URL scope joins the repeated ckUpdate checkboxes with commas, in order, before rc holds them.
    const rc = { bulkedit: 'approve', ckUpdate: `${first},${second}`, cacheid: '0.42' };
    const ctx = contextFor('bulkEdit', rc, {
      [write(CCOMMENTS_PATHS.bulkEdit)]: { status: 200, body: commentsBulkEditWritten },
      [view(CCOMMENTS_PATHS.ajax)]: ajaxEmptyRelay,
    });

    expect(await ccommentsBulkEdit.submit(ctx)).toEqual({ kind: 'raw', response: AJAX_RAW });
    expect(callLine(ctx.gateway)).toEqual([`POST ${CCOMMENTS_PATHS.bulkEdit}`, `GET ${CCOMMENTS_PATHS.ajax}`]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject(rc);
    expect(ctx.gateway.calls[1]?.query).toEqual({ siteid: SITE });
  });
});

describe('ccommentsSingleEdit', () => {
  it.each([
    [COMMENT_IDS.pending, 'approve'],
    [COMMENT_IDS.spam, 'unspam'],
  ])('runs %s %s, then relays the empty ajax body', async (commentid, updateaction) => {
    const rc = { commentid, updateaction, cacheid: '0.42' };
    const ctx = contextFor('singleEdit', rc, {
      [write(editPath(commentid))]: { status: 200, body: commentsSingleEditWritten },
      [view(CCOMMENTS_PATHS.ajax)]: ajaxEmptyRelay,
    });

    expect(await ccommentsSingleEdit.submit(ctx)).toEqual({ kind: 'raw', response: AJAX_RAW });
    expect(callLine(ctx.gateway)).toEqual([`POST ${editPath(commentid)}`, `GET ${CCOMMENTS_PATHS.ajax}`]);
    expect(ctx.gateway.calls[0]?.form).toMatchObject(rc);
    expect(ctx.gateway.calls[1]?.query).toEqual({ siteid: SITE });
  });
});

describe('fail closed', () => {
  it.each(RELAYS)('rejects $action once when strategies-content is unreachable', async ({ def, item, rc }) => {
    const ctx = contextFor(item, rc, {});
    ctx.gateway.failWith();

    const error = await answer(def, ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GatewayUnavailableError);
    expect(error).toMatchObject({ service: 'strategies-content' });
    expect(ctx.gateway.calls).toHaveLength(1);
  });
});
