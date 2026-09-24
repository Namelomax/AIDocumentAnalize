import { describe, it, expect, afterAll } from 'vitest';
import amqp from 'amqplib';
import { publishTask, closeQueue, TASK_QUEUE } from '../src/queue.js';
import { config } from '../src/config.js';

afterAll(async () => { await closeQueue(); });

describe('queue', () => {
  it('publishes a flat json task that can be read back', async () => {
    const processId = crypto.randomUUID();
    await publishTask({ type: 'process.start', process_id: processId, object_id: 'obj-1' });

    const connection = await amqp.connect(config.rabbitmqUrl);
    const channel = await connection.createChannel();
    await channel.assertQueue(TASK_QUEUE, { durable: true });
    const message = await channel.get(TASK_QUEUE, { noAck: true });
    await channel.close();
    await connection.close();

    expect(message).not.toBe(false);
    const payload = JSON.parse((message as amqp.GetMessage).content.toString());
    expect(payload).toMatchObject({ type: 'process.start', process_id: processId });
  });
});
