import { ModelIdentifierSchema } from '@zapp/contracts';

export function allowedModelsFromPolicy(policy: unknown): ReadonlySet<string> {
  const candidates = Array.isArray(policy)
    ? policy
    : typeof policy === 'object' && policy !== null && 'allowedModels' in policy
      ? (policy as { readonly allowedModels?: unknown }).allowedModels
      : undefined;

  if (!Array.isArray(candidates)) return new Set();

  const allowed = new Set<string>();
  for (const candidate of candidates) {
    const parsed = ModelIdentifierSchema.safeParse(candidate);
    if (parsed.success) allowed.add(parsed.data);
  }
  return allowed;
}
