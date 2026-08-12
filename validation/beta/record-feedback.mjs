import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = [
  'id',
  'agencyAlias',
  'category',
  'severity',
  'productArea',
  'summaryCode',
  'externalReference',
];
const CATEGORIES = new Set([
  'reliability',
  'usability',
  'performance',
  'verification',
  'billing',
  'support',
]);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
const PRODUCT_AREAS = new Set([
  'builder',
  'preview',
  'verification',
  'deployment',
  'billing',
  'desktop',
  'integrations',
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateFeedbackRecord(record) {
  invariant(
    record && typeof record === 'object' && !Array.isArray(record),
    'feedback must be an object',
  );
  for (const field of Object.keys(record)) {
    invariant(FIELDS.includes(field), `unknown feedback field: ${field}`);
  }
  invariant(Object.keys(record).length === FIELDS.length, 'feedback fields are incomplete');
  invariant(/^BETA-\d{4}$/u.test(record.id), 'feedback id must be BETA-NNNN');
  invariant(
    /^beta-0[1-5]$/u.test(record.agencyAlias),
    'agencyAlias must use an anonymous beta slot',
  );
  invariant(CATEGORIES.has(record.category), 'feedback category is invalid');
  invariant(SEVERITIES.has(record.severity), 'feedback severity is invalid');
  invariant(PRODUCT_AREAS.has(record.productArea), 'feedback productArea is invalid');
  invariant(
    /^[a-z0-9]+(?:-[a-z0-9]+){1,7}$/u.test(record.summaryCode),
    'summaryCode must be a bounded lowercase slug',
  );
  invariant(
    /^feedback_[A-Za-z0-9_-]{10,80}$/u.test(record.externalReference),
    'externalReference must be an opaque feedback id',
  );
  return record;
}

export function formatFeedbackTask(record) {
  validateFeedbackRecord(record);
  return `- [ ] ${record.id} [${record.category}/${record.severity}] ${record.agencyAlias} ${record.productArea}: ${record.summaryCode} (ref ${record.externalReference})`;
}

export async function appendFeedbackTask(record, tasksDirectory) {
  validateFeedbackRecord(record);
  await mkdir(tasksDirectory, { recursive: true });
  const task = `${formatFeedbackTask(record)}\n`;
  const target = path.join(tasksDirectory, `${record.id}.md`);
  const temporary = path.join(tasksDirectory, `.${record.id}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporary, task, { encoding: 'utf8', flag: 'wx' });
  try {
    await link(temporary, target);
    return true;
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
    const existing = await readFile(target, 'utf8');
    if (existing !== task)
      throw new Error(`feedback task id conflicts with existing content: ${record.id}`);
    return false;
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function main() {
  const [recordPath, requestedTasksPath] = process.argv.slice(2);
  if (!recordPath) throw new Error('usage: node record-feedback.mjs <record.json> [tasks-file]');
  const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');
  const tasksDirectory = path.resolve(
    requestedTasksPath ?? path.join(repositoryRoot, 'tasks', 'beta-feedback'),
  );
  const record = JSON.parse(await readFile(path.resolve(recordPath), 'utf8'));
  const appended = await appendFeedbackTask(record, tasksDirectory);
  process.stdout.write(`${appended ? 'appended' : 'already recorded'}: ${record.id}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
