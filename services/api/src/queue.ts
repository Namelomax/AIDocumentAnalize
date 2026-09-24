import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { config } from './config.js';

// The queue name is configurable so the test suite can use its own: with the
// worker container running it consumes from the real queue within
// milliseconds, and a test reading the same queue finds it already empty.
export const TASK_QUEUE = config.taskQueue;

// amqplib's connect resolves to a ChannelModel, not a Connection: the latter
// has no createChannel and typing it that way only compiles until tsc runs.
let connection: ChannelModel | null = null;
let channel: Channel | null = null;

async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  const openConnection = await amqp.connect(config.rabbitmqUrl);
  const openChannel = await openConnection.createChannel();
  await openChannel.assertQueue(TASK_QUEUE, { durable: true });
  connection = openConnection;
  channel = openChannel;
  return openChannel;
}

export interface Task {
  type: string;
  process_id: string;
  object_id: string;
  [key: string]: unknown;
}

export async function publishTask(task: Task): Promise<void> {
  const ch = await getChannel();
  ch.sendToQueue(TASK_QUEUE, Buffer.from(JSON.stringify(task)), {
    persistent: true,
    contentType: 'application/json',
  });
}

export async function closeQueue(): Promise<void> {
  await channel?.close();
  await connection?.close();
  channel = null;
  connection = null;
}
