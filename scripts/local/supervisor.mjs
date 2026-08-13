import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { loadLocalConfig, loadLocalForgejoEnv, LocalPreflightError } from './config.mjs';
import { createProcessSupervisor } from './process.mjs';

const execFile = promisify(execFileCallback);
const PNPM_COMMAND = 'npx';
const PNPM_PREFIX = ['-y', 'pnpm@9.15.0'];

async function defaultExec(command, args, options) {
  try {
    return await execFile(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    throw new LocalPreflightError(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function defaultCheckPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close((error) => (error === undefined ? resolve(true) : reject(error)));
    });
  });
}

export async function defaultWaitForHttp(
  url,
  { timeoutMs = 90_000, wait, signal, fetchImpl = fetch } = {},
) {
  const pause = wait ?? ((milliseconds, options) => delay(milliseconds, undefined, options));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const requestSignal =
        signal === undefined
          ? AbortSignal.timeout(2_000)
          : AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
      const response = await fetchImpl(url, { redirect: 'manual', signal: requestSignal });
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 200 && response.status < 400) return;
    } catch {
      signal?.throwIfAborted();
      // A dependency that is still starting is expected; retry until the deadline.
    }
    await pause(250, { signal });
  }
  throw new Error(`Readiness timed out: ${url}`);
}

async function defaultVerifyImages(config) {
  const { createModalImagePublisher } = await import(
    '../../services/sandbox-service/dist/provider/modal.js'
  );
  const provider = createModalImagePublisher({
    credentials: {
      tokenId: config.env.MODAL_TOKEN_ID,
      tokenSecret: config.env.MODAL_TOKEN_SECRET,
    },
  });
  for (const image of config.imageLock.images) {
    await provider.verifyPublishedImage({
      environment: config.imageLock.modalEnvironment,
      digest: image.digest,
      publishedName: image.publishedName,
    });
  }
}

async function defaultOpenBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

function service(name, command, args, config, overrides = {}) {
  return {
    name,
    command,
    args,
    cwd: config.cwd,
    required: true,
    env: { ...config.env, ...overrides },
  };
}

function pnpmService(name, args, config, overrides = {}) {
  return service(name, PNPM_COMMAND, [...PNPM_PREFIX, ...args], config, overrides);
}

function signalPromise(signals) {
  let cleanup = () => undefined;
  const promise = new Promise((resolve) => {
    const stop = () => {
      cleanup();
      resolve('signal');
    };
    cleanup = () => {
      signals.off('SIGINT', stop);
      signals.off('SIGTERM', stop);
    };
    signals.once('SIGINT', stop);
    signals.once('SIGTERM', stop);
  });
  return { promise, cleanup };
}

export async function runLocal(options = {}) {
  const config = options.config ?? loadLocalConfig(options.configOptions);
  const exec = options.exec ?? defaultExec;
  const checkPort = options.checkPort ?? defaultCheckPort;
  const waitForHttp = options.waitForHttp ?? defaultWaitForHttp;
  const verifyImages = options.verifyImages ?? defaultVerifyImages;
  const openBrowser = options.openBrowser ?? defaultOpenBrowser;
  const loadForgejoEnv = options.loadForgejoEnv ?? (() => loadLocalForgejoEnv({ cwd: config.cwd }));
  const signals = options.signals ?? process;
  const output = options.output ?? ((line) => process.stdout.write(`${line}\n`));
  const supervisor =
    options.supervisor ?? createProcessSupervisor({ output, redactions: config.redactions });
  let shutdownPromise;
  const shutdown = () => {
    shutdownPromise ??= supervisor.stopAll();
    return shutdownPromise;
  };
  const stopped = signalPromise(signals);
  const commandController = new AbortController();
  void stopped.promise.then(() => {
    commandController.abort();
    return shutdown();
  });

  const stopError = new Error('local_stop_requested');
  const stopFailure = stopped.promise.then(() => Promise.reject(stopError));
  const controlled = (promise) => Promise.race([promise, supervisor.failure, stopFailure]);
  const run = async (command, args) =>
    controlled(
      exec(command, args, {
        cwd: config.cwd,
        env: config.env,
        signal: commandController.signal,
      }),
    );
  const runPnpm = (args) => run(PNPM_COMMAND, [...PNPM_PREFIX, ...args]);
  const raceReady = (promise) => controlled(promise);
  const startHttp = async (spec, url) => {
    supervisor.start(spec);
    await raceReady(waitForHttp(url, { signal: commandController.signal }));
  };

  try {
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
      throw new LocalPreflightError('Node 22 or newer is required');
    }
    const pnpmVersion = (await runPnpm(['--version'])).stdout.trim();
    if (pnpmVersion !== '9.15.0') {
      throw new LocalPreflightError('pnpm 9.15.0 is required');
    }
    await run('docker', ['--version']);
    await run('docker', ['compose', 'version']);
    await run('docker', ['info']);
    for (const port of config.ports) {
      if (!(await checkPort(port))) {
        throw new LocalPreflightError(`Local application port ${String(port)} is already in use`);
      }
    }

    output('[local] starting infrastructure');
    await runPnpm(['exec', 'bash', 'scripts/dev-up.sh']);
    const forgejoEnv = await loadForgejoEnv();
    Object.assign(config.env, forgejoEnv);
    config.redactions.push(forgejoEnv.FORGEJO_ADMIN_TOKEN);
    await runPnpm(['db:migrate']);
    await runPnpm(['turbo', 'run', 'build', '--filter=!@zapp/desktop']);
    await controlled(verifyImages(config));

    await startHttp(
      pnpmService('git-service', ['--filter', '@zapp/git-service', 'dev'], config, {
        HOST: '127.0.0.1',
        PORT: '4500',
      }),
      'http://127.0.0.1:4500/healthz',
    );
    await startHttp(
      pnpmService('model-gateway', ['--filter', '@zapp/model-gateway', 'dev'], config, {
        MODEL_GATEWAY_PORT: '4100',
      }),
      'http://127.0.0.1:4100/healthz',
    );
    await startHttp(
      pnpmService('sandbox-service', ['--filter', '@zapp/sandbox-service', 'dev'], config, {
        SANDBOX_HOST: '127.0.0.1',
        SANDBOX_PORT: '4400',
      }),
      'http://127.0.0.1:4400/healthz',
    );
    supervisor.start(
      pnpmService(
        'agent-runs-worker',
        ['--filter', '@zapp/orchestrator-worker', 'dev:run'],
        config,
      ),
    );
    await raceReady(
      supervisor.waitForLine('agent-runs-worker', '"queue":"agent-runs","status":"ready"'),
    );
    supervisor.start(
      pnpmService(
        'verification-worker',
        ['--filter', '@zapp/orchestrator-worker', 'start:verification'],
        config,
      ),
    );
    await raceReady(supervisor.waitForLine('verification-worker', /state: 'RUNNING'/u));
    await startHttp(
      pnpmService('control-api', ['--filter', '@zapp/control-api', 'dev'], config, {
        HOST: '127.0.0.1',
        PORT: '4000',
      }),
      'http://127.0.0.1:4000/healthz',
    );
    await startHttp(
      pnpmService(
        'web',
        ['--filter', '@zapp/web', 'dev', '--hostname', '127.0.0.1', '--port', '3000'],
        config,
        { NEXT_PUBLIC_CONTROL_API_URL: 'http://127.0.0.1:4000' },
      ),
      'http://127.0.0.1:3000/login',
    );

    output('[local] ready: http://127.0.0.1:3000');
    if (config.openBrowser) await controlled(openBrowser('http://127.0.0.1:3000'));
    await Promise.race([stopped.promise, supervisor.failure]);
    await shutdown();
    return 0;
  } catch (error) {
    await shutdown();
    if (error === stopError) return 0;
    throw error;
  } finally {
    stopped.cleanup();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runLocal();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local startup failed';
    process.stderr.write(`[local] ${message}\n`);
    process.exitCode = 1;
  }
}
