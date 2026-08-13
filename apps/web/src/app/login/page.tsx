'use client';

import type { MouseEvent, ReactElement } from 'react';

import styles from '../../components/auth/auth.module.css';

export default function LoginPage(): ReactElement {
  const apiBaseUrl = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  const backendAvailable = apiBaseUrl !== undefined && apiBaseUrl.length > 0;
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
    <main className={styles.page}>
      <section aria-labelledby="login-title" className={styles.card}>
        <div className={styles.brand}>
          <span aria-hidden="true" className={styles.brandMark}>z</span>
          <span>zapp.build</span>
        </div>
        <h1 id="login-title">Sign in to zapp.build</h1>
        <p>Turn an idea into working software.</p>
        <a
          aria-disabled={!backendAvailable}
          className={`${styles.signIn ?? ''} ${backendAvailable ? '' : styles.signInDisabled ?? ''}`}
          href={href}
          onClick={startLogin}
        >
          Sign in
        </a>
        <small>
          {backendAvailable
            ? 'Your organization and projects will be ready when you arrive.'
            : 'Sign-in service is not configured.'}
        </small>
      </section>
    </main>
  );
}
