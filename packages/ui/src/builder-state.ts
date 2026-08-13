export interface BuilderEvent {
  readonly id: string;
  readonly type: string;
  readonly data: {
    readonly sequence: number;
    readonly payload: Readonly<Record<string, unknown>>;
  };
}

export interface BuilderSnapshot {
  readonly approvalIds: readonly string[];
  readonly messages: readonly { readonly role: "assistant" | "user"; readonly content: string }[];
  readonly runStatus: "cancelled" | "completed" | "paused" | "running" | "unknown";
}

export function mergeBuilderEvent<T extends BuilderEvent>(
  events: readonly T[],
  incoming: T,
  maximum = 1_000,
): readonly T[] {
  if (events.some((event) => event.data.sequence === incoming.data.sequence)) return events;
  return [...events, incoming]
    .sort((left, right) => left.data.sequence - right.data.sequence)
    .slice(-maximum);
}

export function reduceBuilderEvents(events: readonly BuilderEvent[]): BuilderSnapshot {
  let runStatus: BuilderSnapshot["runStatus"] = "unknown";
  const approvals = new Set<string>();
  const messages: Array<BuilderSnapshot["messages"][number]> = [];
  for (const event of [...events].sort((left, right) => left.data.sequence - right.data.sequence)) {
    if (event.type === "run.started" || event.type === "run.resumed") runStatus = "running";
    if (event.type === "run.paused") runStatus = "paused";
    if (event.type === "run.completed") runStatus = "completed";
    if (event.type === "run.cancelled") runStatus = "cancelled";
    if (event.type === "message.user" || event.type === "message.assistant") {
      const content = event.data.payload["content"];
      if (typeof content === "string") {
        messages.push({ role: event.type === "message.user" ? "user" : "assistant", content });
      }
    }
    const approvalId = event.data.payload["approvalId"];
    if (typeof approvalId === "string") {
      if (event.type === "approval.requested") approvals.add(approvalId);
      if (event.type === "approval.resolved") approvals.delete(approvalId);
    }
  }
  return { approvalIds: [...approvals], messages, runStatus };
}
