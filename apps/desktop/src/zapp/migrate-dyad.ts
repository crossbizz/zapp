import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

const MigrationInputSchema = z
  .object({
    destinationPath: z.string().trim().min(1).optional(),
    homeDirectory: z.string().trim().min(1),
    name: z.string().trim().min(1).max(120),
    operationId: z.string().uuid(),
    sourcePath: z.string().trim().min(1),
    strategy: z.enum(["copy", "adopt"]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.strategy === "copy" && input.destinationPath === undefined) {
      context.addIssue({
        code: "custom",
        message: "destinationPath is required for copy migrations",
        path: ["destinationPath"],
      });
    }
  });
const RegisteredProjectSchema = z
  .object({
    appId: z.number().int().positive(),
    chatId: z.number().int().positive(),
  })
  .strict();

export interface DetectedDyadProject {
  readonly name: string;
  readonly path: string;
}

export interface DyadTranscriptArchive {
  readonly format: "dyad-read-only-transcript-archive-v1";
  readonly files: readonly {
    readonly path: string;
    readonly text: string;
  }[];
}

export interface DyadMigrationPorts {
  readonly archiveTranscripts?: (
    sourcePath: string,
    targetPath: string,
    operationId: string,
  ) => Promise<boolean>;
  readonly copyProject: (
    sourcePath: string,
    targetPath: string,
    operationId: string,
  ) => Promise<void>;
  readonly initializeGit: (
    projectPath: string,
    operationId: string,
  ) => Promise<void>;
  readonly isGitRepository: (projectPath: string) => Promise<boolean>;
  readonly offerCloudPromotion?: (input: {
    readonly appId: number;
    readonly operationId: string;
  }) => Promise<void>;
  readonly registerLocalProject: (input: {
    readonly name: string;
    readonly operationId: string;
    readonly path: string;
    readonly source: "dyad-migration";
  }) => Promise<{ readonly appId: number; readonly chatId: number }>;
}

const ARCHIVE_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".xml"]);
const MAX_ARCHIVE_FILES = 100;
const MAX_ARCHIVE_FILE_BYTES = 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 8 * 1024 * 1024;

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export async function detectDyadProjects(input: {
  readonly homeDirectory: string;
}): Promise<readonly DetectedDyadProject[]> {
  const legacyHome = path.resolve(input.homeDirectory, "dyad-apps");
  let entries;
  try {
    entries = await fs.readdir(legacyHome, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const projects = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith("."),
      )
      .map(async (entry): Promise<DetectedDyadProject | undefined> => {
        const candidate = path.join(legacyHome, entry.name);
        const canonical = await fs.realpath(candidate);
        if (path.dirname(canonical) !== (await fs.realpath(legacyHome))) {
          return undefined;
        }
        return { name: entry.name, path: canonical };
      }),
  );
  return projects
    .filter((project): project is DetectedDyadProject => project !== undefined)
    .sort((left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "base" }),
    );
}

async function collectTranscriptFiles(
  root: string,
  directory: string,
  files: Array<{ path: string; text: string }>,
  total: { bytes: number },
): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    if (files.length >= MAX_ARCHIVE_FILES) return;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTranscriptFiles(root, absolute, files, total);
      continue;
    }
    if (
      !entry.isFile() ||
      !ARCHIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      continue;
    }
    const stats = await fs.stat(absolute);
    if (
      stats.size > MAX_ARCHIVE_FILE_BYTES ||
      total.bytes + stats.size > MAX_ARCHIVE_TOTAL_BYTES
    ) {
      continue;
    }
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    files.push({
      path: relative.split(path.sep).join("/"),
      text: await fs.readFile(absolute, "utf8"),
    });
    total.bytes += stats.size;
  }
}

/** Reads legacy backups as opaque text; callers never insert them as live chat rows. */
export async function readDyadTranscriptArchive(
  projectPath: string,
): Promise<DyadTranscriptArchive> {
  const root = path.join(projectPath, ".dyad", "chats");
  const files: Array<{ path: string; text: string }> = [];
  try {
    const [canonicalProject, canonicalRoot] = await Promise.all([
      fs.realpath(projectPath),
      fs.realpath(root),
    ]);
    if (!isWithin(canonicalProject, canonicalRoot)) {
      return { format: "dyad-read-only-transcript-archive-v1", files };
    }
    await collectTranscriptFiles(canonicalRoot, canonicalRoot, files, {
      bytes: 0,
    });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { format: "dyad-read-only-transcript-archive-v1", files };
}

async function ensurePrivateDirectory(
  parent: string,
  childName: string,
): Promise<string> {
  const candidate = path.join(parent, childName);
  try {
    const stats = await fs.lstat(candidate);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Dyad transcript archive directory is unsafe.");
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
    await fs.mkdir(candidate, { mode: 0o700 });
  }
  const [canonicalParent, canonicalCandidate] = await Promise.all([
    fs.realpath(parent),
    fs.realpath(candidate),
  ]);
  if (!isWithin(canonicalParent, canonicalCandidate)) {
    throw new Error("Dyad transcript archive directory escaped the project.");
  }
  return canonicalCandidate;
}

async function archiveDyadTranscripts(
  sourcePath: string,
  targetPath: string,
): Promise<boolean> {
  const archive = await readDyadTranscriptArchive(sourcePath);
  if (archive.files.length === 0) return false;
  const zappDirectory = await ensurePrivateDirectory(targetPath, ".zapp");
  const directory = await ensurePrivateDirectory(zappDirectory, "migrations");
  const archivePath = path.join(directory, "dyad-chat-history.json");
  try {
    const stats = await fs.lstat(archivePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Dyad transcript archive target is unsafe.");
    }
    await fs.chmod(archivePath, 0o600);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await fs.writeFile(archivePath, `${JSON.stringify(archive, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.chmod(archivePath, 0o400);
  return true;
}

async function canonicalLegacySource(
  homeDirectory: string,
  sourcePath: string,
): Promise<string> {
  const legacyHome = await fs.realpath(
    path.resolve(homeDirectory, "dyad-apps"),
  );
  const source = await fs.realpath(path.resolve(sourcePath));
  if (path.dirname(source) !== legacyHome) {
    throw new Error(
      "Dyad migration source must be a direct child of the legacy dyad-apps home.",
    );
  }
  return source;
}

export async function migrateDyadProject(
  value: unknown,
  ports: DyadMigrationPorts,
): Promise<{
  readonly appId: number;
  readonly chatId: number;
  readonly path: string;
  readonly promotionOffered: boolean;
  readonly transcriptArchived: boolean;
}> {
  const input = MigrationInputSchema.parse(value);
  const sourcePath = await canonicalLegacySource(
    input.homeDirectory,
    input.sourcePath,
  );
  const targetPath =
    input.strategy === "adopt"
      ? sourcePath
      : path.resolve(input.destinationPath as string);
  if (
    input.strategy === "copy" &&
    (targetPath === sourcePath ||
      isWithin(sourcePath, targetPath) ||
      isWithin(targetPath, sourcePath))
  ) {
    throw new Error(
      "Dyad migration destination cannot overwrite or nest inside its source.",
    );
  }

  if (input.strategy === "copy") {
    await ports.copyProject(sourcePath, targetPath, input.operationId);
  }
  const canonicalTarget = await fs.realpath(targetPath);
  if (
    input.strategy === "copy" &&
    (canonicalTarget === sourcePath ||
      isWithin(sourcePath, canonicalTarget) ||
      isWithin(canonicalTarget, sourcePath))
  ) {
    throw new Error("Dyad migration copy resolved into its source tree.");
  }
  if (!(await ports.isGitRepository(canonicalTarget))) {
    await ports.initializeGit(canonicalTarget, input.operationId);
  }
  const registered = RegisteredProjectSchema.parse(
    await ports.registerLocalProject({
      name: input.name,
      operationId: input.operationId,
      path: canonicalTarget,
      source: "dyad-migration",
    }),
  );

  let transcriptArchived = false;
  try {
    transcriptArchived = await (
      ports.archiveTranscripts ?? archiveDyadTranscripts
    )(sourcePath, canonicalTarget, input.operationId);
  } catch {
    // Transcript migration is explicitly best-effort and never mutates live chat state.
  }

  let promotionOffered = false;
  if (ports.offerCloudPromotion !== undefined) {
    try {
      await ports.offerCloudPromotion({
        appId: registered.appId,
        operationId: input.operationId,
      });
      promotionOffered = true;
    } catch {
      // Cloud availability must not roll back a completed local migration.
    }
  }

  return {
    ...registered,
    path: canonicalTarget,
    promotionOffered,
    transcriptArchived,
  };
}
