import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ContainmentUnavailableError,
  type Containment,
  type ExecutionContainment,
} from './types.js';

const EMPTY_WAIT_TIMEOUT_MS = 10_000;
const EMPTY_WAIT_INTERVAL_MS = 10;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

function hasNoProcesses(events: string): boolean {
  return /^populated\s+0$/mu.test(events);
}

class CgroupV2Execution implements ExecutionContainment {
  private killed = false;
  private removed = false;

  constructor(
    readonly id: string,
    private readonly directory: string,
  ) {}

  get procsPath(): string {
    return join(this.directory, 'cgroup.procs');
  }

  private get eventsPath(): string {
    return join(this.directory, 'cgroup.events');
  }

  private get killPath(): string {
    return join(this.directory, 'cgroup.kill');
  }

  async kill(): Promise<void> {
    if (this.killed) {
      return;
    }
    this.killed = true;
    try {
      await writeFile(this.killPath, '1\n');
    } catch {
      throw new ContainmentUnavailableError();
    }
  }

  async waitForEmpty(): Promise<void> {
    const deadline = Date.now() + EMPTY_WAIT_TIMEOUT_MS;
    for (;;) {
      try {
        if (hasNoProcesses(await readFile(this.eventsPath, 'utf8'))) {
          return;
        }
      } catch {
        throw new ContainmentUnavailableError();
      }
      if (Date.now() >= deadline) {
        throw new ContainmentUnavailableError();
      }
      // This observes the cgroup-v2 authoritative populated signal, never PIDs or process groups.
      await wait(EMPTY_WAIT_INTERVAL_MS);
    }
  }

  async remove(): Promise<void> {
    if (this.removed) {
      return;
    }
    this.removed = true;
    try {
      await rm(this.directory);
    } catch {
      throw new ContainmentUnavailableError();
    }
  }
}

export class CgroupV2Containment implements Containment {
  private readonly root: string;

  constructor(root = process.env.ZAPP_CGROUP_ROOT ?? '/sys/fs/cgroup') {
    this.root = resolve(root);
  }

  async create(): Promise<ExecutionContainment> {
    try {
      // Its presence identifies a cgroup-v2 hierarchy. A delegated subtree
      // can legitimately expose no resource controllers while still providing
      // the containment files required below.
      await readFile(join(this.root, 'cgroup.controllers'), 'utf8');
      await access(this.root, constants.W_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof ContainmentUnavailableError) {
        throw error;
      }
      throw new ContainmentUnavailableError();
    }

    const id = `zapp-exec-${randomUUID()}`;
    const directory = join(this.root, id);
    try {
      await mkdir(directory);
      const execution = new CgroupV2Execution(id, directory);
      await Promise.all([
        access(execution.procsPath, constants.R_OK | constants.W_OK),
        access(join(directory, 'cgroup.events'), constants.R_OK),
        access(join(directory, 'cgroup.kill'), constants.W_OK),
      ]);
      return execution;
    } catch {
      await rm(directory, { force: true }).catch(() => undefined);
      throw new ContainmentUnavailableError();
    }
  }
}

export function createProductionContainment(): Containment {
  return new CgroupV2Containment();
}
