import {
  mergeBuilderEvent,
  reduceBuilderEvents,
  type BuilderEvent,
  type BuilderSnapshot,
} from "@zapp/ui";

export interface CloudBuilderTransport {
  subscribe(
    runId: string,
    onEvent: (event: BuilderEvent) => void,
  ): { close(): void };
  pause(runId: string): Promise<void> | void;
  resume(runId: string): Promise<void> | void;
  previewUrl(runId: string): Promise<string>;
}

export interface NativeCloudBuilderShell {
  setBadge(value: string): void;
}

export class CloudBuilderController {
  private events: readonly BuilderEvent[] = [];
  private subscription: { close(): void } | undefined;

  constructor(
    private readonly runId: string,
    private readonly transport: CloudBuilderTransport,
    private readonly native: NativeCloudBuilderShell,
  ) {}

  connect(): void {
    this.subscription?.close();
    this.subscription = this.transport.subscribe(this.runId, (event) => {
      this.events = mergeBuilderEvent(this.events, event);
      this.native.setBadge(String(this.snapshot().approvalIds.length || ""));
    });
  }

  close(): void {
    this.subscription?.close();
    this.subscription = undefined;
    this.native.setBadge("");
  }

  snapshot(): BuilderSnapshot {
    return reduceBuilderEvents(this.events);
  }

  async pause(): Promise<void> {
    await this.transport.pause(this.runId);
  }

  async resume(): Promise<void> {
    await this.transport.resume(this.runId);
  }

  nativeMenuActions(): readonly {
    readonly label: string;
    readonly run: () => Promise<void>;
  }[] {
    return [
      { label: "Pause run", run: () => this.pause() },
      { label: "Resume run", run: () => this.resume() },
    ];
  }

  async authenticatedPreviewUrl(): Promise<string> {
    const value = await this.transport.previewUrl(this.runId);
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      /(?:^|\.)modal\.run$/u.test(url.hostname)
    ) {
      throw new Error("Cloud builder refuses provider preview URLs");
    }
    return url.toString();
  }
}
