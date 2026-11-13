// SYNTHETIC: opt2-modules - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Synthetic-module post-action adapter: delegates GET and POST to handleOpt2Action. */
import { handleOpt2Action, type Opt2ActionParams } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Opt2ActionContext {
  params: Promise<Opt2ActionParams>;
}

export async function GET(request: Request, ctx: Opt2ActionContext): Promise<Response> {
  return handleOpt2Action(request, await ctx.params);
}

export async function POST(request: Request, ctx: Opt2ActionContext): Promise<Response> {
  return handleOpt2Action(request, await ctx.params);
}
