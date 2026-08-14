import { pathToFileURL } from 'node:url';

import { loadSandboxServiceEnv } from './env.js';
import { composeSandboxRuntime } from './runtime.js';

export async function runSandboxServer(source: unknown = process.env): Promise<void> {
  const env = loadSandboxServiceEnv(source);
  const runtime = await composeSandboxRuntime(env);
  let shutdown: Promise<void> | undefined;
  const close = (): Promise<void> => {
    shutdown ??= runtime.close();
    return shutdown;
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().catch((error: unknown) => {
        runtime.app.log.error({ err: error }, 'sandbox-service shutdown failed');
        process.exitCode = 1;
      });
    });
  }
  try {
    await runtime.app.listen({ host: env.host, port: env.port });
    runtime.startBackgroundWork();
  } catch (error) {
    await close();
    throw error;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    await runSandboxServer();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'sandbox-service failed to start'}\n`,
    );
    process.exitCode = 1;
  }
}
