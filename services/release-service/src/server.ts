import { loadEnv, type ServiceEnv } from './env.js';
import { composeProductionApp, type ProductionReleaseServiceRuntime } from './compose.js';

/**
 * Starts the release-service process from raw provider/state-machine bindings.
 * Requiring production bindings here prevents the listening entrypoint from
 * accepting a prebuilt lifecycle that bypasses DEP-2 through DEP-11.
 */
export async function startReleaseServer(
  runtime: ProductionReleaseServiceRuntime,
  env: ServiceEnv = loadEnv(),
) {
  const app = composeProductionApp(runtime);
  await app.listen({ host: env.HOST, port: env.PORT });
  return app;
}
