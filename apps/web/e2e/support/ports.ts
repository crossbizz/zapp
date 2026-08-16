export const appPort = Number(process.env['ZAPP_WEB_E2E_APP_PORT'] ?? 3310);
export const apiPort = Number(process.env['ZAPP_WEB_E2E_API_PORT'] ?? 4310);

export const appBaseUrl = `http://127.0.0.1:${String(appPort)}`;
export const apiBaseUrl = `http://127.0.0.1:${String(apiPort)}`;
