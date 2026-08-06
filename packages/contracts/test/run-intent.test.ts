import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  APP_TYPES,
  AppTypeSchema,
  ModelIdentifierSchema,
  type AppType,
  type ModelIdentifier,
} from '../src/index.js';

describe('structured run intent', () => {
  it('accepts only the public web and mobile app types', () => {
    expect(APP_TYPES).toEqual(['web', 'mobile']);
    expect(AppTypeSchema.parse('web')).toBe('web');
    expect(AppTypeSchema.parse('mobile')).toBe('mobile');
    expect(() => AppTypeSchema.parse('desktop')).toThrow();
  });

  it('accepts bounded provider/model identifiers without whitespace', () => {
    expect(ModelIdentifierSchema.parse('anthropic/claude-sonnet-5')).toBe(
      'anthropic/claude-sonnet-5',
    );
    expect(ModelIdentifierSchema.parse('openai:gpt_5.1-mini')).toBe('openai:gpt_5.1-mini');
    expect(() => ModelIdentifierSchema.parse(' model with spaces ')).toThrow();
    expect(() => ModelIdentifierSchema.parse('')).toThrow();
    expect(() => ModelIdentifierSchema.parse(`a${'b'.repeat(160)}`)).toThrow();
  });

  it('infers both public types from their schemas', () => {
    expectTypeOf<AppType>().toEqualTypeOf<z.infer<typeof AppTypeSchema>>();
    expectTypeOf<ModelIdentifier>().toEqualTypeOf<z.infer<typeof ModelIdentifierSchema>>();
  });
});
