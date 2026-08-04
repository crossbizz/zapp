#!/usr/bin/env node
// zapp: the standalone hoisted install that @electron/packager needs (MAC-2).
//
//   pnpm --filter @zapp/desktop run install:packaging
//
// Two things this does that a bare `pnpm install` flag string cannot:
//
// 1. Wipes node_modules first. pnpm reconciles installs incrementally against
//    node_modules/.modules.yaml, and converging a workspace (isolated, linked)
//    tree onto a hoisted --ignore-workspace one leaves a broken hybrid: the
//    second run of this install printed "Packages: +109 -220" and produced a
//    tree without a top-level vite, so Forge resolved vite from the workspace
//    root instead and died with "Host version 0.21.5 does not match binary
//    version 0.19.12". Starting clean makes the layout deterministic; the
//    packaging store below makes starting clean cheap.
//
// 2. Points --store-dir at a packaging-only store. The install rebuilds
//    better-sqlite3/node-pty against Electron's ABI, and pnpm hard-links
//    package files out of a content-addressable store -- so with the default
//    shared store that rebuild lands on the workspace copies too, and every
//    later `node` run fails with NODE_MODULE_VERSION 143 vs 127.
//
// `pnpm install` from the workspace root restores the normal layout afterwards
// (scripts/zapp/make-mac.mjs does it for you, and verifies the ABI).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const nodeModules = path.join(desktopRoot, "node_modules");
if (fs.existsSync(nodeModules)) {
  console.log("Removing node_modules so the hoisted layout is deterministic.");
  fs.rmSync(nodeModules, { recursive: true, force: true });
}

const result = spawnSync(
  "pnpm",
  [
    "install",
    "--ignore-workspace",
    "--config.node-linker=hoisted",
    "--store-dir",
    ".packaging-store",
  ],
  { cwd: desktopRoot, stdio: "inherit", env: process.env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
