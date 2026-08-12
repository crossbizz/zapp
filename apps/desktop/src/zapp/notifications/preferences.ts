import { z } from "zod";

import type { NativeNotificationPreference } from "./controller";

const NotificationTypeSchema = z.enum([
  "approval_requested",
  "run_completed",
  "run_failed",
  "budget_50",
  "budget_80",
  "budget_100",
  "synthetic_check_failed",
  "production_incident",
  "deploy_succeeded",
  "deploy_failed",
  "payment_failed",
  "member_invited",
]);
const EntityIdSchema = (prefix: "org" | "user") =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u"));

const NotificationPreferenceSchema = z
  .object({
    organizationId: EntityIdSchema("org"),
    userId: EntityIdSchema("user"),
    type: NotificationTypeSchema,
    email: z.boolean(),
    inApp: z.boolean(),
    desktopPush: z.boolean(),
  })
  .strict();

const NotificationPreferencesResponseSchema = z
  .object({ preferences: z.array(NotificationPreferenceSchema) })
  .strict();
const NotificationPreferenceResponseSchema = z
  .object({ preference: NotificationPreferenceSchema })
  .strict();

export interface NotificationPreferenceRequest {
  (
    path: "/v1/notification-preferences",
    options: {
      readonly method: "GET";
      readonly headers: { readonly "x-organization-id": string };
    },
  ): Promise<unknown>;
  (
    path: "/v1/notification-preferences/{type}",
    options: {
      readonly method: "PUT";
      readonly path: { readonly type: NativeNotificationPreference };
      readonly headers: { readonly "x-organization-id": string };
      readonly body: {
        readonly desktopPush: boolean;
        readonly email: boolean;
        readonly inApp: boolean;
      };
    },
  ): Promise<unknown>;
}

/** Loads the public preference resource; unknown/missing types stay disabled. */
export function createDesktopPreferenceReader(input: {
  readonly organizationId: string;
  readonly request: NotificationPreferenceRequest;
}): {
  enabled(type: NativeNotificationPreference): boolean;
  refresh(): Promise<void>;
  set(type: NativeNotificationPreference, enabled: boolean): Promise<void>;
} {
  const organizationId = EntityIdSchema("org").parse(input.organizationId);
  let preferences = new Map<
    string,
    z.infer<typeof NotificationPreferenceSchema>
  >();

  return {
    enabled(type) {
      return preferences.get(type)?.desktopPush ?? false;
    },
    async refresh() {
      const parsed = NotificationPreferencesResponseSchema.parse(
        await input.request("/v1/notification-preferences", {
          method: "GET",
          headers: { "x-organization-id": organizationId },
        }),
      );
      if (
        parsed.preferences.some(
          (preference) => preference.organizationId !== organizationId,
        )
      ) {
        preferences = new Map();
        throw new Error("Notification preference tenant mismatch.");
      }
      preferences = new Map(
        parsed.preferences.map((preference) => [preference.type, preference]),
      );
    },
    async set(type, enabled) {
      const current = preferences.get(type);
      if (current === undefined) {
        throw new Error("Notification preferences must be refreshed first.");
      }
      const response = NotificationPreferenceResponseSchema.parse(
        await input.request("/v1/notification-preferences/{type}", {
          method: "PUT",
          path: { type },
          headers: { "x-organization-id": organizationId },
          body: {
            email: current.email,
            inApp: current.inApp,
            desktopPush: enabled,
          },
        }),
      );
      if (
        response.preference.organizationId !== organizationId ||
        response.preference.type !== type
      ) {
        throw new Error("Notification preference response mismatch.");
      }
      preferences.set(type, response.preference);
    },
  };
}
