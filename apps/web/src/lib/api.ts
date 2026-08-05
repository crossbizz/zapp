import { createZappClient, type FetchImplementation } from '@zapp/api-client';

const csrfCookieName = 'zapp_csrf';
const csrfHeaderName = 'x-zapp-csrf';

function controlPlaneUrl(): string {
  const value = process.env.NEXT_PUBLIC_CONTROL_API_URL;
  if (value === undefined || value.length === 0) {
    throw new Error('NEXT_PUBLIC_CONTROL_API_URL must be configured.');
  }
  return value;
}

function csrfToken(): string {
  const value = document.cookie
    .split('; ')
    .find((item) => item.startsWith(`${csrfCookieName}=`))
    ?.slice(csrfCookieName.length + 1);
  if (value === undefined || value.length === 0) {
    throw new Error('The CSRF session cookie is missing.');
  }
  return decodeURIComponent(value);
}

const browserFetch: FetchImplementation = async (input, init) => {
  const response = await fetch(input, init);
  // Chromium exposes a CORS 204 as an empty stream. The generated client
  // correctly requires a null body for an OpenAPI no-content response.
  if (response.status !== 204) return response;
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body: null,
    text: () => response.text(),
  };
};

/**
 * The only control-plane boundary used by browser components. Cookie credentials
 * are selected by the generated client from each public OpenAPI operation.
 */
export function createControlPlaneClient(organizationId?: string) {
  const client = createZappClient({
    baseUrl: controlPlaneUrl(),
    getToken: () => '',
    fetch: browserFetch,
  });
  const organizationHeaders =
    organizationId === undefined ? undefined : { 'x-organization-id': organizationId };

  return {
    getMe: () =>
      client.request('/v1/me', {
        method: 'GET',
        ...(organizationHeaders === undefined ? {} : { headers: organizationHeaders }),
      }),
    approveDevice: (userCode: string) =>
      client.request('/v1/auth/device/approve', {
        method: 'POST',
        headers: { [csrfHeaderName]: csrfToken() },
        body: { userCode },
      }),
    denyDevice: (userCode: string) =>
      client.request('/v1/auth/device/deny', {
        method: 'POST',
        headers: { [csrfHeaderName]: csrfToken() },
        body: { userCode },
      }),
  };
}

export type MeResponse = Awaited<ReturnType<ReturnType<typeof createControlPlaneClient>['getMe']>>;
