import { z } from 'zod';

/** PRD §13.2. */
export const TaskStateSchema = z.enum([
  'queued',
  'blocked',
  'ready',
  'running',
  'waiting_for_approval',
  'verifying',
  'repairing',
  'passed',
  'failed',
  'cancelled',
  'superseded',
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

export const RunModeSchema = z.enum(['ask', 'prototype', 'build', 'fix', 'autonomous']);

export type RunMode = z.infer<typeof RunModeSchema>;

export const SupportLevelSchema = z.enum(['compatible', 'verified', 'managed']);

export type SupportLevel = z.infer<typeof SupportLevelSchema>;
