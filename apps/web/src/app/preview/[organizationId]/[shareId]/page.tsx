'use client';

import { createZappClient, ZappApiError } from '@zapp/api-client';
import { use, useEffect, useState, type ReactElement } from 'react';

interface PreviewBootstrapPageProps {
  readonly params: Promise<{ readonly organizationId: string; readonly shareId: string }>;
}

function controlPlaneUrl(): string {
  const value = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  if (value === undefined || value.length === 0) {
    throw new Error('NEXT_PUBLIC_CONTROL_API_URL must be configured.');
  }
  return value;
}

function csrfHeader(): Record<string, string> {
  const encoded = document.cookie
    .split('; ')
    .find((item) => item.startsWith('zapp_csrf='))
    ?.slice('zapp_csrf='.length);
  return encoded === undefined || encoded.length === 0
    ? {}
    : { 'x-zapp-csrf': decodeURIComponent(encoded) };
}

async function operationKey(purpose: string, value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const suffix = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `preview-${purpose}-${suffix}`;
}

function fragmentBearer(): string | undefined {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token')?.trim();
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  return token === undefined || token.length === 0 ? undefined : token;
}

export default function PreviewBootstrapPage({ params }: PreviewBootstrapPageProps): ReactElement {
  const { organizationId, shareId } = use(params);
  const [failure, setFailure] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let bearer = fragmentBearer();
    if (bearer === undefined) {
      setFailure(true);
      return () => {
        controller.abort();
      };
    }

    const bootstrap = async (): Promise<void> => {
      let grant = '';
      try {
        const exchangeKey = await operationKey('exchange', bearer as string);
        const client = createZappClient({
          baseUrl: controlPlaneUrl(),
          getToken: () => '',
        });
        const exchange = await client.request(
          '/v1/organizations/{organizationId}/preview-shares/{shareId}/sessions',
          {
            method: 'POST',
            path: { organizationId, shareId },
            headers: { ...csrfHeader(), 'idempotency-key': exchangeKey },
            body: { bearer: bearer as string },
            signal: controller.signal,
          },
        );
        bearer = '';
        grant = exchange.grant;
        const redeemKey = await operationKey('redeem', `${organizationId}:${shareId}:${grant}`);
        const redemption = await fetch(new URL('/v1/preview/session', exchange.previewOrigin), {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': redeemKey,
          },
          body: JSON.stringify({ organizationId, shareId, grant }),
          signal: controller.signal,
        });
        grant = '';
        if (!redemption.ok) throw new Error('Preview session redemption failed');
        await redemption.body?.cancel();
        window.location.replace(exchange.previewOrigin);
      } catch (error) {
        bearer = '';
        grant = '';
        if (controller.signal.aborted) return;
        if (error instanceof ZappApiError || error instanceof Error) setFailure(true);
      }
    };
    void bootstrap();
    return () => {
      controller.abort();
      bearer = '';
    };
  }, [organizationId, shareId]);

  return failure ? (
    <main>
      <p role="alert">This preview link is missing or invalid.</p>
    </main>
  ) : (
    <main aria-busy="true">Opening preview…</main>
  );
}
