// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { ScreenContext, SubmitResult } from '../../registry';
import { isMalformedId, opt2View, submitToService } from '../shared';
import { ESIGNATURE, REQUEST_SCREEN, requestIdOf, siteParams } from './common';
import { loadRequest, requestBody } from './request';

/**
 * Signs request `rc.id` with the posted `rc.typedName`, sent as typed, then redirects to the request, or re-renders
 * it with the service's error and the posted name; a malformed id re-renders it with nothing signed.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401, or the re-render's read is denied.
 */
export async function submitSign(ctx: ScreenContext): Promise<SubmitResult> {
  const { rc } = ctx.req;
  const id = requestIdOf(rc);
  const typedName = rc.typedName ?? '';
  // The request read refuses the malformed id itself, with the invalid-parameters alert.
  if (isMalformedId(id)) {
    return { kind: 'render', view: opt2View(ESIGNATURE, requestBody(ctx, await loadRequest(ctx), { typedName }), REQUEST_SCREEN) };
  }
  return submitToService(
    ctx,
    {
      service: ESIGNATURE,
      call: (gateway, csrfHeaders) =>
        gateway.eSignature.call('post', '/v1/esignature/requests/{id}/sign', {
          params: { id },
          json: { typedName },
          headers: csrfHeaders,
        }),
    },
    { module: ESIGNATURE, screen: REQUEST_SCREEN, params: siteParams(ctx, { id }) },
    async (alert) => requestBody(ctx, await loadRequest(ctx), { alert, typedName }),
  );
}
