import { z } from 'zod';

export const ResourceProfileNameSchema = z.enum(['small', 'standard', 'large']);

const ResourceRangeSchema = z
  .object({
    requested: z.number().positive(),
    limit: z.number().positive(),
  })
  .strict()
  .refine((value) => value.limit >= value.requested, 'limit must cover requested resources');

export const ResourceProfileSchema = z
  .object({
    cpu: ResourceRangeSchema,
    memoryGib: ResourceRangeSchema,
  })
  .strict();

export type ResourceProfileName = z.infer<typeof ResourceProfileNameSchema>;
export type ResourceProfile = z.infer<typeof ResourceProfileSchema>;

const ResourceProfilesSchema = z.record(ResourceProfileNameSchema, ResourceProfileSchema);

const resourceProfiles = ResourceProfilesSchema.parse({
  small: {
    cpu: { requested: 0.5, limit: 2 },
    memoryGib: { requested: 1, limit: 4 },
  },
  standard: {
    cpu: { requested: 1, limit: 4 },
    memoryGib: { requested: 2, limit: 8 },
  },
  large: {
    cpu: { requested: 2, limit: 8 },
    memoryGib: { requested: 4, limit: 16 },
  },
});

export function getResourceProfile(name: ResourceProfileName): ResourceProfile {
  return ResourceProfileSchema.parse(resourceProfiles[name]);
}
