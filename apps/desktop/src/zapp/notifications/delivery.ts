import { z } from "zod";

import type { NativeNotificationProjection } from "./controller";

const id = (prefix: "org" | "user") =>
  z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`, "u"));
const supportedType = z.enum([
  "approval_requested",
  "run_completed",
  "run_failed",
  "deploy_succeeded",
  "deploy_failed",
]);
const notification = z
  .object({
    channel: z.literal("desktop_push"),
    cursor: z.number().int().positive(),
    desktopUrl: z.string().url(),
    occurredAt: z.string().datetime({ offset: true }),
    organizationId: id("org"),
    subject: z.string().min(1).max(200),
    text: z.string().min(1),
    triggerId: z.string().min(1).max(512),
    type: supportedType,
    userId: id("user"),
    webUrl: z.string().url(),
  })
  .strict();
const page = z
  .object({
    nextCursor: z.number().int().nonnegative(),
    notifications: z.array(notification).max(100),
    reconnectAfterMs: z.number().int().min(500).max(30_000),
  })
  .strict();

export interface DesktopNotificationRequest {
  (
    path: "/v1/desktop-notifications",
    options: {
      readonly method: "GET";
      readonly headers: { readonly "x-organization-id": string };
      readonly query: {
        readonly after: number;
        readonly deviceId: string;
        readonly limit: number;
      };
    },
  ): Promise<unknown>;
}

/** Non-blocking cursor consumer for the public CP-27 desktop projection. */
export function createDesktopNotificationDelivery(input: {
  readonly cancel: (handle: unknown) => void;
  readonly deviceId: string;
  readonly onError?: (error: Error) => void;
  readonly organizationId: string;
  readonly request: DesktopNotificationRequest;
  readonly schedule: (callback: () => void, delayMs: number) => unknown;
  readonly show: (
    notification: NativeNotificationProjection,
  ) => Promise<boolean>;
}): { close(): void; start(): void } {
  const organizationId = id("org").parse(input.organizationId);
  const deviceId = z.string().trim().min(1).max(128).parse(input.deviceId);
  let active = false;
  let cursor = 0;
  let timer: unknown;

  const poll = async (): Promise<void> => {
    if (!active) return;
    let delayMs = 1_000;
    try {
      const parsed = page.parse(
        await input.request("/v1/desktop-notifications", {
          method: "GET",
          headers: { "x-organization-id": organizationId },
          query: { after: cursor, deviceId, limit: 100 },
        }),
      );
      if (
        parsed.notifications.some(
          (value) => value.organizationId !== organizationId,
        )
      ) {
        throw new Error("Desktop notification tenant mismatch.");
      }
      for (const value of parsed.notifications) {
        if (!active) return;
        await input.show({
          body: value.text,
          deepLink: value.desktopUrl,
          eventId: value.triggerId,
          preferenceType: value.type,
          title: value.subject,
        });
      }
      cursor = parsed.nextCursor;
      delayMs = parsed.reconnectAfterMs;
    } catch (error) {
      input.onError?.(
        error instanceof Error
          ? error
          : new Error("Desktop notification polling failed."),
      );
    }
    if (active) timer = input.schedule(() => void poll(), delayMs);
  };

  return {
    close() {
      active = false;
      if (timer !== undefined) input.cancel(timer);
      timer = undefined;
    },
    start() {
      if (active) return;
      active = true;
      void poll();
    },
  };
}
