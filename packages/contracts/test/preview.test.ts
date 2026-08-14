import { describe, expect, it } from 'vitest';

import {
  CreatePreviewShareBodySchema,
  PreviewHandleSchema,
  PreviewSessionExchangeBodySchema,
  PreviewSessionExchangeResultSchema,
  PreviewSessionRedeemBodySchema,
  PreviewShareSchema,
} from '../src/preview.js';

const share = {
  id: '01h00000000000000000000000',
  workspaceId: 'ws_01H00000000000000000000000',
  projectId: 'proj_01H00000000000000000000000',
  url: 'https://app.zapp.test/preview/org_01H00000000000000000000000/01h00000000000000000000000',
  expiresAt: '2026-08-10T00:00:00.000Z',
  policy: 'anyone_with_link' as const,
  createdAt: '2026-08-09T00:00:00.000Z',
  revokedAt: null,
};

describe('preview public boundary', () => {
  it('keeps public handles zapp-owned and secret-free', () => {
    expect(PreviewShareSchema.parse(share)).toEqual(share);
    expect(
      PreviewHandleSchema.parse({
        id: share.id,
        url: share.url,
        expiresAt: share.expiresAt,
        policy: share.policy,
      }),
    ).not.toHaveProperty('providerWorkspaceId');
    expect(PreviewShareSchema.safeParse({ ...share, tokenHash: '$argon2id$secret' }).success).toBe(
      false,
    );
  });

  it('allows HTTP preview URLs only for loopback development hosts', () => {
    expect(
      PreviewHandleSchema.safeParse({
        id: share.id,
        url: `http://127.0.0.1:3000/preview/org/${share.id}`,
        expiresAt: share.expiresAt,
        policy: share.policy,
      }).success,
    ).toBe(true);
    expect(
      PreviewSessionExchangeResultSchema.safeParse({
        previewOrigin: `http://org-${share.id}.preview.localhost:4000`,
        grant: 'pbg_' + 'a'.repeat(43),
        expiresAt: share.expiresAt,
      }).success,
    ).toBe(true);
    expect(
      PreviewHandleSchema.safeParse({
        id: share.id,
        url: `http://example.com/preview/org/${share.id}`,
        expiresAt: share.expiresAt,
        policy: share.policy,
      }).success,
    ).toBe(false);
  });

  it('uses strict create, exchange, and redemption bodies', () => {
    expect(
      CreatePreviewShareBodySchema.parse({ policy: 'org', expiresInSeconds: 3_600 }),
    ).toEqual({ policy: 'org', expiresInSeconds: 3_600 });
    expect(
      PreviewSessionExchangeBodySchema.safeParse({ bearer: 'psb_' + 'a'.repeat(43), leak: true })
        .success,
    ).toBe(false);
    expect(
      PreviewSessionRedeemBodySchema.parse({
        organizationId: 'org_01H00000000000000000000000',
        shareId: share.id,
        grant: 'pbg_' + 'a'.repeat(43),
      }),
    ).toMatchObject({ shareId: share.id });
    expect(
      PreviewSessionExchangeResultSchema.safeParse({
        previewOrigin: 'https://org-share.preview.zapp.test',
        grant: 'pbg_' + 'a'.repeat(43),
        expiresAt: share.expiresAt,
        providerUrl: 'https://modal.invalid',
      }).success,
    ).toBe(false);
  });
});
