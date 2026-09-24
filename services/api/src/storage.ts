import { createHash } from 'node:crypto';
import { Client } from 'minio';
import { config } from './config.js';

const client = new Client({
  endPoint: config.minio.endPoint,
  port: config.minio.port,
  useSSL: false,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function storageKeyFor(hash: string): string {
  return `documents/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
}

export async function ensureBucket(): Promise<void> {
  const exists = await client.bucketExists(config.minio.bucket);
  if (!exists) await client.makeBucket(config.minio.bucket);
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await client.putObject(config.minio.bucket, key, body, body.length, {
    'Content-Type': contentType,
  });
}

export async function getObject(key: string): Promise<Buffer> {
  const stream = await client.getObject(config.minio.bucket, key);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
