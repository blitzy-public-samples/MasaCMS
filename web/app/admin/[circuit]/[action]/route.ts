/** Page-mode admin adapter: a carried legacy view as the complete legacy response. */
import { handleAdminPage, type AdminRouteParams } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<AdminRouteParams> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handleAdminPage(request, await ctx.params);
}
