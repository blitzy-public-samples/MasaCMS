// The ccomments moderation actions: a strategies-content write, then FW/1's redirect to the manager (server-only).
import { esapiUrlEncode } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { RedirectScreen, ScreenContext, SubmitResult } from '../registry';
import { CCOMMENTS_OWNER, ccommentsGate, commentsSiteId } from './shared';

/** The `rc` keys every moderation action preserves for `cComments.default`. */
export const CCOMMENTS_PRESERVE = ['processed', 'isapproved', 'siteid'] as const;

/** Contract paths of the writes that address one comment, by operation id. */
const COMMENT_PATHS = {
  approveComment: '/v1/sites/{siteid}/comments/{commentid}/approve',
  unapproveComment: '/v1/sites/{siteid}/comments/{commentid}/unapprove',
  deleteComment: '/v1/sites/{siteid}/comments/{commentid}/delete',
  markCommentSpam: '/v1/sites/{siteid}/comments/{commentid}/spam',
} as const;

const PURGE_OPERATION = 'purgeDeletedComments';
const PURGE_PATH = '/v1/sites/{siteid}/comments/purge-deleted';

/** A strategies-content write a moderation action runs. */
type CommentOperation = keyof typeof COMMENT_PATHS | typeof PURGE_OPERATION;

/** The controller's redirect to the comments manager. */
const MANAGER_REDIRECT = Object.freeze({
  kind: 'redirect',
  action: 'cComments.default',
  preserve: CCOMMENTS_PRESERVE.join(','),
  path: './',
} as const satisfies SubmitResult);

/** The FW/1 redirect a strategies-content write names. */
interface ServiceRedirect {
  readonly circuit: string;
  readonly action: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
}

/** The manager redirect with `processed`, aimed where the service's redirect names, the declared path kept. */
function managerRedirect(processed: boolean, redirect: ServiceRedirect | null = null): SubmitResult {
  const queryString = redirect?.params.map(([name, value]) => `${name}=${esapiUrlEncode(value)}`).join('&') ?? '';
  return {
    ...MANAGER_REDIRECT,
    ...(redirect === null ? {} : { action: `${redirect.circuit}.${redirect.action}` }),
    ...(queryString === '' ? {} : { queryString }),
    rc: { processed: String(processed) },
  };
}

/** Runs `operation` for the site with every rc field as received, then redirects with the service's outcome. */
async function submitWrite({ req, gateway }: ScreenContext, operation: CommentOperation): Promise<SubmitResult> {
  const siteid = commentsSiteId(req);
  const commentid = req.rc['commentid'];
  const service = gateway.strategiesContent;
  // Nothing here consumes a CSRF token: the controller validates none, so any token travels as an ordinary field.
  const form = Object.entries(req.rc);
  let response;
  if (operation === PURGE_OPERATION) {
    response = await service.call('post', PURGE_PATH, { params: { siteid }, form });
  } else if (commentid === undefined) {
    // The controller leaves `processed` false and writes nothing when the request names no comment, and no contract
    // operation addresses an unnamed one, so this branch stays in web.
    return managerRedirect(false);
  } else {
    response = await service.call('post', COMMENT_PATHS[operation], { params: { siteid, commentid }, form });
  }
  if (response.location !== undefined) return { kind: 'location', location: response.location };
  // `saved` is the manager's result, which the controller assigns to `rc.processed`.
  const { saved, redirect } = okBody(response, CCOMMENTS_OWNER, operation);
  return managerRedirect(saved, redirect);
}

/** A redirect-mode ccomments action backed by `operation`. */
function commentWrite(action: string, operation: CommentOperation): RedirectScreen {
  return Object.freeze({
    circuit: 'ccomments',
    action,
    mode: 'redirect',
    owner: CCOMMENTS_OWNER,
    gate: ccommentsGate,
    submit: (ctx: ScreenContext) => submitWrite(ctx, operation),
  });
}

/** `cComments.approve`. */
export const ccommentsApprove: RedirectScreen = commentWrite('approve', 'approveComment');

/** `cComments.unapprove`. */
export const ccommentsUnapprove: RedirectScreen = commentWrite('unapprove', 'unapproveComment');

/** `cComments.delete`. */
export const ccommentsDelete: RedirectScreen = commentWrite('delete', 'deleteComment');

/** `cComments.markAsSpam`. */
export const ccommentsMarkAsSpam: RedirectScreen = commentWrite('markasspam', 'markCommentSpam');

/** `cComments.purgeDeletedComments`: purges the site's deleted comments. */
export const ccommentsPurgeDeletedComments: RedirectScreen = commentWrite('purgedeletedcomments', PURGE_OPERATION);
