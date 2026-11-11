import { NextResponse, type NextRequest } from 'next/server';
import { legacyPageHeaders } from '@/lib/responses';

/** Passes an admin page request on, adding the legacy headers for its layout and `Accept-Encoding`. */
export function proxy(request: NextRequest): NextResponse {
  const response = NextResponse.next();
  for (const [name, value] of legacyPageHeaders(request.nextUrl.searchParams, request.headers)) {
    response.headers.set(name, value);
  }
  return response;
}

export const config = { matcher: ['/admin/:circuit/:action', '/opt2/admin/:module/:screen'] };
