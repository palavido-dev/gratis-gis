// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import NextAuth from 'next-auth';
import { authOptions, sessionWithoutAccessToken } from '@/lib/auth';
import { decideSignInOrigin } from '@/lib/auth-origin';

const handler = NextAuth(authOptions);

type RouteContext = { params: Promise<{ nextauth: string[] }> };

/**
 * NextAuth's session endpoint is what the browser reads. The access
 * token stays in the encrypted JWT cookie for getServerSession. It
 * is removed from this JSON response so page script cannot read it.
 */
function blockOtherSignInHost(req: NextRequest): NextResponse | null {
  const path = req.nextUrl.pathname;
  if (!path.includes('/signin') && !path.includes('/callback')) return null;
  const decision = decideSignInOrigin(
    req.headers.get('x-forwarded-host') ?? req.headers.get('host'),
  );
  if (decision.allowed) return null;
  const url = req.nextUrl.clone();
  url.pathname = '/signin';
  url.search = '';
  return NextResponse.redirect(url);
}

async function handle(req: NextRequest, context: RouteContext): Promise<Response> {
  const blocked = blockOtherSignInHost(req);
  if (blocked) return blocked;
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
