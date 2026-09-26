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
  // 60 MiB, not the 50 the spec states: the customer's own reference package
  // carries a 51.5 MiB drawing set, and refusing the customer's sample would
  // be following the letter of the limit against its purpose.
  MAX_FILE_BYTES: z.coerce.number().default(62_914_560),
  MAX_PACKAGE_BYTES: z.coerce.number().default(209_715_200),
  LOG_LEVEL: z.string().default('info'),
  TASK_QUEUE: z.string().default('inspector.tasks'),
  // Demo accounts are created on first start so the verification stand, run
  // without the team, has someone to log in as. The defaults are documented
  // in the README; override them for anything beyond a demo.
  DEMO_ADMIN_PASSWORD: z.string().default('admin123'),
  DEMO_INSPECTOR_PASSWORD: z.string().default('inspector123'),
  DEMO_SUPERVISOR_PASSWORD: z.string().default('supervisor123'),
  DEMO_ML_PASSWORD: z.string().default('ml123'),
  JWT_TTL: z.string().default('12h'),
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
  taskQueue: parsed.TASK_QUEUE,
  demoPasswords: {
    admin: parsed.DEMO_ADMIN_PASSWORD,
    inspector: parsed.DEMO_INSPECTOR_PASSWORD,
    supervisor: parsed.DEMO_SUPERVISOR_PASSWORD,
    ml: parsed.DEMO_ML_PASSWORD,
  },
  jwtTtl: parsed.JWT_TTL,
};
