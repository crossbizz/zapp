import { createHmac } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { idSchema } from '@zapp/contracts';
import { z } from 'zod';

const SigningKeySchema = z.instanceof(Buffer).refine((key) => key.byteLength >= 32, {
  message: 'Preview signing key must contain at least 32 bytes',
});
const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
export const PreviewShareLocatorSchema = z.string().regex(/^[0-9a-hjkmnp-tv-z]{26}$/u);
const BearerSchema = z.string().regex(/^psb_[A-Za-z0-9_-]{43}$/u);
const SecretSchema = z.string().regex(/^(?:psb|pbg|pss)_[A-Za-z0-9_-]{43}$/u);
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

function hmac(key: Buffer, domain: string, fields: readonly string[]): Buffer {
  return createHmac('sha256', key)
    .update(domain)
    .update('\0')
    .update(fields.join('\0'))
    .digest();
}

function lowerCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && output.length < 26) {
      bits -= 5;
      output += CROCKFORD[(value >>> bits) & 31] ?? '';
    }
    if (output.length === 26) break;
  }
  return PreviewShareLocatorSchema.parse(output);
}

export interface PreviewShareLocatorInput {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly operationKey: string;
  readonly signingKey: Buffer;
}

/** Stable DNS-safe share identity. Tenant scope is part of the derivation. */
export function previewShareLocator(input: PreviewShareLocatorInput): string {
  const organizationId = idSchema('org').parse(input.organizationId);
  const workspaceId = idSchema('ws').parse(input.workspaceId);
  const operationKey = OperationKeySchema.parse(input.operationKey);
  const signingKey = SigningKeySchema.parse(input.signingKey);
  return lowerCrockford(
    hmac(signingKey, 'zapp-preview-share-locator-v1', [
      organizationId,
      workspaceId,
      operationKey,
    ]),
  );
}

export interface CreatePreviewSecretInput {
  readonly organizationId: string;
  readonly shareLocator: string;
  readonly keyVersion: number;
  readonly signingKey: Buffer;
}

export interface PreviewSecret {
  /** Returned once to the browser and deterministically recoverable for a keyed retry. */
  readonly bearer: string;
  /** The only secret representation permitted in durable storage. */
  readonly hash: string;
  readonly keyVersion: number;
}

function previewBearer(input: CreatePreviewSecretInput): string {
  const organizationId = idSchema('org').parse(input.organizationId);
  const shareLocator = PreviewShareLocatorSchema.parse(input.shareLocator);
  const keyVersion = z.number().int().positive().parse(input.keyVersion);
  const signingKey = SigningKeySchema.parse(input.signingKey);
  return BearerSchema.parse(
    `psb_${hmac(signingKey, 'zapp-preview-share-bearer-v1', [
      organizationId,
      shareLocator,
      String(keyVersion),
    ]).toString('base64url')}`,
  );
}

export async function createPreviewSecret(
  input: CreatePreviewSecretInput,
): Promise<PreviewSecret> {
  const bearer = previewBearer(input);
  const tokenHash = await hashPreviewSecret(bearer);
  return {
    bearer,
    hash: tokenHash,
    keyVersion: z.number().int().positive().parse(input.keyVersion),
  };
}

export async function hashPreviewSecret(secret: string): Promise<string> {
  const parsed = SecretSchema.parse(secret);
  return await hash(parsed, {
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  });
}

export async function verifyPreviewSecret(bearer: string, tokenHash: string): Promise<boolean> {
  const candidate = SecretSchema.safeParse(bearer);
  if (!candidate.success || !tokenHash.startsWith('$argon2id$')) return false;
  try {
    return await verify(tokenHash, candidate.data);
  } catch {
    return false;
  }
}

/** Reconstructs the exact bearer for a keyed lost-response replay. */
export function recoverPreviewBearer(input: CreatePreviewSecretInput): string {
  return previewBearer(input);
}

export interface PreviewGrantInput {
  readonly organizationId: string;
  readonly shareLocator: string;
  readonly operationKey: string;
  readonly signingKey: Buffer;
}

export function derivePreviewGrant(input: PreviewGrantInput): string {
  const organizationId = idSchema('org').parse(input.organizationId);
  const shareLocator = PreviewShareLocatorSchema.parse(input.shareLocator);
  const operationKey = OperationKeySchema.parse(input.operationKey);
  const signingKey = SigningKeySchema.parse(input.signingKey);
  return SecretSchema.parse(
    `pbg_${hmac(signingKey, 'zapp-preview-bootstrap-grant-v1', [
      organizationId,
      shareLocator,
      operationKey,
    ]).toString('base64url')}`,
  );
}

export interface PreviewSessionCredential {
  readonly id: string;
  readonly secret: string;
}

export function derivePreviewSessionCredential(input: {
  readonly organizationId: string;
  readonly shareLocator: string;
  readonly grant: string;
  readonly signingKey: Buffer;
}): PreviewSessionCredential {
  const organizationId = idSchema('org').parse(input.organizationId);
  const shareLocator = PreviewShareLocatorSchema.parse(input.shareLocator);
  const grant = SecretSchema.parse(input.grant);
  const signingKey = SigningKeySchema.parse(input.signingKey);
  const digest = hmac(signingKey, 'zapp-preview-session-v1', [
    organizationId,
    shareLocator,
    grant,
  ]);
  return {
    id: digest.subarray(0, 16).toString('base64url'),
    secret: SecretSchema.parse(`pss_${digest.toString('base64url')}`),
  };
}
