import type { RuntimeMode2 } from "@/lib/schemas";

export function localAutonomousModePolicy(runtimeMode: RuntimeMode2): {
  readonly disabled: boolean;
  readonly hint: "Move to cloud" | null;
} {
  return runtimeMode === "cloud"
    ? { disabled: false, hint: null }
    : { disabled: true, hint: "Move to cloud" };
}
