import { loadEnv, type ServiceEnv } from './env.js';
import { composeApp, type ReleaseServiceRuntime } from './compose.js';

/**
 * Starts the release-service process after its provider/state-machine adapters
 * have been composed. Keeping adapters explicit prevents a production boot from
 * silently replacing Fly, Temporal, verification, Git, or repair with a fake.
 */
export async function startReleaseServer(
  runtime: ReleaseServiceRuntime,
  env: ServiceEnv = loadEnv(),
) {
  const app = composeApp(runtime);
  await app.listen({ host: env.HOST, port: env.PORT });
  return app;
}
