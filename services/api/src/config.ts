import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  RABBITMQ_URL: z.string(),
  MINIO_ENDPOINT: z.string(),
  MINIO_ROOT_USER: z.string(),
  MINIO_ROOT_PASSWORD: z.string(),
  MINIO_BUCKET: z.string().default('documents'),
  JWT_SECRET: z.string(),
  MAX_FILE_BYTES: z.coerce.number().default(52_428_800),
  MAX_PACKAGE_BYTES: z.coerce.number().default(209_715_200),
  LOG_LEVEL: z.string().default('info'),
});

const parsed = schema.parse(process.env);

export const config = {
  port: parsed.PORT,
  databaseUrl: parsed.DATABASE_URL,
  rabbitmqUrl: parsed.RABBITMQ_URL,
  minio: {
    endPoint: parsed.MINIO_ENDPOINT.split(':')[0],
    port: Number(parsed.MINIO_ENDPOINT.split(':')[1] ?? 9000),
    accessKey: parsed.MINIO_ROOT_USER,
    secretKey: parsed.MINIO_ROOT_PASSWORD,
    bucket: parsed.MINIO_BUCKET,
  },
  jwtSecret: parsed.JWT_SECRET,
  maxFileBytes: parsed.MAX_FILE_BYTES,
  maxPackageBytes: parsed.MAX_PACKAGE_BYTES,
  logLevel: parsed.LOG_LEVEL,
};
