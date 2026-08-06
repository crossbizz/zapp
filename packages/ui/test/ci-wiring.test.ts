import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readPackageScripts(): Record<string, string> {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  );
  if (typeof manifest !== 'object' || manifest === null || !('scripts' in manifest)) {
    throw new Error('packages/ui/package.json must define scripts');
  }

  const { scripts } = manifest;
  if (typeof scripts !== 'object' || scripts === null) {
    throw new Error('packages/ui/package.json scripts must be an object');
  }

  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') {
      throw new Error(`packages/ui script ${name} must be a string`);
    }
    commands[name] = command;
  }
  return commands;
}

const scripts = readPackageScripts();

function expandScript(name: string, ancestors: readonly string[] = []): string {
  if (ancestors.includes(name)) {
    throw new Error(`Recursive package script wiring: ${[...ancestors, name].join(' -> ')}`);
  }

  const command = scripts[name];
  if (command === undefined) {
    throw new Error(`Missing packages/ui script: ${name}`);
  }

  const references = Array.from(
    command.matchAll(/\bpnpm(?:\s+run)?\s+([a-z][\w:-]*)/gu),
    (match) => match[1],
  ).filter((reference): reference is string => reference !== undefined && reference in scripts);

  return [
    command,
    ...references.map((reference) => expandScript(reference, [...ancestors, name])),
  ].join('\n');
}

describe('@zapp/ui CI script wiring', () => {
  it('routes the normal build through the Vite package-export consumer', () => {
    expect(expandScript('build')).toContain('vite build examples/vite');
  });

  it('routes the normal test through Storybook axe', () => {
    expect(expandScript('test')).toContain('test-storybook --url http://127.0.0.1:6006');
  });
});
