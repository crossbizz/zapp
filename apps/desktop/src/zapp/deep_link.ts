// zapp: the deep-link routes this fork owns on the `zapp://` scheme (MAC-2).
//
// The inherited Dyad routes (`supabase-oauth-return`, `neon-oauth-return`,
// `add-mcp-server`, …) still live in `src/main.ts` and keep working — they just
// arrive on `zapp://` now. This module only claims the two zapp-specific
// surfaces so main.ts gains a single delegation point instead of new branches:
//
//   zapp://auth/callback?…   platform sign-in return  (wired up by MAC-4)
//   zapp://project/{id}      open a project           (wired up by MAC-7)
//
// Until then both are stubs: they log the route and focus the window, which is
// the behaviour a browser hand-off needs regardless of what follows.

import { ZAPP_PROTOCOL_SCHEME } from "./branding";

export type ZappDeepLink =
  | { route: "auth-callback"; params: URLSearchParams }
  | { route: "project"; projectId: string };

export interface ZappDeepLinkHandlers {
  /** Bring the main window to the front (restoring it if minimised). */
  focusWindow: () => void;
  /** Structured log sink. Never called with credential material. */
  log: (message: string, meta: Record<string, unknown>) => void;
}

/**
 * Split a deep-link path into its decoded, non-empty segments.
 *
 * For a non-special scheme the WHATWG parser still splits the authority from
 * the path, so `zapp://project/proj_1` yields host `project`, path `/proj_1`.
 */
function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

/**
 * Parse a `zapp://` URL into one of the routes this fork owns.
 *
 * Returns `null` for any other scheme, and for `zapp://` URLs belonging to the
 * inherited Dyad routes — the caller falls through to those.
 */
export function parseZappDeepLink(url: URL): ZappDeepLink | null {
  if (url.protocol !== `${ZAPP_PROTOCOL_SCHEME}:`) {
    return null;
  }

  const segments = pathSegments(url);

  if (url.hostname === "auth") {
    if (segments.length === 1 && segments[0] === "callback") {
      return { route: "auth-callback", params: url.searchParams };
    }
    return null;
  }

  if (url.hostname === "project") {
    if (segments.length === 1) {
      return { route: "project", projectId: segments[0] };
    }
    return null;
  }

  return null;
}

/**
 * Handle a `zapp://` deep link, returning whether it was consumed.
 *
 * `false` means the URL is not one of this fork's routes and the caller should
 * keep going through the inherited Dyad routes.
 */
export function handleZappDeepLink(
  url: URL,
  { focusWindow, log }: ZappDeepLinkHandlers,
): boolean {
  const link = parseZappDeepLink(url);
  if (!link) {
    return false;
  }

  // Deliberately never log the query string: the auth callback carries
  // single-use credential material. Only the route (and the opaque project id)
  // are safe to record.
  log(
    "Handling zapp deep link",
    link.route === "project"
      ? { route: link.route, projectId: link.projectId }
      : { route: link.route },
  );

  focusWindow();
  return true;
}
