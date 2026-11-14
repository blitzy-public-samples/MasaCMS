/** Liveness route: the same unauthenticated `{ status: 'ok' }` answer as the service-kit `/healthz`. */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
