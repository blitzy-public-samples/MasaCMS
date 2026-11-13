/** Raw-mode (fragment, json and download) admin adapter: the bare legacy body of a carried action. */
import { handleAdminRaw, type AdminRouteParams } from '@/lib/handlers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<AdminRouteParams> };

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handleAdminRaw(request, await ctx.params);
}

export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handleAdminRaw(request, await ctx.params);
}
