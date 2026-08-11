import { createHash } from 'node:crypto';
import { domainToASCII } from 'node:url';

import {
  DnsInstructionSchema,
  DomainInputSchema as ProviderDomainInputSchema,
  DomainResultSchema as ProviderDomainResultSchema,
  idSchema,
} from '@zapp/contracts';
import { z } from 'zod';

import { flyAppName } from '../providers/fly.js';

const OperationKeySchema = z.string().regex(/^op_[a-f0-9]{64}$/u);
const ActivityKeySchema = z.string().trim().min(8).max(512);
const HostnameSchema = z.string().trim().min(1).max(253);
const ProviderIdSchema = z.string().trim().min(1).max(128);
const ProviderDomainReferenceSchema = z.string().trim().min(1).max(2_048);
const DomainStatusSchema = z.enum(['pending_dns', 'verifying', 'active', 'failed']);
const FailureCauseSchema = z.enum(['wrong_record', 'caa', 'rate_limit']);

export const DomainRequestSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    hostname: HostnameSchema,
    operationKey: OperationKeySchema,
  })
  .strict();
export type DomainRequest = z.infer<typeof DomainRequestSchema>;

const HostnameClassificationSchema = z
  .object({
    kind: z.enum(['apex', 'www', 'subdomain']),
    apexHostname: HostnameSchema,
    wwwHostname: HostnameSchema,
  })
  .strict();
type HostnameClassification = z.infer<typeof HostnameClassificationSchema>;

const DomainRoutingSchema = HostnameClassificationSchema.extend({
  recommendation: z.string().min(1),
}).strict();

export const DomainResultSchema = z
  .object({
    hostname: HostnameSchema,
    environmentId: idSchema('env'),
    status: DomainStatusSchema,
    dnsInstructions: z.array(DnsInstructionSchema),
    routing: DomainRoutingSchema,
    ssl: z
      .object({
        managed: z.literal(true),
        status: z.enum(['pending', 'active', 'failed']),
      })
      .strict(),
    detail: z.string().min(1).optional(),
  })
  .strict();
export type DomainResult = z.infer<typeof DomainResultSchema>;

const DomainRowSchema = z
  .object({
    organizationId: idSchema('org'),
    projectId: idSchema('proj'),
    environmentId: idSchema('env'),
    hostname: HostnameSchema,
    operationKey: OperationKeySchema,
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    providerId: ProviderIdSchema,
    providerDomainReference: ProviderDomainReferenceSchema.nullable(),
    status: DomainStatusSchema,
    dnsInstructions: z.array(DnsInstructionSchema),
    routing: DomainRoutingSchema,
    detail: z.string().min(1).nullable(),
    verificationAttempt: z.number().int().nonnegative(),
  })
  .strict();
type DomainRow = z.infer<typeof DomainRowSchema>;

const ProviderConfigurationSchema = z
  .object({
    providerDomainReference: ProviderDomainReferenceSchema,
    status: DomainStatusSchema,
    dnsInstructions: z.array(DnsInstructionSchema).min(1),
    failureCause: FailureCauseSchema.optional(),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (value.status === 'failed' && value.failureCause === undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'failureCause is required for a failed provider configuration',
      });
    }
    if (value.status !== 'failed' && value.failureCause !== undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'failureCause is only valid for a failed provider configuration',
      });
    }
  });

const ProviderVerificationSchema = z
  .object({
    status: z.enum(['verifying', 'active', 'failed']),
    failureCause: FailureCauseSchema.optional(),
  })
  .strict()
  .superRefine((value, refinement) => {
    if (value.status === 'failed' && value.failureCause === undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'failureCause is required for a failed provider verification',
      });
    }
    if (value.status !== 'failed' && value.failureCause !== undefined) {
      refinement.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failureCause'],
        message: 'failureCause is only valid for a failed provider verification',
      });
    }
  });

const DnsInspectionSchema = z
  .object({ state: z.enum(['pending', 'matched', 'wrong_record', 'caa_blocked']) })
  .strict();

const EnvironmentContextSchema = z.object({ providerId: ProviderIdSchema }).strict();

const FlyHostnameKindSchema = z.object({ kind: z.enum(['apex', 'www', 'subdomain']) }).strict();
const FlyCertificateSchema = z
  .object({
    hostname: HostnameSchema,
    configured: z.boolean(),
    acme_requested: z.boolean(),
    status: z.string().min(1),
    rate_limited_until: z.string().nullable().optional(),
    validation: z
      .object({
        dns_configured: z.boolean(),
        alpn_configured: z.boolean(),
        http_configured: z.boolean(),
        ownership_txt_configured: z.boolean(),
      })
      .passthrough(),
    dns_requirements: z
      .object({
        a: z.array(z.string().min(1)).default([]),
        aaaa: z.array(z.string().min(1)).default([]),
        cname: z.string().min(1).nullable().optional(),
        acme_challenge: z
          .object({ name: z.string().min(1), target: z.string().min(1) })
          .nullable()
          .optional(),
        ownership: z
          .object({
            name: z.string().min(1),
            app_value: z.string().min(1),
            org_value: z.string().min(1),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
    validation_errors: z.array(z.unknown()).default([]),
  })
  .passthrough();
type FlyCertificate = z.infer<typeof FlyCertificateSchema>;

interface DomainIdentity {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly hostname: string;
}

interface DomainClaim extends DomainIdentity {
  readonly operationKey: string;
  readonly fingerprint: string;
  readonly providerId: string;
  readonly providerDomainReference: null;
  readonly status: 'pending_dns';
  readonly dnsInstructions: readonly [];
  readonly routing: z.infer<typeof DomainRoutingSchema>;
  readonly detail: null;
  readonly verificationAttempt: 0;
}

interface DomainUpdate extends DomainIdentity {
  readonly expectedStatus: z.infer<typeof DomainStatusSchema>;
  readonly expectedVerificationAttempt: number;
  readonly providerDomainReference: string;
  readonly status: z.infer<typeof DomainStatusSchema>;
  readonly dnsInstructions: readonly z.infer<typeof DnsInstructionSchema>[];
  readonly routing: z.infer<typeof DomainRoutingSchema>;
  readonly detail: string | null;
  readonly verificationAttempt: number;
}

export interface DomainDependencies {
  readonly context: {
    /** Tenant-scoped environment lookup. Cross-tenant misses must surface as 404. */
    resolve(input: DomainIdentity): Promise<unknown>;
  };
  readonly store: {
    /** Environment-scoped domain row lookup. */
    get(input: DomainIdentity): Promise<unknown>;
    /** Atomically claims `(environment_id, hostname)` and the operation key. */
    claim(input: DomainClaim): Promise<unknown>;
    update(input: DomainUpdate): Promise<unknown>;
  };
  readonly dns: {
    /** Public-suffix-aware classification supplied by the DNS boundary. */
    classify(input: { readonly hostname: string }): Promise<unknown>;
    inspect(input: {
      readonly idempotencyKey: string;
      readonly hostname: string;
      readonly instructions: readonly z.infer<typeof DnsInstructionSchema>[];
    }): Promise<unknown>;
  };
  readonly provider: {
    /** Keyed adapter over Fly certificates or Vercel project domains. */
    configure(input: {
      readonly idempotencyKey: string;
      readonly providerId: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly hostname: string;
    }): Promise<unknown>;
    /** Keyed provider certificate/domain verification poll. */
    verify(input: {
      readonly idempotencyKey: string;
      readonly providerId: string;
      readonly providerDomainReference: string;
      readonly projectId: string;
      readonly environmentId: string;
      readonly hostname: string;
    }): Promise<unknown>;
  };
}

export type DomainServiceErrorCode =
  | 'domain_conflict'
  | 'domain_invalid'
  | 'domain_not_found'
  | 'domain_provider_invalid'
  | 'domain_store_invalid';

export class DomainServiceError extends Error {
  constructor(
    readonly code: DomainServiceErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'DomainServiceError';
  }
}

export interface FlyCertificateDomainAdapterDependencies {
  readonly apiBaseUrl?: string;
  readonly apiToken: string;
  readonly classifyHostname: (input: { readonly hostname: string }) => Promise<unknown>;
  readonly fetch?: typeof fetch;
}

function flyDomainInstructions(
  certificate: FlyCertificate,
  kind: z.infer<typeof FlyHostnameKindSchema>['kind'],
): z.infer<typeof DnsInstructionSchema>[] {
  const instructions: z.infer<typeof DnsInstructionSchema>[] = [];
  if (
    kind === 'apex' ||
    certificate.dns_requirements.cname === null ||
    certificate.dns_requirements.cname === undefined
  ) {
    for (const address of certificate.dns_requirements.a) {
      instructions.push({ type: 'A', name: certificate.hostname, value: address });
    }
  } else {
    instructions.push({
      type: 'CNAME',
      name: certificate.hostname,
      value: certificate.dns_requirements.cname,
    });
  }
  const ownership = certificate.dns_requirements.ownership;
  if (ownership !== null && ownership !== undefined) {
    instructions.push({
      type: 'TXT',
      name: ownership.name,
      value: `${ownership.app_value};${ownership.org_value}`,
    });
  }
  if (instructions.length === 0) {
    throw new DomainServiceError(
      'domain_provider_invalid',
      502,
      'Fly did not return usable DNS instructions for the hostname.',
    );
  }
  return instructions.map((instruction) => DnsInstructionSchema.parse(instruction));
}

function flyDomainResult(
  certificate: FlyCertificate,
  kind: z.infer<typeof FlyHostnameKindSchema>['kind'],
): z.infer<typeof ProviderDomainResultSchema> {
  const failed =
    certificate.rate_limited_until !== null && certificate.rate_limited_until !== undefined;
  const status = failed
    ? 'failed'
    : certificate.status === 'active'
      ? 'active'
      : certificate.configured ||
          certificate.validation.dns_configured ||
          certificate.validation.alpn_configured ||
          certificate.validation.http_configured ||
          certificate.validation.ownership_txt_configured
        ? 'verifying'
        : 'pending_dns';
  return ProviderDomainResultSchema.parse({
    hostname: certificate.hostname,
    status,
    dnsInstructions: flyDomainInstructions(certificate, kind),
    ...(failed
      ? { detail: 'Domain verification is temporarily rate-limited. Try again later.' }
      : {}),
  });
}

/**
 * Concrete DEP-10 implementation of DEP-4's Fly domain seam. It uses Fly's
 * ACME certificate resource and never returns credentials or provider bodies.
 */
export function createFlyCertificateDomainAdapter(
  dependencies: FlyCertificateDomainAdapterDependencies,
): {
  configure(
    input: z.input<typeof ProviderDomainInputSchema>,
  ): Promise<z.infer<typeof ProviderDomainResultSchema>>;
  verify(
    input: z.input<typeof ProviderDomainInputSchema>,
  ): Promise<z.infer<typeof ProviderDomainResultSchema>>;
} {
  const baseUrl = z
    .string()
    .url()
    .parse(dependencies.apiBaseUrl ?? 'https://api.machines.dev/v1')
    .replace(/\/$/u, '');
  const token = z
    .string()
    .trim()
    .min(1)
    .parse(dependencies.apiToken)
    .replace(/^(?:Bearer|FlyV1)\s+/u, '');
  const doFetch = dependencies.fetch ?? fetch;

  async function request(
    path: string,
    init: RequestInit,
    accepted: readonly number[],
  ): Promise<Response> {
    const response = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    });
    if (!accepted.includes(response.status)) {
      throw new DomainServiceError(
        'domain_provider_invalid',
        502,
        `Fly certificate request failed with HTTP ${response.status.toString()}.`,
      );
    }
    return response;
  }

  async function parseCertificate(
    response: Response,
    expectedHostname: string,
  ): Promise<FlyCertificate> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new DomainServiceError(
        'domain_provider_invalid',
        502,
        'Fly returned a non-JSON certificate response.',
      );
    }
    const parsed = FlyCertificateSchema.safeParse(body);
    if (!parsed.success || parsed.data.hostname !== expectedHostname) {
      throw new DomainServiceError(
        'domain_provider_invalid',
        502,
        'Fly returned an invalid certificate for the requested hostname.',
      );
    }
    return parsed.data;
  }

  async function classification(hostname: string): Promise<z.infer<typeof FlyHostnameKindSchema>> {
    return FlyHostnameKindSchema.parse(await dependencies.classifyHostname({ hostname }));
  }

  return {
    async configure(inputValue) {
      const input = ProviderDomainInputSchema.parse(inputValue);
      const appName = flyAppName(input.projectId, input.environmentId);
      const hostname = normalizeHostname(input.hostname);
      const encodedApp = encodeURIComponent(appName);
      const encodedHostname = encodeURIComponent(hostname);
      const existing = await request(
        `/apps/${encodedApp}/certificates/${encodedHostname}`,
        { method: 'GET' },
        [200, 404],
      );
      const certificate =
        existing.status === 200
          ? await parseCertificate(existing, hostname)
          : await parseCertificate(
              await request(
                `/apps/${encodedApp}/certificates/acme`,
                { method: 'POST', body: JSON.stringify({ hostname }) },
                [200, 201],
              ),
              hostname,
            );
      const hostnameKind = await classification(hostname);
      return flyDomainResult(certificate, hostnameKind.kind);
    },

    async verify(inputValue) {
      const input = ProviderDomainInputSchema.parse(inputValue);
      const appName = flyAppName(input.projectId, input.environmentId);
      const hostname = normalizeHostname(input.hostname);
      const certificate = await parseCertificate(
        await request(
          `/apps/${encodeURIComponent(appName)}/certificates/${encodeURIComponent(hostname)}/check`,
          { method: 'POST' },
          [200],
        ),
        hostname,
      );
      const hostnameKind = await classification(hostname);
      return flyDomainResult(certificate, hostnameKind.kind);
    },
  };
}

function normalizeHostname(value: string): string {
  const source = value.trim().toLowerCase().replace(/\.$/u, '');
  if (source.includes('://') || /[/\\:*?#@]/u.test(source)) {
    throw new DomainServiceError(
      'domain_invalid',
      400,
      'Enter a hostname without a scheme, port, path, query, fragment, or wildcard.',
    );
  }
  const hostname = domainToASCII(source);
  const labels = hostname.split('.');
  if (
    hostname.length === 0 ||
    hostname.length > 253 ||
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new DomainServiceError('domain_invalid', 400, 'Enter a valid public hostname.');
  }
  return hostname;
}

function identity(input: DomainRequest): DomainIdentity {
  return {
    organizationId: input.organizationId,
    projectId: input.projectId,
    environmentId: input.environmentId,
    hostname: normalizeHostname(input.hostname),
  };
}

function fingerprint(input: DomainIdentity): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function activityKey(input: DomainRequest, suffix: string): string {
  return ActivityKeySchema.parse(`${input.operationKey}:${suffix}`);
}

function rowActivityKey(rowValue: DomainRow, suffix: string): string {
  return ActivityKeySchema.parse(`${rowValue.operationKey}:${suffix}`);
}

function routing(classification: HostnameClassification): z.infer<typeof DomainRoutingSchema> {
  const recommendation =
    classification.kind === 'apex'
      ? 'Use the displayed apex records. Add www separately and redirect one hostname to the other.'
      : classification.kind === 'www'
        ? 'Use the displayed www records. Add the apex separately and redirect one hostname to the other.'
        : 'This subdomain is independent. Add the displayed records; apex and www can be added separately.';
  return DomainRoutingSchema.parse({ ...classification, recommendation });
}

function failureDetail(cause: z.infer<typeof FailureCauseSchema>): string {
  switch (cause) {
    case 'wrong_record':
      return 'DNS records do not match the displayed values.';
    case 'caa':
      return 'CAA records do not allow the deployment provider to issue a certificate.';
    case 'rate_limit':
      return 'Domain verification is temporarily rate-limited. Try again later.';
  }
}

function publicResult(rowValue: DomainRow): DomainResult {
  return DomainResultSchema.parse({
    hostname: rowValue.hostname,
    environmentId: rowValue.environmentId,
    status: rowValue.status,
    dnsInstructions: rowValue.dnsInstructions,
    routing: rowValue.routing,
    ssl: {
      managed: true,
      status:
        rowValue.status === 'active'
          ? 'active'
          : rowValue.status === 'failed'
            ? 'failed'
            : 'pending',
    },
    ...(rowValue.detail === null ? {} : { detail: rowValue.detail }),
  });
}

function parseRow(value: unknown): DomainRow {
  const parsed = DomainRowSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainServiceError(
      'domain_store_invalid',
      500,
      'The domain store returned an invalid environment domain row.',
    );
  }
  return parsed.data;
}

function assertIdentity(expected: DomainIdentity, rowValue: DomainRow): void {
  if (
    rowValue.organizationId !== expected.organizationId ||
    rowValue.projectId !== expected.projectId ||
    rowValue.environmentId !== expected.environmentId ||
    rowValue.hostname !== expected.hostname
  ) {
    throw new DomainServiceError(
      'domain_store_invalid',
      500,
      'The domain store returned a row for a different environment or hostname.',
    );
  }
}

function parseProviderConfiguration(value: unknown): z.infer<typeof ProviderConfigurationSchema> {
  const parsed = ProviderConfigurationSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainServiceError(
      'domain_provider_invalid',
      502,
      'The deployment provider returned an invalid domain configuration.',
    );
  }
  if (parsed.data.status === 'failed' && parsed.data.failureCause === undefined) {
    throw new DomainServiceError(
      'domain_provider_invalid',
      502,
      'The deployment provider omitted the domain failure cause.',
    );
  }
  return parsed.data;
}

function transitionAllowed(from: DomainRow['status'], to: DomainRow['status']): boolean {
  if (from === to) return true;
  if (from === 'pending_dns') return to === 'verifying' || to === 'active' || to === 'failed';
  if (from === 'verifying') return to === 'active' || to === 'failed';
  return false;
}

export function createDomainService(dependencies: DomainDependencies): {
  configure(input: DomainRequest): Promise<DomainResult>;
  poll(input: DomainRequest): Promise<DomainResult>;
} {
  async function getRow(domainIdentity: DomainIdentity): Promise<DomainRow | undefined> {
    const value = await dependencies.store.get(domainIdentity);
    if (value === undefined || value === null) return undefined;
    const rowValue = parseRow(value);
    assertIdentity(domainIdentity, rowValue);
    return rowValue;
  }

  async function update(
    rowValue: DomainRow,
    input: Pick<DomainUpdate, 'status' | 'detail' | 'verificationAttempt'>,
  ): Promise<DomainRow> {
    if (!transitionAllowed(rowValue.status, input.status)) {
      throw new DomainServiceError(
        'domain_store_invalid',
        500,
        `Invalid domain status transition: ${rowValue.status} to ${input.status}.`,
      );
    }
    const stored = parseRow(
      await dependencies.store.update({
        organizationId: rowValue.organizationId,
        projectId: rowValue.projectId,
        environmentId: rowValue.environmentId,
        hostname: rowValue.hostname,
        expectedStatus: rowValue.status,
        expectedVerificationAttempt: rowValue.verificationAttempt,
        providerDomainReference: ProviderDomainReferenceSchema.parse(
          rowValue.providerDomainReference,
        ),
        status: input.status,
        dnsInstructions: rowValue.dnsInstructions,
        routing: rowValue.routing,
        detail: input.detail,
        verificationAttempt: input.verificationAttempt,
      }),
    );
    assertIdentity(rowValue, stored);
    return stored;
  }

  return {
    async configure(inputValue) {
      const input = DomainRequestSchema.parse(inputValue);
      const domainIdentity = identity(input);
      const existing = await getRow(domainIdentity);
      if (existing?.providerDomainReference !== null && existing !== undefined) {
        return publicResult(existing);
      }

      const context = EnvironmentContextSchema.parse(
        await dependencies.context.resolve(domainIdentity),
      );
      const classification = HostnameClassificationSchema.parse(
        await dependencies.dns.classify({ hostname: domainIdentity.hostname }),
      );
      const route = routing(classification);
      const requestFingerprint = fingerprint(domainIdentity);
      const claimed = parseRow(
        await dependencies.store.claim({
          ...domainIdentity,
          operationKey: input.operationKey,
          fingerprint: requestFingerprint,
          providerId: context.providerId,
          providerDomainReference: null,
          status: 'pending_dns',
          dnsInstructions: [],
          routing: route,
          detail: null,
          verificationAttempt: 0,
        }),
      );
      if (
        claimed.operationKey === input.operationKey &&
        claimed.fingerprint !== requestFingerprint
      ) {
        throw new DomainServiceError(
          'domain_conflict',
          409,
          'The idempotency key was already used for another domain request.',
        );
      }
      assertIdentity(domainIdentity, claimed);
      if (claimed.operationKey !== input.operationKey && claimed.providerDomainReference === null) {
        throw new DomainServiceError(
          'domain_conflict',
          409,
          'This hostname is already being configured by another operation.',
        );
      }
      if (claimed.providerDomainReference !== null) return publicResult(claimed);
      if (claimed.providerId !== context.providerId) {
        throw new DomainServiceError(
          'domain_store_invalid',
          500,
          'The claimed domain row does not match the environment deployment provider.',
        );
      }

      const configured = parseProviderConfiguration(
        await dependencies.provider.configure({
          idempotencyKey: activityKey(input, 'configure'),
          providerId: context.providerId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          hostname: domainIdentity.hostname,
        }),
      );
      const detail =
        configured.status === 'failed' && configured.failureCause !== undefined
          ? failureDetail(configured.failureCause)
          : null;
      const stored = parseRow(
        await dependencies.store.update({
          ...domainIdentity,
          expectedStatus: claimed.status,
          expectedVerificationAttempt: claimed.verificationAttempt,
          providerDomainReference: configured.providerDomainReference,
          status: configured.status,
          dnsInstructions: configured.dnsInstructions,
          routing: route,
          detail,
          verificationAttempt: 0,
        }),
      );
      assertIdentity(domainIdentity, stored);
      return publicResult(stored);
    },

    async poll(inputValue) {
      const input = DomainRequestSchema.parse(inputValue);
      const domainIdentity = identity(input);
      let rowValue = await getRow(domainIdentity);
      if (rowValue === undefined || rowValue.providerDomainReference === null) {
        throw new DomainServiceError('domain_not_found', 404, 'Domain not found.');
      }
      if (rowValue.status === 'active' || rowValue.status === 'failed') {
        return publicResult(rowValue);
      }

      const inspection = DnsInspectionSchema.parse(
        await dependencies.dns.inspect({
          idempotencyKey: rowActivityKey(
            rowValue,
            `dns:${rowValue.verificationAttempt.toString()}`,
          ),
          hostname: rowValue.hostname,
          instructions: rowValue.dnsInstructions,
        }),
      );
      if (inspection.state === 'pending') return publicResult(rowValue);
      if (inspection.state === 'wrong_record' || inspection.state === 'caa_blocked') {
        rowValue = await update(rowValue, {
          status: 'failed',
          detail: failureDetail(inspection.state === 'wrong_record' ? 'wrong_record' : 'caa'),
          verificationAttempt: rowValue.verificationAttempt + 1,
        });
        return publicResult(rowValue);
      }

      const nextAttempt = rowValue.verificationAttempt + 1;
      if (rowValue.status === 'pending_dns') {
        rowValue = await update(rowValue, {
          status: 'verifying',
          detail: null,
          verificationAttempt: nextAttempt,
        });
      }
      const provider = ProviderVerificationSchema.parse(
        await dependencies.provider.verify({
          idempotencyKey: rowActivityKey(rowValue, `verify:${nextAttempt.toString()}`),
          providerId: rowValue.providerId,
          providerDomainReference: ProviderDomainReferenceSchema.parse(
            rowValue.providerDomainReference,
          ),
          projectId: rowValue.projectId,
          environmentId: rowValue.environmentId,
          hostname: rowValue.hostname,
        }),
      );
      rowValue = await update(rowValue, {
        status: provider.status,
        detail:
          provider.status === 'failed' && provider.failureCause !== undefined
            ? failureDetail(provider.failureCause)
            : null,
        verificationAttempt: nextAttempt,
      });
      return publicResult(rowValue);
    },
  };
}
