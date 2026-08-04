// zapp: single source of truth for this fork's product identity (MAC-2).
//
// Upstream bakes the string "dyad" into the bundle id, the product/executable
// name, the URL scheme and the userData directory. Every one of those is a
// user-visible or OS-registered identifier, so they are hoisted here and the
// upstream call sites import from this module. A merge conflict then shows up
// as one `// zapp:` marked import per file rather than a scattered rename.
//
// This module must stay dependency-free: `forge.config.ts` imports it at
// packaging time (outside Electron) and `src/main.ts` imports it at runtime.

/** Reverse-DNS bundle identifier (`CFBundleIdentifier`). */
export const ZAPP_APP_BUNDLE_ID = "build.zapp.desktop";

/**
 * Product name — `CFBundleName`/`CFBundleDisplayName`, the `.app` directory
 * name, the packaged executable name and the maker artifact prefix.
 */
export const ZAPP_PRODUCT_NAME = "zapp";

/** Deep-link URL scheme registered with the OS (`zapp://…`). */
export const ZAPP_PROTOCOL_SCHEME = "zapp";

/** `zapp://` — prefix used to recognise a deep link in argv. */
export const ZAPP_PROTOCOL_PREFIX = `${ZAPP_PROTOCOL_SCHEME}://`;

/** Human-readable protocol name (`CFBundleURLName`, Linux `.desktop` Name). */
export const ZAPP_PROTOCOL_NAME = "zapp";

/**
 * Directory under the OS application-data root that holds settings, the local
 * database and logs.
 *
 * Changing this orphans state written by a Dyad-era build (which used `dyad`).
 * Importing that state is MAC-12's job; nothing here reads the old directory.
 */
export const ZAPP_USER_DATA_DIR_NAME = "zapp";

/** macOS bundle directory produced by `@electron/packager` for this app. */
export const ZAPP_MAC_APP_DIR_NAME = `${ZAPP_PRODUCT_NAME}.app`;
