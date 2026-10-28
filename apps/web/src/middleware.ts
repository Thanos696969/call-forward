import { NextResponse, type NextRequest } from 'next/server';

/** Cheap gate: no session cookie → straight to sign-in. The API still validates every request. */
export function middleware(req: NextRequest) {
  if (!req.cookies.get('relay_session')) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/app', '/app/:path*'] };
