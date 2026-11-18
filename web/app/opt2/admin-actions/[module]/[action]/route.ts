// SYNTHETIC: opt2-modules - no Masa equivalent; legacy oracle in legacy-fixtures/
/**
 * Synthetic-module post-action adapter: delegates POST to handleOpt2Action. Every other method, OPTIONS included,
 * answers 405 with `Allow: POST` and the legacy error page, running no action.
 */
import { LEGACY_ERROR_PAGE_HTML } from '@opt2/platform/legacy-compat';
import { handleOpt2Action, type Opt2ActionParams } from '@/lib/handlers';
import { htmlResponse } from '@/lib/responses';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Opt2ActionContext {
  params: Promise<Opt2ActionParams>;
}

export async function POST(request: Request, ctx: Opt2ActionContext): Promise<Response> {
  return handleOpt2Action(request, await ctx.params);
}

/** 405 naming POST as the only method, with the legacy headers and error page. */
function methodNotAllowed(request: Request): Response {
  return htmlResponse(LEGACY_ERROR_PAGE_HTML, {
    status: 405,
    headers: { allow: 'POST' },
    context: { acceptEncoding: request.headers.get('accept-encoding') },
  });
}

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;
export const OPTIONS = methodNotAllowed;

/** The GET answer's status and headers without its body. */
export function HEAD(request: Request): Response {
  const { status, headers } = methodNotAllowed(request);
  return new Response(null, { status, headers });
}
