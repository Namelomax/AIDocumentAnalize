import { describe, it, expect, afterAll } from 'vitest';
import amqp from 'amqplib';
import { publishTask, closeQueue, TASK_QUEUE } from '../src/queue.js';
import { config } from '../src/config.js';

afterAll(async () => { await closeQueue(); });

// Vitest runs test files in parallel and they share one test queue, so this
// asserts that our own message is present rather than that the queue holds
// nothing else. Reading a single message would pick up another file's task.
async function drainQueue(): Promise<unknown[]> {
  const connection = await amqp.connect(config.rabbitmqUrl);
  const channel = await connection.createChannel();
  await channel.assertQueue(TASK_QUEUE, { durable: true });
  const messages: unknown[] = [];
  for (;;) {
    const message = await channel.get(TASK_QUEUE, { noAck: true });
    if (!message) break;
    messages.push(JSON.parse(message.content.toString()));
  }
  await channel.close();
  await connection.close();
  return messages;
}

describe('queue', () => {
  it('publishes a flat json task that can be read back', async () => {
    const processId = crypto.randomUUID();
    await publishTask({ type: 'process.start', process_id: processId, object_id: 'obj-1' });

    const messages = await drainQueue();

    expect(messages).toContainEqual({
      type: 'process.start',
      process_id: processId,
      object_id: 'obj-1',
    });
  });
});
