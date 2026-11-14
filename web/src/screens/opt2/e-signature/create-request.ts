// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { Opt2ActionDefinition, Rc, ScreenContext, SubmitResult } from '../../registry';
import { opt2Gate, submitToService } from '../shared';
import {
  CREATE_REQUEST_ACTION,
  CREATE_REQUEST_FIELDS,
  CREATE_ROLES,
  loadRequests,
  requestsBody,
  type CreateRequestField,
  type CreateRequestValues,
} from './requests';

/** The module slug, which is also the owning service's name. */
const ESIGNATURE = 'e-signature';

/** The posted `CreateRequestInput` properties, untrimmed as the fixture stores them; an unposted one is left out. */
function postedValues(rc: Rc): CreateRequestValues {
  const values: Partial<Record<CreateRequestField, string>> = {};
  for (const name of CREATE_REQUEST_FIELDS) {
    const value = rc[name];
    if (value !== undefined) values[name] = value;
  }
  return values;
}

/**
 * Creates a PENDING request from the posted document and signer, then redirects to the request list, or re-renders
 * the list with the service's error and the posted values.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401, or the re-render's read is denied.
 */
export function submitCreateRequest(ctx: ScreenContext): Promise<SubmitResult> {
  const values = postedValues(ctx.req.rc);
  return submitToService(
    ctx,
    {
      service: ESIGNATURE,
      call: (gateway, csrfHeaders) =>
        gateway.eSignature.call('post', '/v1/esignature/requests', {
          // A property left out is e-signature's to refuse, with the invalidParameters it answers any invalid one with.
          json: values as Record<CreateRequestField, string>,
          headers: csrfHeaders,
        }),
    },
    { module: ESIGNATURE, screen: 'requests', params: { siteid: ctx.req.session.siteid } },
    async (alert) => requestsBody(ctx, await loadRequests(ctx), { alert, values }),
  );
}

/** `/opt2/admin-actions/e-signature/create-request`: the new-request form's post action. */
export const createRequestAction: Opt2ActionDefinition = Object.freeze({
  module: ESIGNATURE,
  action: CREATE_REQUEST_ACTION,
  roles: CREATE_ROLES,
  service: ESIGNATURE,
  gate: opt2Gate(CREATE_ROLES),
  submit: submitCreateRequest,
});
