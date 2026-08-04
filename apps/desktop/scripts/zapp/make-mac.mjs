#!/usr/bin/env node
// zapp: one command for a macOS build, including the two pnpm workarounds the
// fork needs (MAC-2). See docs/adr/0002-dyad-fork.md §"Packaging needs a
// hoisted install".
//
//   pnpm --filter @zapp/desktop make:mac              # full build
//   pnpm --filter @zapp/desktop make:mac --skip-install
//   pnpm --filter @zapp/desktop make:mac --skip-restore   # CI: throwaway tree
//
// Two problems it solves:
//
// 1. @electron/packager walks production dependencies with flora-colossus,
//    which needs them flat in node_modules. pnpm's isolated linker puts them in
//    the virtual store, so packaging dies at "Copying files". Fix: a standalone
//    hoisted install (`install:packaging`, see that script for its own two
//    caveats).
//
// 2. That install rebuilds better-sqlite3/node-pty against Electron's ABI. pnpm
//    hard-links package files from a content-addressable store, so with the
//    default (shared) store the rebuilt binary lands on the workspace copy too
//    and every later `node` run fails with NODE_MODULE_VERSION 143 vs 127.
//    `install:packaging` avoids that with a packaging-only --store-dir; this
//    script *proves* it, by dlopen-ing the workspace copy after restoring the
//    workspace install, and repairs it with `pnpm rebuild` if it is wrong.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..", "..");
const workspaceRoot = path.resolve(desktopRoot, "..", "..");

const args = new Set(process.argv.slice(2));
const skipInstall = args.has("--skip-install");
const skipRestore = args.has("--skip-restore");

const NATIVE_MODULES = ["better-sqlite3", "node-pty"];

function run(command, commandArgs, cwd) {
  console.log(
    `\n$ (${path.relative(workspaceRoot, cwd) || "."}) ${command} ${commandArgs.join(" ")}`,
  );
  const result = spawnSync(command, commandArgs, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function runOrExit(command, commandArgs, cwd) {
  const status = run(command, commandArgs, cwd);
  if (status !== 0) {
    console.error(`\n${command} ${commandArgs.join(" ")} failed (${status}).`);
    process.exit(status);
  }
}

/**
 * Locate the better-sqlite3 binding the workspace actually loads.
 *
 * Resolved through realpath rather than by walking node_modules/.pnpm: the
 * virtual store lives at the workspace root (not the package), and this way the
 * probe follows whatever link layout the current install produced.
 * Returns null when the workspace install is not present (nothing to check).
 */
function findWorkspaceBinding() {
  const binding = path.join(
    desktopRoot,
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  );
  try {
    return fs.realpathSync(binding);
  } catch {
    return null;
  }
}

/** True when the binding loads under plain node (i.e. it is not Electron-ABI). */
function bindingHasNodeAbi(binding) {
  const probe = spawnSync(
    process.execPath,
    ["-e", `process.dlopen({ exports: {} }, ${JSON.stringify(binding)})`],
    { encoding: "utf8" },
  );
  if (probe.status === 0) return true;
  const stderr = probe.stderr ?? "";
  if (stderr.includes("NODE_MODULE_VERSION")) return false;
  // Anything else (a missing file, a link error) is not an ABI verdict.
  throw new Error(`Could not probe ${binding}:\n${stderr}`);
}

function main() {
  if (!skipInstall) {
    runOrExit("pnpm", ["run", "install:packaging"], desktopRoot);
  }

  const makeStatus = run("pnpm", ["run", "make"], desktopRoot);

  if (!skipRestore) {
    // Restore the workspace layout the packaging install replaced. Runs even
    // when `make` failed: leaving a hoisted standalone tree behind breaks every
    // other command in the repo.
    runOrExit("pnpm", ["install"], workspaceRoot);

    const binding = findWorkspaceBinding();
    if (binding && !bindingHasNodeAbi(binding)) {
      console.warn(
        "\nWorkspace native modules are on Electron's ABI - repairing.",
      );
      runOrExit("pnpm", ["rebuild", "-r", ...NATIVE_MODULES], workspaceRoot);
      const repaired = findWorkspaceBinding();
      if (repaired && !bindingHasNodeAbi(repaired)) {
        console.error("\npnpm rebuild did not restore the Node ABI.");
        process.exit(1);
      }
      console.log("Workspace native modules restored to node's ABI.");
    } else if (binding) {
      console.log("\nWorkspace native modules still on node's ABI (verified).");
    }
  }

  process.exit(makeStatus);
}

main();
