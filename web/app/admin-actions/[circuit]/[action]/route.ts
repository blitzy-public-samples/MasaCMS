/** FW/1 post-action adapter: delegates GET and POST to handleAdminAction. */
import { handleAdminAction, type AdminRouteParams } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface AdminActionContext {
  params: Promise<AdminRouteParams>;
}

export async function GET(request: Request, ctx: AdminActionContext): Promise<Response> {
  return handleAdminAction(request, await ctx.params);
}

export async function POST(request: Request, ctx: AdminActionContext): Promise<Response> {
  return handleAdminAction(request, await ctx.params);
}
