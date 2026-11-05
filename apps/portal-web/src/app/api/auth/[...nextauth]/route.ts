// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import NextAuth from 'next-auth';
import { authOptions, sessionWithoutAccessToken } from '@/lib/auth';

const handler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth: string[] }> };

/**
 * NextAuth's session endpoint is what the browser reads. The access
 * token stays in the encrypted JWT cookie for getServerSession. It
 * is removed from this JSON response so page script cannot read it.
 */
async function handle(req: NextRequest, context: RouteContext): Promise<Response> {
  const res = await handler(req, context);
  if (!req.nextUrl.pathname.endsWith('/session')) return res;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('json')) return res;
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    return new NextResponse(text, { status: res.status, headers: res.headers });
  }
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return NextResponse.json(sessionWithoutAccessToken(body), {
    status: res.status,
    headers,
  });
}

export { handle as GET, handle as POST };
