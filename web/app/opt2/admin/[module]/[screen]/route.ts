// SYNTHETIC: opt2-modules - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Synthetic-module screen adapter: the screen inside the legacy layout as the complete legacy response. */
import { handleOpt2Page, type Opt2ScreenParams } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<Opt2ScreenParams> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handleOpt2Page(request, await ctx.params);
}
