import {
  CloudProjectOpenIntentSchema,
  type CloudProjectOpenIntent,
} from "./model";

export const CLOUD_PROJECT_OPEN_EVENT = "zapp:open-cloud-project";

export function publishCloudProjectOpenIntent(
  intent: CloudProjectOpenIntent,
): void {
  window.dispatchEvent(
    new CustomEvent(CLOUD_PROJECT_OPEN_EVENT, {
      detail: CloudProjectOpenIntentSchema.parse(intent),
    }),
  );
}
