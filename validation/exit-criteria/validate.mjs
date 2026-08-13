import { access, readFile, realpath } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const STATES = new Set(['candidate', 'blocked', 'failed', 'verified']);
const EXPECTED_IDS = Array.from({ length: 22 }, (_, index) => `E${index + 1}`);
const EXPECTED_CRITERIA = [
  'A first-time nontechnical user can move from one initial prompt through clarification, build, preview, iteration, readiness check, and deployment without leaving the unified builder or opening a terminal.',
  'Conversation, preview, Mission Control, and deployment status remain synchronized across web and macOS.',
  'A user can sign in on web and macOS.',
  'A user can create or import a Dyad-compatible project.',
  'The project can run locally on macOS or in Modal.',
  'The cloud project survives sandbox termination and resumes from durable state.',
  'Autonomous mode conducts an interview and obtains plan approval.',
  'Mission Control shows structured progress and allows pause, resume, redirect, and cancel.',
  'Builder produces task-scoped commits.',
  'Verifier independently evaluates acceptance criteria.',
  'The platform can generate and execute browser tests.',
  'A failed test can trigger a bounded repair loop.',
  'The user can open an authenticated preview.',
  'The user can connect GitHub.',
  'The user can connect at least one database provider.',
  'The user can deploy through at least one production provider.',
  'A release evidence manifest is generated.',
  'A healthy previous deployment can be restored.',
  'Usage and cost are recorded per organization and run.',
  'Tenant isolation, secret redaction, and sandbox abuse tests pass.',
  'A production error can be converted into a Fix run.',
  'Five real applications complete at least five repeat changes each during internal validation.',
];
const execFile = promisify(execFileCallback);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, field) {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    `${field} must be a non-empty string`,
  );
}

async function evidencePath(repositoryRoot, relativePath, field) {
  nonEmptyString(relativePath, field);
  invariant(
    !path.isAbsolute(relativePath) &&
      relativePath.split(/[\\/]/u).every((segment) => segment !== '..'),
    `${field} must be repository-relative`,
  );
  const canonicalRoot = await realpath(repositoryRoot);
  const candidate = path.resolve(repositoryRoot, relativePath);
  await access(candidate);
  const canonicalCandidate = await realpath(candidate);
  invariant(
    canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`),
    `${field} must resolve inside the repository`,
  );
}

export async function validateResultArtifact(repositoryRoot, relativePath, criterion, field) {
  await evidencePath(repositoryRoot, relativePath, field);
  let artifact;
  try {
    artifact = JSON.parse(await readFile(path.resolve(repositoryRoot, relativePath), 'utf8'));
  } catch {
    throw new Error(`${field} must be a JSON result artifact`);
  }
  invariant(
    artifact?.schemaVersion === (criterion.requiredEvidenceSchemaVersion ?? 1),
    `${field} evidence artifact schemaVersion must be ${criterion.requiredEvidenceSchemaVersion ?? 1}`,
  );
  const boundEvidence = artifact.schemaVersion === 2;
  invariant(
    boundEvidence
      ? /^[0-9a-f]{40}$/u.test(artifact?.baseline)
      : /^[0-9a-f]{7,40}$/u.test(artifact?.baseline),
    `${field}.baseline must be a ${boundEvidence ? 'full ' : ''}Git SHA`,
  );
  if (boundEvidence) {
    let baselineType = '';
    try {
      baselineType = (
        await execFile('git', ['-C', repositoryRoot, 'cat-file', '-t', artifact.baseline])
      ).stdout.trim();
    } catch {
      // The invariant below reports the stable validation error.
    }
    invariant(baselineType === 'commit', `${field}.baseline must identify a repository commit`);
    for (const source of criterion.sourceEvidence) {
      let sourceType = '';
      try {
        sourceType = (
          await execFile('git', [
            '-C',
            repositoryRoot,
            'cat-file',
            '-t',
            `${artifact.baseline}:${source}`,
          ])
        ).stdout.trim();
      } catch {
        // The invariant below reports the stable validation error.
      }
      invariant(
        sourceType === 'blob',
        `${field}.sourceEvidence must be a regular file at baseline: ${source}`,
      );
    }
  }
  invariant(
    typeof artifact?.capturedAt === 'string' &&
      !Number.isNaN(Date.parse(artifact.capturedAt)) &&
      (!boundEvidence || new Date(artifact.capturedAt).toISOString() === artifact.capturedAt),
    `${field}.capturedAt must be ISO-8601`,
  );
  invariant(Array.isArray(artifact?.results), `${field}.results must be an array`);
  const matches = artifact.results.filter((result) => result?.criterionId === criterion.id);
  invariant(matches.length === 1, `${field} must contain exactly one ${criterion.id} result`);
  const result = matches[0];
  const expectedOutcome = criterion.state === 'verified' ? 'passed' : 'failed';
  invariant(result.outcome === expectedOutcome, `${field} outcome must be ${expectedOutcome}`);
  invariant(
    Array.isArray(result.commands) && result.commands.length > 0,
    `${field} result commands must not be empty`,
  );
  if (boundEvidence) {
    invariant(
      JSON.stringify(result.commands.map(({ command }) => command)) ===
        JSON.stringify(criterion.verifyCommands),
      `${field} commands must exactly match verifyCommands`,
    );
  }
  for (const [commandIndex, command] of result.commands.entries()) {
    nonEmptyString(command?.command, `${field}.commands[${commandIndex}].command`);
    invariant(
      Number.isInteger(command?.exitCode) && command.exitCode >= 0,
      `${field}.commands[${commandIndex}].exitCode must be non-negative`,
    );
    nonEmptyString(command?.summary, `${field}.commands[${commandIndex}].summary`);
    if (boundEvidence) {
      nonEmptyString(command?.outputArtifact, `${field}.commands[${commandIndex}].outputArtifact`);
      invariant(
        /^sha256:[0-9a-f]{64}$/u.test(command?.outputSha256),
        `${field}.commands[${commandIndex}].outputSha256 must be SHA-256`,
      );
      await evidencePath(
        repositoryRoot,
        command.outputArtifact,
        `${field}.commands[${commandIndex}].outputArtifact`,
      );
      const output = await readFile(path.resolve(repositoryRoot, command.outputArtifact));
      const digest = createHash('sha256').update(output).digest('hex');
      invariant(
        command.outputSha256 === `sha256:${digest}`,
        `${field}.commands[${commandIndex}].outputSha256 must match captured bytes`,
      );
      invariant(
        path.basename(command.outputArtifact) === `${digest}.log`,
        `${field}.commands[${commandIndex}].outputArtifact must be content-addressed`,
      );
      const header = [
        'zapp-exit-evidence-v2',
        `baseline: ${artifact.baseline}`,
        `capturedAt: ${artifact.capturedAt}`,
        `command: ${command.command}`,
        '---',
        '',
      ].join('\n');
      invariant(
        output.subarray(0, Buffer.byteLength(header)).equals(Buffer.from(header)),
        `${field}.commands[${commandIndex}] captured header must bind baseline, timestamp, and command`,
      );
    }
  }
  if (expectedOutcome === 'passed') {
    invariant(
      result.commands.every((command) => command.exitCode === 0),
      `${field} passed result cannot contain a failed command`,
    );
  } else {
    invariant(
      result.commands.some((command) => command.exitCode !== 0),
      `${field} failed result must contain a failed command`,
    );
  }
}

export async function loadExitCriteriaManifest(repositoryRoot) {
  return JSON.parse(
    await readFile(
      path.join(repositoryRoot, 'validation', 'exit-criteria', 'manifest.json'),
      'utf8',
    ),
  );
}

export async function validateExitCriteriaManifest(manifest, repositoryRoot) {
  invariant(manifest?.schemaVersion === 1, 'exit criteria schemaVersion must be 1');
  invariant(manifest?.source === 'PRD-39', 'exit criteria source must be PRD-39');
  invariant(Array.isArray(manifest?.criteria), 'criteria must be an array');
  invariant(manifest.criteria.length === 22, 'matrix must contain exactly 22 criteria');

  const ids = new Set();
  const counts = { candidate: 0, blocked: 0, failed: 0, verified: 0 };
  const tracker = await readFile(path.join(repositoryRoot, 'tasks', 'todo.md'), 'utf8');
  const taskStates = new Map();
  for (const match of tracker.matchAll(/^- \[([ x])\] ([A-Z]+-[A-Z0-9.-]+)/gmu)) {
    taskStates.set(match[2], match[1] === 'x');
  }
  for (const [index, criterion] of manifest.criteria.entries()) {
    const prefix = `criteria[${index}]`;
    nonEmptyString(criterion?.id, `${prefix}.id`);
    invariant(!ids.has(criterion.id), `criterion id must be unique: ${criterion.id}`);
    ids.add(criterion.id);
    nonEmptyString(criterion.criterion, `${prefix}.criterion`);
    invariant(criterion.criterion === EXPECTED_CRITERIA[index], `${prefix} must match PRD §39`);
    invariant(STATES.has(criterion.state), `${prefix}.state is invalid`);
    counts[criterion.state] += 1;
    invariant(
      Array.isArray(criterion.requiredTasks) && criterion.requiredTasks.length > 0,
      `${prefix}.requiredTasks must not be empty`,
    );
    const requiredTaskStates = criterion.requiredTasks.map((task, taskIndex) => {
      nonEmptyString(task, `${prefix}.requiredTasks[${taskIndex}]`);
      invariant(taskStates.has(task), `${prefix}.requiredTasks contains unknown task: ${task}`);
      return taskStates.get(task);
    });
    if (
      criterion.state === 'candidate' ||
      criterion.state === 'failed' ||
      criterion.state === 'verified'
    ) {
      invariant(requiredTaskStates.every(Boolean), 'candidate criteria require all tasks checked');
    } else {
      invariant(
        requiredTaskStates.some((checked) => !checked),
        'blocked criteria require at least one unchecked task',
      );
    }
    invariant(
      Array.isArray(criterion.sourceEvidence) && criterion.sourceEvidence.length > 0,
      `${prefix}.sourceEvidence must not be empty`,
    );
    for (const [sourceIndex, source] of criterion.sourceEvidence.entries()) {
      await evidencePath(repositoryRoot, source, `${prefix}.sourceEvidence[${sourceIndex}]`);
    }
    invariant(
      Array.isArray(criterion.verifyCommands) && criterion.verifyCommands.length > 0,
      `${prefix}.verifyCommands must not be empty`,
    );
    criterion.verifyCommands.forEach((command, commandIndex) =>
      nonEmptyString(command, `${prefix}.verifyCommands[${commandIndex}]`),
    );
    if (criterion.requiredEvidenceSchemaVersion !== undefined) {
      invariant(
        criterion.requiredEvidenceSchemaVersion === 2,
        `${prefix}.requiredEvidenceSchemaVersion must be 2`,
      );
    }
    invariant(
      Array.isArray(criterion.evidenceArtifacts),
      `${prefix}.evidenceArtifacts is required`,
    );
    if (criterion.state === 'verified') {
      invariant(
        criterion.evidenceArtifacts.length > 0,
        'verified criteria require at least one evidence artifact',
      );
    }
    if (criterion.state === 'failed') nonEmptyString(criterion.failure, `${prefix}.failure`);
    for (const [artifactIndex, artifact] of criterion.evidenceArtifacts.entries()) {
      const field = `${prefix}.evidenceArtifacts[${artifactIndex}]`;
      if (criterion.state === 'verified' || criterion.state === 'failed') {
        await validateResultArtifact(repositoryRoot, artifact, criterion, field);
      } else {
        await evidencePath(repositoryRoot, artifact, field);
      }
    }
    if (criterion.state === 'blocked') nonEmptyString(criterion.blocker, `${prefix}.blocker`);
  }

  invariant(
    JSON.stringify([...ids]) === JSON.stringify(EXPECTED_IDS),
    'criterion ids must be ordered E1 through E22',
  );
  return { criteria: manifest.criteria.length, ids: [...ids], ...counts };
}

async function main() {
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const result = await validateExitCriteriaManifest(
    await loadExitCriteriaManifest(repositoryRoot),
    repositoryRoot,
  );
  process.stdout.write(
    `P0 evidence matrix valid: ${result.criteria} criteria; ${result.verified} verified, ${result.candidate} candidates, ${result.failed} failed, ${result.blocked} blocked\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
