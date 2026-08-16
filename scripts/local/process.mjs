import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

function redact(value, redactions) {
  return redactions.reduce(
    (visible, secret) => (secret === '' ? visible : visible.split(secret).join('[REDACTED]')),
    value,
  );
}

function exitPromise(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
  });
}

export function createProcessSupervisor({
  spawnImpl = spawn,
  killImpl = process.kill,
  output = (line) => process.stdout.write(`${line}\n`),
  redactions = [],
  maxTailLines = 100,
  shutdownGraceMs = 10_000,
  wait = delay,
} = {}) {
  const children = [];
  const lines = new EventEmitter();
  let stopping = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);

  function record(entry, stream, chunk) {
    entry.buffers[stream] += chunk.toString('utf8');
    const split = entry.buffers[stream].split(/\r?\n/u);
    entry.buffers[stream] = split.pop() ?? '';
    for (const raw of split) {
      const visible = redact(raw, redactions);
      entry.tail.push(visible);
      if (entry.tail.length > maxTailLines) entry.tail.shift();
      output(`[${entry.spec.name}] ${visible}`);
      lines.emit(entry.spec.name, visible);
    }
  }

  function start(spec) {
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const entry = {
      spec,
      child,
      tail: [],
      buffers: { stdout: '', stderr: '' },
      exited: false,
      exitedPromise: exitPromise(child),
    };
    children.push(entry);
    child.stdout?.on('data', (chunk) => record(entry, 'stdout', chunk));
    child.stderr?.on('data', (chunk) => record(entry, 'stderr', chunk));
    child.once('error', (error) => {
      entry.exited = true;
      if (!stopping && spec.required !== false) {
        rejectFailure(
          new Error(`${spec.name} failed to start: ${error.message}`, { cause: error }),
        );
      }
    });
    child.once('exit', (code, signal) => {
      entry.exited = true;
      if (!stopping && spec.required !== false) {
        rejectFailure(
          new Error(
            `${spec.name} exited before shutdown (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      }
    });
    return child;
  }

  async function waitForLine(name, matcher, timeoutMs = 60_000) {
    const entry = children.find((candidate) => candidate.spec.name === name);
    if (entry === undefined) throw new Error(`Unknown child ${name}`);
    const matches = (line) =>
      typeof matcher === 'string' ? line.includes(matcher) : matcher.test(line);
    if (entry.tail.some(matches)) return;
    let listener;
    const observed = new Promise((resolve) => {
      listener = (line) => {
        if (matches(line)) resolve();
      };
      lines.on(name, listener);
    });
    let timeout;
    try {
      await Promise.race([
        observed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`${name} did not report readiness`));
          }, timeoutMs);
        }),
        failure,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (listener !== undefined) lines.off(name, listener);
    }
  }

  async function waitForLineMatch(name, matcher, timeoutMs = 60_000) {
    const entry = children.find((candidate) => candidate.spec.name === name);
    if (entry === undefined) throw new Error(`Unknown child ${name}`);
    const matchLine = (line) => {
      matcher.lastIndex = 0;
      return matcher.exec(line);
    };
    for (const line of entry.tail) {
      const match = matchLine(line);
      if (match !== null) return match;
    }
    let listener;
    const observed = new Promise((resolve) => {
      listener = (line) => {
        const match = matchLine(line);
        if (match !== null) resolve(match);
      };
      lines.on(name, listener);
    });
    let timeout;
    try {
      return await Promise.race([
        observed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`${name} did not report a matching endpoint`));
          }, timeoutMs);
        }),
        failure,
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (listener !== undefined) lines.off(name, listener);
    }
  }

  async function stopAll() {
    if (stopping) return;
    stopping = true;
    for (const entry of [...children].reverse()) {
      if (entry.child.pid === undefined) continue;
      const processGroup = -entry.child.pid;
      try {
        killImpl(processGroup, 'SIGTERM');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }

      const deadline = Date.now() + shutdownGraceMs;
      let running = true;
      while (running && Date.now() < deadline) {
        try {
          killImpl(processGroup, 0);
          await wait(Math.min(50, Math.max(1, deadline - Date.now())));
        } catch (error) {
          if (error?.code === 'ESRCH') running = false;
          else throw error;
        }
      }
      if (running) {
        try {
          killImpl(processGroup, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error;
        }
      }
    }
  }

  return {
    failure,
    start,
    waitForLine,
    waitForLineMatch,
    stopAll,
    tail(name) {
      return [...(children.find((entry) => entry.spec.name === name)?.tail ?? [])];
    },
  };
}
