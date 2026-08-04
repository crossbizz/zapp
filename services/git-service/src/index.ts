/**
 * What this service exports to the rest of the workspace.
 *
 * Deliberately small, and deliberately not the provider: nothing outside this
 * package should construct a Forgejo client, because doing so means holding the
 * admin token. Callers reach this service over HTTP with a service token
 * (`/internal/git/*`), and the *contract* they code against is
 * `@zapp/contracts`' `GitProvider`.
 *
 * What is here is what a test harness or a future in-process composition needs.
 */
export { buildApp, type AppDeps, type AppInstance } from './app.js';
export { composeApp, type ServiceRuntime } from './compose.js';
export {
  loadEnv,
  loadForgejoEnv,
  loadServiceTokenConfig,
  type ForgejoEnv,
  type ServiceEnv,
} from './env.js';
export { GIT_SERVICE_AUDIENCE, SERVICE_TOKEN_HEADER } from './internal/service-auth.js';
export { GIT_CALLERS } from './routes.js';
