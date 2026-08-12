import { pathToFileURL } from 'node:url';

import { loadRunWorkerEnv, type RunWorkerEnv } from './env.js';
import { composeRunWorker, type RunWorkerRuntime } from './runtime/run-worker.js';

interface ShutdownSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export async function runRunWorkerServer(options: {
  readonly env?: RunWorkerEnv;
  readonly compose?: (env: RunWorkerEnv) => Promise<RunWorkerRuntime>;
  readonly writeReady?: () => void;
  readonly signals?: ShutdownSignalSource;
} = {}): Promise<void> {
  const env = options.env ?? loadRunWorkerEnv();
  const runtime = await (options.compose ?? composeRunWorker)(env);
  const signals = options.signals ?? process;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.shutdown();
  };
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    await runtime.run(
      options.writeReady ??
        (() => {
          process.stdout.write('{"service":"orchestrator-worker","queue":"agent-runs","status":"ready"}\n');
        }),
    );
  } finally {
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
  }
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  await runRunWorkerServer();
}
