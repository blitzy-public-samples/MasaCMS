// SYNTHETIC: e-signature - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { ScreenContext, SubmitResult } from '../../registry';
import { csrfHeadersFrom, opt2View, submitToService } from '../shared';
import { ESIGNATURE, VERIFY_SCREEN, requestIdOf, siteParams } from './common';
import { loadVerify, verifyBody, type VerifyBodyOptions } from './verify';

/**
 * Has e-signature verify the posted chain copy `rc.entries` of request `rc.id`, then renders the verify screen with
 * its verdict, or with the service's error; the posted copy is kept either way.
 * @throws GatewayUnavailableError When e-signature is unavailable.
 * @throws GatewayDenialError When e-signature answers 401, or the screen's reads are denied.
 */
export async function submitVerifyCopy(ctx: ScreenContext): Promise<SubmitResult> {
  const { rc } = ctx.req;
  const id = requestIdOf(rc);
  const entries = rc.entries ?? '';
  const body = async (opts: VerifyBodyOptions) => verifyBody(ctx, await loadVerify(ctx), { ...opts, entries });
  const response = await ctx.gateway.eSignature.call('post', '/v1/esignature/requests/{id}/verify', {
    params: { id },
    json: { entries },
    headers: csrfHeadersFrom(rc),
  });
  if (response.ok) return { kind: 'render', view: opt2View(ESIGNATURE, await body({ copy: response.body })) };
  // The verdict is the screen, so only a refusal takes the shared submit answer: an alert, a denial or a failure.
  return submitToService(
    ctx,
    { service: ESIGNATURE, call: () => Promise.resolve(response) },
    { module: ESIGNATURE, screen: VERIFY_SCREEN, params: siteParams(ctx, { id }) },
    (alert) => body({ alert }),
  );
}
