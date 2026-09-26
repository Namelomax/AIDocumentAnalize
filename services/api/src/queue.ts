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

// Written by hand rather than through the Fastify logger: this module has no
// request to hang a logger off, and a broker failure still has to come out in
// the one log shape the whole solution uses. A bare plain-text line would be
// unparseable for whoever reads the stand's logs without us.
function logQueueError(message: string, err: unknown): void {
  process.stderr.write(JSON.stringify({
    level: 'ERROR',
    timestamp: new Date().toISOString(),
    service: 'api',
    request_id: null,
    user_id: null,
    message,
    err: err instanceof Error ? { type: err.name, message: err.message } : String(err),
  }) + '\n');
}

// A broker restart or network blip leaves connection/channel dead. Without
// these listeners the 'error' event (unhandled on an EventEmitter) would
// crash the whole process, and without resetting the module state every
// publish after that point would keep failing against a closed channel
// until the API itself was restarted.
function forgetConnection(): void {
  connection = null;
  channel = null;
}

async function getChannel(): Promise<Channel> {
  if (channel) return channel;
  const openConnection = await amqp.connect(config.rabbitmqUrl);
  openConnection.on('error', (err) => {
    logQueueError('rabbitmq connection error', err);
    forgetConnection();
  });
  openConnection.on('close', forgetConnection);

  const openChannel = await openConnection.createChannel();
  openChannel.on('error', (err) => {
    logQueueError('rabbitmq channel error', err);
    forgetConnection();
  });
  openChannel.on('close', forgetConnection);
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
  // Closing the channel fires its 'close' listener, which nulls out the
  // module state before we get to closing the connection below - capture
  // both locally first so the connection actually gets closed.
  const openChannel = channel;
  const openConnection = connection;
  await openChannel?.close();
  await openConnection?.close();
  channel = null;
  connection = null;
}
