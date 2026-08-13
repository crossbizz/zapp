import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { z } from 'zod';

import {
  NotificationTriggerSchema,
  type NotificationEmailPort,
  type NotificationFanoutPort,
  type NotificationQueuePort,
} from './service.js';

const ReceivedMessageSchema = z
  .object({ body: z.string().min(1), receiptHandle: z.string().min(1) })
  .strict();

export interface NotificationAwsConfig {
  readonly region: string;
  readonly endpoint?: string;
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  readonly queueName: string;
}

type AwsClientConfig = Omit<NotificationAwsConfig, 'queueName'>;

function clientConfig(config: AwsClientConfig) {
  return {
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.accessKeyId === undefined
      ? {}
      : {
          credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey ?? '',
          },
        }),
  };
}

export function createSqsNotificationQueue(config: NotificationAwsConfig): NotificationQueuePort {
  const client = new SQSClient(clientConfig(config));
  let resolvedQueueUrl: Promise<string> | undefined;
  function queueUrl(): Promise<string> {
    resolvedQueueUrl ??= client
      .send(new GetQueueUrlCommand({ QueueName: config.queueName }))
      .then((response) => {
        if (response.QueueUrl === undefined) {
          throw new Error('notification queue URL was not returned');
        }
        return response.QueueUrl;
      });
    return resolvedQueueUrl;
  }
  return {
    async send(body) {
      await client.send(new SendMessageCommand({ QueueUrl: await queueUrl(), MessageBody: body }));
    },
    async receive(input) {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: await queueUrl(),
          MaxNumberOfMessages: Math.max(1, Math.min(10, Math.floor(input.maxMessages))),
          WaitTimeSeconds: Math.max(0, Math.min(20, Math.floor(input.waitTimeSeconds))),
          VisibilityTimeout: Math.max(0, Math.floor(input.visibilityTimeoutSeconds)),
        }),
      );
      return (response.Messages ?? []).map((message) =>
        ReceivedMessageSchema.parse({
          body: message.Body,
          receiptHandle: message.ReceiptHandle,
        }),
      );
    },
    async delete(receiptHandle) {
      await client.send(
        new DeleteMessageCommand({ QueueUrl: await queueUrl(), ReceiptHandle: receiptHandle }),
      );
    },
    close() {
      client.destroy();
    },
  };
}

export function createSesEmailSender(
  config: AwsClientConfig & { readonly source: string },
): NotificationEmailPort & { close(): void } {
  const client = new SESClient(clientConfig(config));
  const source = z.string().email().parse(config.source);
  return {
    async send(message) {
      const response = await client.send(
        new SendEmailCommand({
          Source: source,
          Destination: { ToAddresses: [z.string().email().parse(message.to)] },
          Message: {
            Subject: { Charset: 'UTF-8', Data: z.string().min(1).max(200).parse(message.subject) },
            Body: { Text: { Charset: 'UTF-8', Data: z.string().min(1).parse(message.text) } },
          },
        }),
      );
      if (response.MessageId === undefined) throw new Error('SES did not return a message id');
      return { messageId: response.MessageId };
    },
    close() {
      client.destroy();
    },
  };
}

export function createSnsNotificationFanout(
  config: AwsClientConfig & { readonly topicArn: string },
): NotificationFanoutPort & { close(): void } {
  const client = new SNSClient(clientConfig(config));
  const topicArn = z
    .string()
    .regex(/^arn:[^:]+:sns:[^:]+:[^:]+:[^:]+$/u)
    .parse(config.topicArn);
  return {
    async publish(value) {
      const trigger = NotificationTriggerSchema.parse(value);
      await client.send(
        new PublishCommand({
          TopicArn: topicArn,
          Message: JSON.stringify(trigger),
          MessageAttributes: {
            notification_type: { DataType: 'String', StringValue: trigger.type },
            organization_id: { DataType: 'String', StringValue: trigger.organizationId },
          },
        }),
      );
    },
    close() {
      client.destroy();
    },
  };
}
