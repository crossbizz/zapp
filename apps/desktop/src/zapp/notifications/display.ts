import type { NativeNotificationProjection } from "./controller";

export interface NativeNotificationOptions {
  readonly body: string;
  readonly tag: string;
}

export interface NativeNotificationHandle {
  onclick: (() => void) | null;
}

function validProjectDeepLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "zapp:" &&
      parsed.hostname === "project" &&
      /^\/proj_[0-9A-HJKMNP-TV-Z]{26}$/u.test(parsed.pathname) &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

export function createNativeNotificationDisplay(input: {
  readonly create: (
    title: string,
    options: NativeNotificationOptions,
  ) => NativeNotificationHandle;
  readonly openDeepLink: (deepLink: string) => void | Promise<void>;
  readonly permission: () => NotificationPermission;
}): (notification: NativeNotificationProjection) => Promise<boolean> {
  return async (notification) => {
    if (
      input.permission() !== "granted" ||
      !validProjectDeepLink(notification.deepLink)
    ) {
      return false;
    }
    try {
      const native = input.create(notification.title, {
        body: notification.body,
        tag: notification.eventId,
      });
      native.onclick = () => {
        void Promise.resolve(input.openDeepLink(notification.deepLink)).catch(
          () => undefined,
        );
      };
      return true;
    } catch {
      return false;
    }
  };
}
