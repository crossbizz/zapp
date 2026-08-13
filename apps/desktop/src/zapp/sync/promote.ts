export type PromotionPhase =
  | "initialized"
  | "cloud_created"
  | "repository_pushed"
  | "capabilities_scanned"
  | "workspace_booted"
  | "linked"
  | "done";

export interface PromotionState {
  readonly cloudProjectId?: string;
  readonly fingerprint: string;
  readonly localProjectId: string;
  readonly operationKey: string;
  readonly phase: PromotionPhase;
  readonly workspaceId?: string;
}

export interface PromotionStore {
  load(localProjectId: string): Promise<PromotionState | undefined>;
  save(state: PromotionState): Promise<void>;
}

export interface PromotionPort {
  fingerprint(localProjectId: string): Promise<string>;
  createCloudProject(input: {
    fingerprint: string;
    operationKey: string;
  }): Promise<string>;
  pushRepository(localProjectId: string, cloudProjectId: string): Promise<void>;
  scanCapabilities(cloudProjectId: string): Promise<void>;
  bootWorkspace(cloudProjectId: string): Promise<string>;
  markLinked(input: {
    localProjectId: string;
    cloudProjectId: string;
    fingerprint: string;
  }): Promise<void>;
}

export class LocalProjectPromotion {
  constructor(
    private readonly localProjectId: string,
    private readonly store: PromotionStore,
    private readonly port: PromotionPort,
    private readonly options: { stopAfter?: PromotionPhase } = {},
  ) {}

  private async save(state: PromotionState): Promise<PromotionState> {
    await this.store.save(state);
    return state;
  }

  private stopped(state: PromotionState): boolean {
    return state.phase === this.options.stopAfter;
  }

  async run(): Promise<PromotionState> {
    let state = await this.store.load(this.localProjectId);
    if (state === undefined) {
      const fingerprint = await this.port.fingerprint(this.localProjectId);
      state = await this.save({
        fingerprint,
        localProjectId: this.localProjectId,
        operationKey: `promote:${fingerprint}`,
        phase: "initialized",
      });
    }
    if (this.stopped(state) || state.phase === "done") return state;

    if (state.phase === "initialized") {
      const cloudProjectId = await this.port.createCloudProject({
        fingerprint: state.fingerprint,
        operationKey: state.operationKey,
      });
      state = await this.save({
        ...state,
        cloudProjectId,
        phase: "cloud_created",
      });
    }
    if (this.stopped(state)) return state;
    const cloudProjectId = state.cloudProjectId;
    if (cloudProjectId === undefined)
      throw new Error("Promotion is missing its cloud project");

    if (state.phase === "cloud_created") {
      await this.port.pushRepository(this.localProjectId, cloudProjectId);
      state = await this.save({ ...state, phase: "repository_pushed" });
    }
    if (this.stopped(state)) return state;
    if (state.phase === "repository_pushed") {
      await this.port.scanCapabilities(cloudProjectId);
      state = await this.save({ ...state, phase: "capabilities_scanned" });
    }
    if (this.stopped(state)) return state;
    if (state.phase === "capabilities_scanned") {
      const workspaceId = await this.port.bootWorkspace(cloudProjectId);
      state = await this.save({
        ...state,
        phase: "workspace_booted",
        workspaceId,
      });
    }
    if (this.stopped(state)) return state;
    if (state.phase === "workspace_booted") {
      await this.port.markLinked({
        localProjectId: this.localProjectId,
        cloudProjectId,
        fingerprint: state.fingerprint,
      });
      state = await this.save({ ...state, phase: "linked" });
    }
    if (this.stopped(state)) return state;
    if (state.phase === "linked")
      state = await this.save({ ...state, phase: "done" });
    return state;
  }
}
