'use client';

import type { MouseEvent, ReactElement } from 'react';

export default function LoginPage(): ReactElement {
  const apiBaseUrl = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  const href = apiBaseUrl === undefined || apiBaseUrl.length === 0 ? '#' : `${apiBaseUrl}/v1/auth/login`;

  const startLogin = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (apiBaseUrl === undefined || apiBaseUrl.length === 0) return;
    const url = new URL('/v1/auth/login', apiBaseUrl);
    const userCode = new URLSearchParams(window.location.search).get('userCode');
    if (userCode !== null) url.searchParams.set('userCode', userCode);
    window.location.assign(url);
  };

  return (
    <main>
      <h1>Sign in to zapp.build</h1>
      <a href={href} onClick={startLogin}>
        Sign in
      </a>
    </main>
  );
}
