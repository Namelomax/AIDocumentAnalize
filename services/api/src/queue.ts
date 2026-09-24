import amqp, { type Channel, type Connection } from 'amqplib';
import { config } from './config.js';

export const TASK_QUEUE = 'inspector.tasks';

let connection: Connection | null = null;
let channel: Channel | null = null;

async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  connection = await amqp.connect(config.rabbitmqUrl);
  channel = await connection.createChannel();
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  return channel;
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
