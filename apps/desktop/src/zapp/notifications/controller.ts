import { AgentEventSchema, type AgentEvent } from "@zapp/contracts";

export type NativeNotificationPreference =
  | "approval_requested"
  | "run_completed"
  | "run_failed"
  | "deploy_succeeded"
  | "deploy_failed";

export interface NativeNotificationProjection {
  readonly body: string;
  readonly deepLink: string;
  readonly eventId: string;
  readonly preferenceType: NativeNotificationPreference;
  readonly title: string;
}

interface RunEventSubscription {
  close(): void;
  readonly closed: Promise<void>;
}

interface RunEventEnvelope {
  readonly data: unknown;
}

interface RunEventSubscriptionOptions {
  readonly onEvent: (event: RunEventEnvelope) => void | Promise<void>;
  readonly onError?: (error: Error) => void;
}

export type SubscribeRunEvents = (
  runId: string,
  options: RunEventSubscriptionOptions,
) => RunEventSubscription;

function deploymentProjection(
  event: AgentEvent,
): NativeNotificationProjection | undefined {
  const status = event.payload["status"];
  const stage = event.payload["stage"];
  if (status === "failed") {
    return {
      body: "A production deployment failed. Open the project for details.",
      deepLink: `zapp://project/${event.projectId}`,
      eventId: event.id,
      preferenceType: "deploy_failed",
      title: "Deployment failed",
    };
  }
  if (stage !== "go_live" || status !== "passed") return undefined;
  return {
    body: "Your deployment is live.",
    deepLink: `zapp://project/${event.projectId}`,
    eventId: event.id,
    preferenceType: "deploy_succeeded",
    title: "Deployment live",
  };
}

export function projectNativeNotification(
  value: AgentEvent,
): NativeNotificationProjection | undefined {
  const event = AgentEventSchema.parse(value);
  if (event.visibility !== "user") return undefined;
  if (event.type === "approval.requested") {
    return {
      body: "A run is waiting for your approval.",
      deepLink: `zapp://project/${event.projectId}`,
      eventId: event.id,
      preferenceType: "approval_requested",
      title: "Approval requested",
    };
  }
  if (event.type === "run.completed") {
    const failed = event.payload["status"] === "failed";
    return {
      body: failed
        ? "A run finished with a failure. Open the project for details."
        : "Your run completed.",
      deepLink: `zapp://project/${event.projectId}`,
      eventId: event.id,
      preferenceType: failed ? "run_failed" : "run_completed",
      title: failed ? "Run failed" : "Run completed",
    };
  }
  if (event.type === "deployment.updated") {
    return deploymentProjection(event);
  }
  return undefined;
}

const MAX_SEEN_EVENTS = 1_000;

/** Owns one run subscription and projects eligible events into native UI. */
export function createRunNotificationController(input: {
  readonly enabled: (
    type: NativeNotificationPreference,
  ) => boolean | Promise<boolean>;
  readonly onError?: (error: Error) => void;
  readonly show: (
    notification: NativeNotificationProjection,
  ) => void | Promise<void>;
  readonly subscribe: SubscribeRunEvents;
}): {
  close(): void;
  start(runId: string): void;
} {
  let subscription: RunEventSubscription | undefined;
  let generation = 0;
  const seen = new Set<string>();

  function remember(eventId: string): boolean {
    if (seen.has(eventId)) return false;
    seen.add(eventId);
    if (seen.size > MAX_SEEN_EVENTS) {
      const oldest = seen.values().next().value as string | undefined;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  return {
    close() {
      generation += 1;
      subscription?.close();
      subscription = undefined;
      seen.clear();
    },
    start(runId) {
      generation += 1;
      const ownedGeneration = generation;
      subscription?.close();
      seen.clear();
      subscription = input.subscribe(runId, {
        async onEvent(envelope) {
          const parsed = AgentEventSchema.safeParse(envelope.data);
          if (!parsed.success) return;
          const notification = projectNativeNotification(parsed.data);
          if (notification === undefined || !remember(notification.eventId)) {
            return;
          }
          if (!(await input.enabled(notification.preferenceType))) return;
          if (generation !== ownedGeneration) return;
          await input.show(notification);
        },
        ...(input.onError === undefined ? {} : { onError: input.onError }),
      });
    },
  };
}
