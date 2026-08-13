import { createHash, randomUUID } from 'node:crypto';

import { AgentEventSchema, idSchema, type AgentEvent } from '@zapp/contracts';
import { createObservabilityInstruments } from '@zapp/config';
import { memberships, users, type Database } from '@zapp/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { AppInstance } from '../app.js';
import { actorOf } from '../plugins/auth.js';
import { tenantOf } from '../plugins/tenant.js';
import type { RedisCommands, RedisPublisher } from '../redis/client.js';
import { renderNotification } from './templates.js';

export const NOTIFICATION_TYPES = [
  'approval_requested',
  'run_completed',
  'run_failed',
  'budget_50',
  'budget_80',
  'budget_100',
  'synthetic_check_failed',
  'production_incident',
  'deploy_succeeded',
  'deploy_failed',
  'payment_failed',
  'member_invited',
] as const;

export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES);
export type NotificationType = z.infer<typeof NotificationTypeSchema>;

const NotificationAudienceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('organization'),
      roles: z
        .array(z.enum(['owner', 'builder', 'viewer']))
        .min(1)
        .max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal('recipient'),
      userId: idSchema('user').optional(),
      email: z.string().email(),
    })
    .strict(),
]);

const ContextValueSchema = z.union([
  z.string().max(4_096),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const NotificationTriggerSchema = z
  .object({
    triggerId: z.string().trim().min(1).max(512),
    type: NotificationTypeSchema,
    organizationId: idSchema('org'),
    projectId: idSchema('proj').optional(),
    runId: idSchema('run').optional(),
    occurredAt: z.string().datetime({ offset: true }),
    audience: NotificationAudienceSchema,
    context: z.record(ContextValueSchema),
  })
  .strict();

export type NotificationTrigger = z.infer<typeof NotificationTriggerSchema>;

export interface NotificationQueueReceivedMessage {
  readonly body: string;
  readonly receiptHandle: string;
}

export interface NotificationQueuePort {
  send(body: string): Promise<void>;
  receive(input: {
    readonly maxMessages: number;
    readonly waitTimeSeconds: number;
    readonly visibilityTimeoutSeconds: number;
  }): Promise<readonly NotificationQueueReceivedMessage[]>;
  delete(receiptHandle: string): Promise<void>;
  close?(): void;
}

export interface NotificationRecipient {
  readonly userId?: string;
  readonly email: string;
}

export interface NotificationDirectoryPort {
  resolve(trigger: NotificationTrigger): Promise<readonly NotificationRecipient[]>;
}

export interface NotificationPreference {
  readonly organizationId: string;
  readonly userId: string;
  readonly type: NotificationType;
  readonly email: boolean;
  readonly inApp: boolean;
  readonly desktopPush: boolean;
}

export const NotificationPreferenceSchema = z
  .object({
    organizationId: idSchema('org'),
    userId: idSchema('user'),
    type: NotificationTypeSchema,
    email: z.boolean(),
    inApp: z.boolean(),
    desktopPush: z.boolean(),
  })
  .strict();

export interface NotificationStatePort {
  preference(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly type: NotificationType;
  }): Promise<NotificationPreference>;
  setPreference(preference: NotificationPreference): Promise<void>;
  claimDelivery(input: {
    readonly key: string;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<string | undefined>;
  completeDelivery(key: string, claim: string): Promise<void>;
  releaseDelivery(key: string, claim: string): Promise<void>;
  claimEmailWindow(input: {
    readonly key: string;
    readonly now: Date;
    readonly leaseMs: number;
  }): Promise<string | undefined>;
  releaseEmailWindow(key: string, claim: string): Promise<void>;
  appendProjection(projection: NotificationProjection): Promise<number>;
  listProjections(input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly after: number;
    readonly limit: number;
  }): Promise<readonly DesktopNotification[]>;
}

export interface NotificationEmailPort {
  send(message: {
    readonly to: string;
    readonly subject: string;
    readonly text: string;
  }): Promise<{ readonly messageId: string }>;
}

export interface NotificationProjection {
  readonly channel: 'in_app' | 'desktop_push';
  readonly triggerId: string;
  readonly type: NotificationType;
  readonly organizationId: string;
  readonly userId: string;
  readonly occurredAt: string;
  readonly subject: string;
  readonly text: string;
  readonly webUrl: string;
  readonly desktopUrl: string;
}

export const NotificationProjectionSchema = z
  .object({
    channel: z.enum(['in_app', 'desktop_push']),
    triggerId: z.string().trim().min(1).max(512),
    type: NotificationTypeSchema,
    organizationId: idSchema('org'),
    userId: idSchema('user'),
    occurredAt: z.string().datetime({ offset: true }),
    subject: z.string().min(1).max(200),
    text: z.string().min(1),
    webUrl: z.string().url(),
    desktopUrl: z.string().url(),
  })
  .strict();

export const DesktopNotificationSchema = NotificationProjectionSchema.extend({
  cursor: z.number().int().positive(),
}).strict();
export type DesktopNotification = z.infer<typeof DesktopNotificationSchema>;

export interface NotificationProjectionPort {
  publish(projection: NotificationProjection): Promise<void>;
}

export interface NotificationFanoutPort {
  publish(trigger: NotificationTrigger): Promise<void>;
}

interface MemoryClaim {
  state: 'claimed' | 'completed';
  expiresAt: number;
  token: string;
}

export function createInMemoryNotificationState(): NotificationStatePort & {
  preferences(): readonly NotificationPreference[];
} {
  const preferences = new Map<string, NotificationPreference>();
  const deliveries = new Map<string, MemoryClaim>();
  const windows = new Map<string, { readonly expiresAt: number; readonly token: string }>();
  const projections = new Map<string, DesktopNotification[]>();
  const preferenceKey = (input: {
    readonly organizationId: string;
    readonly userId: string;
    readonly type: NotificationType;
  }): string => `${input.organizationId}:${input.userId}:${input.type}`;
  return {
    preference(input) {
      return Promise.resolve(
        preferences.get(preferenceKey(input)) ?? {
          ...input,
          email: true,
          inApp: true,
          desktopPush: true,
        },
      );
    },
    setPreference(preference) {
      const parsed: NotificationPreference = {
        organizationId: idSchema('org').parse(preference.organizationId),
        userId: idSchema('user').parse(preference.userId),
        type: NotificationTypeSchema.parse(preference.type),
        email: z.boolean().parse(preference.email),
        inApp: z.boolean().parse(preference.inApp),
        desktopPush: z.boolean().parse(preference.desktopPush),
      };
      preferences.set(preferenceKey(parsed), parsed);
      return Promise.resolve();
    },
    claimDelivery(input) {
      const existing = deliveries.get(input.key);
      if (existing?.state === 'completed') return Promise.resolve(undefined);
      if (existing !== undefined && existing.expiresAt > input.now.getTime()) {
        return Promise.resolve(undefined);
      }
      const token = randomUUID();
      deliveries.set(input.key, {
        state: 'claimed',
        expiresAt: input.now.getTime() + input.leaseMs,
        token,
      });
      return Promise.resolve(token);
    },
    completeDelivery(key, claim) {
      if (deliveries.get(key)?.token !== claim) throw new Error('notification delivery claim lost');
      deliveries.set(key, {
        state: 'completed',
        expiresAt: Number.MAX_SAFE_INTEGER,
        token: claim,
      });
      return Promise.resolve();
    },
    releaseDelivery(key, claim) {
      const current = deliveries.get(key);
      if (current?.state === 'claimed' && current.token === claim) deliveries.delete(key);
      return Promise.resolve();
    },
    claimEmailWindow(input) {
      const current = windows.get(input.key);
      if ((current?.expiresAt ?? 0) > input.now.getTime()) return Promise.resolve(undefined);
      const token = randomUUID();
      windows.set(input.key, { expiresAt: input.now.getTime() + input.leaseMs, token });
      return Promise.resolve(token);
    },
    releaseEmailWindow(key, claim) {
      if (windows.get(key)?.token === claim) windows.delete(key);
      return Promise.resolve();
    },
    appendProjection(value) {
      const projection = NotificationProjectionSchema.parse(value);
      const key = `${projection.organizationId}:${projection.userId}`;
      const current = projections.get(key) ?? [];
      const existing = current.find(
        (item) => item.channel === projection.channel && item.triggerId === projection.triggerId,
      );
      if (existing !== undefined) return Promise.resolve(existing.cursor);
      const cursor = (current.at(-1)?.cursor ?? 0) + 1;
      projections.set(key, [...current, { ...projection, cursor }].slice(-1_000));
      return Promise.resolve(cursor);
    },
    listProjections(input) {
      const key = `${input.organizationId}:${input.userId}`;
      return Promise.resolve(
        (projections.get(key) ?? [])
          .filter((item) => item.cursor > input.after)
          .slice(0, input.limit),
      );
    },
    preferences: () => [...preferences.values()],
  };
}

function recipientKey(recipient: NotificationRecipient): string {
  return (
    recipient.userId ?? createHash('sha256').update(recipient.email.toLowerCase()).digest('hex')
  );
}

function deliveryKey(
  trigger: NotificationTrigger,
  recipient: NotificationRecipient,
  channel: 'email' | 'in_app' | 'desktop_push',
): string {
  return `${trigger.triggerId}:${recipientKey(recipient)}:${channel}`;
}

export function createNotificationProducer(input: {
  readonly queue: Pick<NotificationQueuePort, 'send'>;
}) {
  return {
    async enqueue(value: NotificationTrigger): Promise<void> {
      const trigger = NotificationTriggerSchema.parse(value);
      await input.queue.send(JSON.stringify(trigger));
    },
  };
}

const DELIVERY_LEASE_MS = 60_000;
const EMAIL_BATCH_WINDOW_MS = 15 * 60_000;
const notificationInstruments = createObservabilityInstruments();

export function createNotificationWorker(options: {
  readonly queue: NotificationQueuePort;
  readonly state: NotificationStatePort;
  readonly directory: NotificationDirectoryPort;
  readonly email: NotificationEmailPort;
  readonly projections: NotificationProjectionPort;
  readonly fanout?: NotificationFanoutPort;
  readonly webBaseUrl: URL;
  readonly now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());

  async function deliverProjection(
    trigger: NotificationTrigger,
    recipient: NotificationRecipient,
    channel: 'in_app' | 'desktop_push',
    rendered: ReturnType<typeof renderNotification>,
  ): Promise<void> {
    if (recipient.userId === undefined) return;
    const key = deliveryKey(trigger, recipient, channel);
    const instant = now();
    const claim = await options.state.claimDelivery({
      key,
      now: instant,
      leaseMs: DELIVERY_LEASE_MS,
    });
    if (claim === undefined) return;
    try {
      await options.projections.publish({
        channel,
        triggerId: trigger.triggerId,
        type: trigger.type,
        organizationId: trigger.organizationId,
        userId: recipient.userId,
        occurredAt: trigger.occurredAt,
        ...rendered,
      });
      await options.state.completeDelivery(key, claim);
    } catch (error) {
      await options.state.releaseDelivery(key, claim);
      throw error;
    }
  }

  async function deliverEmail(
    trigger: NotificationTrigger,
    recipient: NotificationRecipient,
    rendered: ReturnType<typeof renderNotification>,
  ): Promise<void> {
    const key = deliveryKey(trigger, recipient, 'email');
    const instant = now();
    const claim = await options.state.claimDelivery({
      key,
      now: instant,
      leaseMs: DELIVERY_LEASE_MS,
    });
    if (claim === undefined) return;
    const windowKey = `${trigger.organizationId}:${recipientKey(recipient)}:${trigger.type}`;
    const windowClaim = await options.state.claimEmailWindow({
      key: windowKey,
      now: instant,
      leaseMs: EMAIL_BATCH_WINDOW_MS,
    });
    if (windowClaim === undefined) {
      await options.state.completeDelivery(key, claim);
      return;
    }
    try {
      await options.email.send({
        to: z.string().email().parse(recipient.email),
        subject: rendered.subject,
        text: rendered.text,
      });
      await options.state.completeDelivery(key, claim);
    } catch (error) {
      await Promise.all([
        options.state.releaseEmailWindow(windowKey, windowClaim),
        options.state.releaseDelivery(key, claim),
      ]);
      throw error;
    }
  }

  return {
    async processOnce(): Promise<number> {
      const messages = await options.queue.receive({
        maxMessages: 10,
        waitTimeSeconds: 1,
        visibilityTimeoutSeconds: 30,
      });
      let processed = 0;
      for (const message of messages) {
        const trigger = NotificationTriggerSchema.parse(JSON.parse(message.body) as unknown);
        notificationInstruments.record(
          'queueDelay',
          Math.max(0, now().getTime() - Date.parse(trigger.occurredAt)),
          {
            queue: 'notifications',
            'zapp.organization.id': trigger.organizationId,
            ...(trigger.projectId === undefined ? {} : { 'zapp.project.id': trigger.projectId }),
            ...(trigger.runId === undefined ? {} : { 'zapp.run.id': trigger.runId }),
          },
        );
        if (
          options.fanout !== undefined &&
          (trigger.type === 'deploy_succeeded' || trigger.type === 'deploy_failed')
        ) {
          const fanoutKey = `${trigger.triggerId}:sns`;
          const fanoutClaim = await options.state.claimDelivery({
            key: fanoutKey,
            now: now(),
            leaseMs: DELIVERY_LEASE_MS,
          });
          if (fanoutClaim !== undefined) {
            try {
              await options.fanout.publish(trigger);
              await options.state.completeDelivery(fanoutKey, fanoutClaim);
            } catch (error) {
              await options.state.releaseDelivery(fanoutKey, fanoutClaim);
              throw error;
            }
          }
        }
        const recipients = await options.directory.resolve(trigger);
        const rendered = renderNotification(trigger, options.webBaseUrl);
        for (const recipient of recipients) {
          const preference =
            recipient.userId === undefined
              ? {
                  organizationId: trigger.organizationId,
                  userId: '',
                  type: trigger.type,
                  email: true,
                  inApp: false,
                  desktopPush: false,
                }
              : await options.state.preference({
                  organizationId: trigger.organizationId,
                  userId: recipient.userId,
                  type: trigger.type,
                });
          if (preference.email) await deliverEmail(trigger, recipient, rendered);
          if (preference.inApp) await deliverProjection(trigger, recipient, 'in_app', rendered);
          if (preference.desktopPush) {
            await deliverProjection(trigger, recipient, 'desktop_push', rendered);
          }
        }
        await options.queue.delete(message.receiptHandle);
        processed += 1;
      }
      return processed;
    },
  };
}

export function projectAgentEventNotification(value: AgentEvent): NotificationTrigger | undefined {
  const event = AgentEventSchema.parse(value);
  let type: NotificationType | undefined;
  if (event.type === 'approval.requested') type = 'approval_requested';
  if (event.type === 'run.completed') {
    type = event.payload['status'] === 'failed' ? 'run_failed' : 'run_completed';
  }
  if (event.type === 'deployment.updated') {
    if (event.payload['status'] === 'failed') type = 'deploy_failed';
    if (event.payload['stage'] === 'go_live' && event.payload['status'] === 'passed') {
      type = 'deploy_succeeded';
    }
  }
  if (type === undefined) return undefined;
  return NotificationTriggerSchema.parse({
    triggerId: event.id,
    type,
    organizationId: event.organizationId,
    projectId: event.projectId,
    runId: event.runId,
    occurredAt: event.occurredAt,
    audience: {
      kind: 'organization',
      roles: type === 'approval_requested' ? ['owner', 'builder'] : ['owner', 'builder', 'viewer'],
    },
    context: {},
  });
}

export function usageAlertNotification(input: {
  readonly organizationId: string;
  readonly runId: string;
  readonly threshold: 50 | 80 | 100;
  readonly occurredAt: string;
}): NotificationTrigger {
  return NotificationTriggerSchema.parse({
    triggerId: `budget:${input.runId}:${String(input.threshold)}`,
    type: `budget_${String(input.threshold)}`,
    organizationId: input.organizationId,
    runId: input.runId,
    occurredAt: input.occurredAt,
    audience: { kind: 'organization', roles: ['owner', 'builder'] },
    context: { threshold: input.threshold },
  });
}

export function externalNotification(input: NotificationTrigger): NotificationTrigger {
  return NotificationTriggerSchema.parse(input);
}

export function paymentFailedNotification(input: {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly occurredAt: string;
}): NotificationTrigger {
  return NotificationTriggerSchema.parse({
    triggerId: `payment:${input.invoiceId}:failed`,
    type: 'payment_failed',
    organizationId: input.organizationId,
    occurredAt: input.occurredAt,
    audience: { kind: 'organization', roles: ['owner'] },
    context: { invoiceId: input.invoiceId },
  });
}

export function memberInvitedNotification(input: {
  readonly organizationId: string;
  readonly email: string;
  readonly inviteId: string;
  readonly inviteUrl: string;
  readonly occurredAt: string;
}): NotificationTrigger {
  return NotificationTriggerSchema.parse({
    triggerId: `invite:${input.inviteId}`,
    type: 'member_invited',
    organizationId: input.organizationId,
    occurredAt: input.occurredAt,
    audience: { kind: 'recipient', email: input.email },
    context: { inviteUrl: input.inviteUrl },
  });
}

export function syntheticCheckNotification(input: {
  readonly organizationId: string;
  readonly projectId: string;
  readonly syntheticCheckId: string;
  readonly operationKey: string;
  readonly occurredAt: string;
}): NotificationTrigger {
  return NotificationTriggerSchema.parse({
    triggerId: `synthetic:${input.syntheticCheckId}:${input.operationKey}`,
    type: 'synthetic_check_failed',
    organizationId: input.organizationId,
    projectId: input.projectId,
    occurredAt: input.occurredAt,
    audience: { kind: 'organization', roles: ['owner', 'builder'] },
    context: { syntheticCheckId: input.syntheticCheckId },
  });
}

const REDIS_NOTIFICATION_PREFIX = 'notification';
const COMPLETED_DELIVERY_TTL_MS = 15 * 24 * 60 * 60 * 1_000;
const SET_PREFERENCE = `
  redis.call('SET', KEYS[1], ARGV[1])
  return 1
`;
const COMPLETE_CLAIM = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  redis.call('SET', KEYS[1], 'completed', 'PX', ARGV[2])
  return 1
`;
const RELEASE_CLAIM = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('DEL', KEYS[1])
`;
const APPEND_PROJECTION = `
  local items = {}
  local current = redis.call('GET', KEYS[1])
  if current then items = cjson.decode(current) end
  local projection = cjson.decode(ARGV[1])
  for _, item in ipairs(items) do
    if item.channel == projection.channel and item.triggerId == projection.triggerId then
      return item.cursor
    end
  end
  local cursor = 1
  if #items > 0 then cursor = items[#items].cursor + 1 end
  projection.cursor = cursor
  table.insert(items, projection)
  while #items > 1000 do table.remove(items, 1) end
  redis.call('SET', KEYS[1], cjson.encode(items), 'PX', ARGV[2])
  return cursor
`;
const PROJECTION_TTL_MS = 15 * 24 * 60 * 60 * 1_000;

function preferenceRedisKey(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly type: NotificationType;
}): string {
  return `${REDIS_NOTIFICATION_PREFIX}:preference:${input.organizationId}:${input.userId}:${input.type}`;
}

function projectionRedisKey(input: { organizationId: string; userId: string }): string {
  return `${REDIS_NOTIFICATION_PREFIX}:projection:${input.organizationId}:${input.userId}`;
}

/** Upstash/Redis implementation shared by every control-api replica. */
export function createRedisNotificationState(redis: RedisCommands): NotificationStatePort {
  const deliveryKey = (key: string): string => `${REDIS_NOTIFICATION_PREFIX}:delivery:${key}`;
  const windowKey = (key: string): string => `${REDIS_NOTIFICATION_PREFIX}:email-window:${key}`;

  async function claim(key: string, ttlMs: number): Promise<string | undefined> {
    const token = randomUUID();
    return (await redis.setIfAbsent(key, token, ttlMs)) ? token : undefined;
  }

  async function release(key: string, token: string): Promise<void> {
    await redis.eval(RELEASE_CLAIM, [key], [token]);
  }

  return {
    async preference(input) {
      const parsedInput = NotificationPreferenceSchema.pick({
        organizationId: true,
        userId: true,
        type: true,
      }).parse(input);
      const stored = await redis.get(preferenceRedisKey(parsedInput));
      if (stored === null) {
        return { ...parsedInput, email: true, inApp: true, desktopPush: true };
      }
      return NotificationPreferenceSchema.parse(JSON.parse(stored) as unknown);
    },
    async setPreference(value) {
      const preference = NotificationPreferenceSchema.parse(value);
      await redis.eval(
        SET_PREFERENCE,
        [preferenceRedisKey(preference)],
        [JSON.stringify(preference)],
      );
    },
    claimDelivery(input) {
      return claim(deliveryKey(input.key), input.leaseMs);
    },
    async completeDelivery(key, token) {
      const completed = await redis.eval(
        COMPLETE_CLAIM,
        [deliveryKey(key)],
        [token, COMPLETED_DELIVERY_TTL_MS],
      );
      if (Number(completed) !== 1) throw new Error('notification delivery claim lost');
    },
    releaseDelivery(key, token) {
      return release(deliveryKey(key), token);
    },
    claimEmailWindow(input) {
      return claim(windowKey(input.key), input.leaseMs);
    },
    releaseEmailWindow(key, token) {
      return release(windowKey(key), token);
    },
    async appendProjection(value) {
      const projection = NotificationProjectionSchema.parse(value);
      return Number(
        await redis.eval(
          APPEND_PROJECTION,
          [projectionRedisKey(projection)],
          [JSON.stringify(projection), PROJECTION_TTL_MS],
        ),
      );
    },
    async listProjections(input) {
      const stored = await redis.get(projectionRedisKey(input));
      if (stored === null) return [];
      return z
        .array(DesktopNotificationSchema)
        .parse(JSON.parse(stored) as unknown)
        .filter((item) => item.cursor > input.after)
        .slice(0, input.limit);
    },
  };
}

/** Resolves active organization members at delivery time, so removed users receive nothing. */
export function createDatabaseNotificationDirectory(database: Database): NotificationDirectoryPort {
  return {
    async resolve(value) {
      const trigger = NotificationTriggerSchema.parse(value);
      if (trigger.audience.kind === 'recipient') {
        if (trigger.audience.userId === undefined) return [{ email: trigger.audience.email }];
        const [recipient] = await database
          .select({ userId: users.id, email: users.email })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organizationId, trigger.organizationId),
              eq(memberships.userId, trigger.audience.userId),
              eq(memberships.status, 'active'),
            ),
          );
        return recipient === undefined ? [] : [recipient];
      }
      return await database
        .select({ userId: users.id, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, trigger.organizationId),
            eq(memberships.status, 'active'),
            inArray(memberships.role, trigger.audience.roles),
          ),
        )
        .orderBy(asc(users.id));
    },
  };
}

/** Emits the delivery projection MAC-11 and the web in-app client consume. */
export function createRedisNotificationProjection(
  redis: RedisPublisher,
  state?: Pick<NotificationStatePort, 'appendProjection'>,
): NotificationProjectionPort {
  return {
    async publish(value) {
      const projection = NotificationProjectionSchema.parse(value);
      if (projection.channel === 'desktop_push') await state?.appendProjection(projection);
      await redis.publish(
        `${REDIS_NOTIFICATION_PREFIX}:events:${projection.organizationId}:${projection.userId}`,
        JSON.stringify(projection),
      );
    },
  };
}

const PreferenceChannelsSchema = z
  .object({ email: z.boolean(), inApp: z.boolean(), desktopPush: z.boolean() })
  .strict();
const PreferenceParamsSchema = z.object({ type: NotificationTypeSchema }).strict();
const PreferenceListResponseSchema = z
  .object({ preferences: z.array(NotificationPreferenceSchema).length(NOTIFICATION_TYPES.length) })
  .strict();
const PreferenceResponseSchema = z.object({ preference: NotificationPreferenceSchema }).strict();
const DesktopNotificationQuerySchema = z
  .object({
    deviceId: z.string().trim().min(1).max(128),
    after: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
const DesktopNotificationResponseSchema = z
  .object({
    notifications: z.array(DesktopNotificationSchema).max(100),
    nextCursor: z.number().int().nonnegative(),
    reconnectAfterMs: z.number().int().min(500).max(30_000),
  })
  .strict();

/** Versioned public API for the per-user part of notification delivery. */
export function registerNotificationRoutes(app: AppInstance, state: NotificationStatePort): void {
  app.get(
    '/v1/desktop-notifications',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: {
        querystring: DesktopNotificationQuerySchema,
        response: { 200: DesktopNotificationResponseSchema },
      },
    },
    async (request) => {
      const organizationId = tenantOf(request).organizationId;
      const userId = actorOf(request);
      const notifications = [
        ...(await state.listProjections({
          organizationId,
          userId,
          after: request.query.after,
          limit: request.query.limit,
        })),
      ];
      return {
        notifications,
        nextCursor: notifications.at(-1)?.cursor ?? request.query.after,
        reconnectAfterMs: 1_000,
      };
    },
  );

  app.get(
    '/v1/notification-preferences',
    {
      preHandler: [app.requireSession, app.requireTenant],
      schema: { response: { 200: PreferenceListResponseSchema } },
    },
    async (request) => {
      const organizationId = tenantOf(request).organizationId;
      const userId = actorOf(request);
      return {
        preferences: await Promise.all(
          NOTIFICATION_TYPES.map((type) => state.preference({ organizationId, userId, type })),
        ),
      };
    },
  );

  app.put(
    '/v1/notification-preferences/:type',
    {
      preHandler: [app.requireSession, app.requireCsrf, app.requireTenant],
      schema: {
        params: PreferenceParamsSchema,
        body: PreferenceChannelsSchema,
        response: { 200: PreferenceResponseSchema },
      },
    },
    async (request) => {
      const preference = NotificationPreferenceSchema.parse({
        organizationId: tenantOf(request).organizationId,
        userId: actorOf(request),
        type: request.params.type,
        ...request.body,
      });
      await state.setPreference(preference);
      return { preference };
    },
  );
}

export interface NotificationWorkerLifecycle {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Single-flight queue polling with a drained shutdown. */
export function createNotificationWorkerLifecycle(options: {
  readonly worker: { processOnce(): Promise<number> };
  readonly intervalMs?: number;
  readonly onError?: (error: Error) => void;
}): NotificationWorkerLifecycle {
  let interval: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;
  let closed = false;

  function poll(): void {
    if (closed || active !== undefined) return;
    active = options.worker
      .processOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        active = undefined;
      });
  }

  return {
    async start() {
      if (closed) throw new Error('notification worker lifecycle is closed');
      await options.worker.processOnce();
      interval = setInterval(poll, options.intervalMs ?? 1_000);
    },
    async close() {
      closed = true;
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
      await active;
    },
  };
}
