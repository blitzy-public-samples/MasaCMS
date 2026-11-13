// `cwebservice.save`: relays the Web Service form to identity, then redirects or re-renders the form (server-only).
import { CSRF_FIELD_EXPIRES, CSRF_FIELD_TOKEN } from '@opt2/platform/legacy-compat';
import { okBody } from '@/lib/gateway-client';
import type { PageRedirect, Rc, ScreenContext, SubmitResult } from '../registry';
import { loadEditState, renderEditView, type WebServiceEditState, type WebServiceErrors } from './edit';
import { effectiveGrantType } from './list';

const OPERATION = 'saveOAuthClient';

/** `fw.redirect(action='cwebservice.list', append='siteid', path='./')`. */
const LIST_REDIRECT: PageRedirect = Object.freeze({
  kind: 'redirect',
  action: 'cwebservice.list',
  append: 'siteid',
  path: './',
});

/** The form fields `set(rc)` applies, under identity's input names, plus the CSRF pair identity validates. */
const SAVE_FIELDS = [
  'siteid',
  'name',
  'description',
  'granttype',
  'userid',
  'redirectURL',
  'clientsecret',
  CSRF_FIELD_TOKEN,
  CSRF_FIELD_EXPIRES,
] as const;

/** `rc[name]` read as a CFML scope reads it, ignoring case. */
function rcField(rc: Rc, name: string): string | undefined {
  const direct = rc[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  const key = Object.keys(rc).find((candidate) => candidate.toLowerCase() === lower);
  return key === undefined ? undefined : rc[key];
}

/** The bean after `loadBy(clientid=rc.clientid).set(rc).validate()`, as the edit view renders it. */
function beanState(rc: Rc, siteid: string, exists: boolean, errors: WebServiceErrors): WebServiceEditState {
  const field = (name: string): string => rcField(rc, name) ?? '';
  return {
    clientid: field('clientid'),
    clientsecret: field('clientsecret'),
    siteid,
    name: field('name'),
    description: field('description'),
    granttype: effectiveGrantType(rcField(rc, 'granttype')),
    userid: field('userid'),
    redirecturl: field('redirecturl'),
    exists,
    errors,
  };
}

/**
 * Identity validates the client, then saves it only under a valid CSRF token for `rc.clientid`; no errors redirect to
 * the list, errors re-render the edit form.
 * @throws GatewayUnavailableError When identity is unavailable; the handler answers the legacy 503.
 * @throws GatewayDenialError When identity answers 401 or 403; any other non-2xx answer throws `Error`.
 */
export async function submitSave(ctx: ScreenContext): Promise<SubmitResult> {
  const { rc, session } = ctx.req;
  const siteid = rcField(rc, 'siteid');
  if (siteid === undefined) return { ...LIST_REDIRECT, rc: { siteid: session.siteid } };
  // Only the fields rc carries, so identity leaves the stored value of any other in place as `set(rc)` does.
  const form = SAVE_FIELDS.flatMap((name): Array<[string, string]> => {
    const value = rcField(rc, name);
    return value === undefined ? [] : [[name, value]];
  });
  const response = await ctx.gateway.identity.call('put', '/v1/oauth-clients/{clientId}', {
    params: { clientId: rcField(rc, 'clientid') ?? '' },
    form,
  });
  const { errors } = okBody(response, 'identity', OPERATION);
  if (Object.keys(errors).length === 0) return LIST_REDIRECT;
  // A save with errors writes nothing, so a read now tells whether `loadBy` found a stored client.
  const { exists } = await loadEditState(ctx);
  return { kind: 'render', view: await renderEditView(ctx, beanState(rc, siteid, exists, errors)) };
}
