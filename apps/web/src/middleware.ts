import { createZappClient, ZappApiError } from '@zapp/api-client';
import { NextResponse, type NextRequest } from 'next/server';

const publicPaths = new Set(['/login', '/auth/callback']);
const sessionCookieName = 'zapp_session';

function loginUrl(request: NextRequest): URL {
  const login = new URL('/login', request.url);
  if (request.nextUrl.pathname === '/device') {
    const userCode = request.nextUrl.searchParams.get('userCode');
    if (userCode !== null) login.searchParams.set('userCode', userCode);
  }
  return login;
}

function unavailable(): NextResponse {
  return new NextResponse('Authentication service is temporarily unavailable.', {
    status: 503,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function sessionClient(apiBaseUrl: string) {
  return createZappClient({
    baseUrl: apiBaseUrl,
    getToken: () => '',
  });
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (publicPaths.has(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const session = request.cookies.get(sessionCookieName);
  const apiBaseUrl = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  if (session === undefined) {
    return NextResponse.redirect(loginUrl(request));
  }
  if (apiBaseUrl === undefined || apiBaseUrl.length === 0) return unavailable();

  try {
    await sessionClient(apiBaseUrl).request('/v1/me', {
      method: 'GET',
      headers: { cookie: `${sessionCookieName}=${session.value}` },
    });
  } catch (error) {
    if (error instanceof ZappApiError && error.status === 401) {
      return NextResponse.redirect(loginUrl(request));
    }
    return unavailable();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
