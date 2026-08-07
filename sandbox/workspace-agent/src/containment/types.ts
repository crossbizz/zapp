export type ContainmentTerminationReason = 'disconnect' | 'explicit' | 'shutdown' | 'timeout';

export interface ExecutionContainment {
  readonly id: string;
  readonly procsPath: string;
  kill(): Promise<void>;
  waitForEmpty(): Promise<void>;
  remove(): Promise<void>;
}

export interface Containment {
  create(): Promise<ExecutionContainment>;
}

export class ContainmentUnavailableError extends Error {
  constructor() {
    super('Execution containment is unavailable');
    this.name = 'ContainmentUnavailableError';
  }
}
