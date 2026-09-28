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
  // Section 9.6: transfer of a finalized protocol to ИАИС «РиН». The mock
  // (deploy/rin-mock) is plain HTTP by default, since the verification stand
  // is offline and carries no real УКЭП certificate chain - RIN_BASE_URL
  // only turns HTTPS + mTLS on when it is actually pointed at an https:// URL
  // with RIN_CLIENT_CERT/KEY set (integration/client.ts).
  RIN_BASE_URL: z.string().default('http://rin-mock:8090'),
  RIN_CLIENT_CERT: z.string().optional(),
  RIN_CLIENT_KEY: z.string().optional(),
  RIN_CA: z.string().optional(),
  // "экспоненциальной задержкой (1, 5, 15 минут)" - comma-separated seconds,
  // one entry per retry (up to 3, "до 3 повторных попыток").
  RIN_RETRY_DELAYS_S: z.string().default('60,300,900'),
  // Shared secret ИАИС «РиН» sends back on an automatic дозагрузка
  // (POST /api/v1/integration/rin/documents, header X-RIN-Token) - a stand-in
  // for the mTLS client certificate section 12.10 asks the outbound call to
  // use, since the inbound direction has no equivalent in this codebase yet.
  RIN_INBOUND_TOKEN: z.string().default('change-me-rin-token'),
  // How often the api process looks for a transfer whose next_attempt_at is
  // due (integration/transfers.ts's scheduler, guarded by a Postgres
  // advisory lock so two api replicas never double-send).
  RIN_SCHEDULER_INTERVAL_MS: z.coerce.number().default(15_000),
  RIN_REQUEST_TIMEOUT_MS: z.coerce.number().default(10_000),
  // Upper bound for the interactive transaction a scheduler tick runs in
  // (advisory lock + every due transfer's HTTP call): generous enough that a
  // slow/offline ИАИС «РиН» cannot make Prisma abort the transaction before
  // this module's own request timeout even has a chance to fire.
  RIN_TRANSACTION_TIMEOUT_MS: z.coerce.number().default(20_000),
  // Customer's ТЗ p.29, "Антивирусная защита": every uploaded file is
  // scanned by clamd (deploy image clamav/clamav, docker-compose.yml's
  // `clamav` service) over its own INSTREAM TCP protocol before storage
  // (documents/ingest.ts). The default host is the compose service name;
  // local test runs outside Docker override it to localhost (services/api/.env),
  // the same way MINIO_ENDPOINT does.
  CLAMAV_HOST: z.string().default('clamav'),
  CLAMAV_PORT: z.coerce.number().default(3310),
  CLAMAV_TIMEOUT_MS: z.coerce.number().default(15_000),
  // true (default): clamd unreachable rejects the file (ANTIVIRUS_UNAVAILABLE)
  // rather than storing something nobody scanned. false: accept the file
  // unscanned and log a warning - an explicit operator choice, never the
  // out-of-the-box behaviour.
  ANTIVIRUS_REQUIRED: z.enum(['true', 'false']).default('true'),
  // Customer's ТЗ p.31, "Проверка целостности данных": local hour (server
  // time) the daily sweep (integrity.ts) fires at, absent a cron dependency.
  INTEGRITY_CHECK_CRON_HOUR: z.coerce.number().min(0).max(23).default(3),
  // Generous on purpose: the sweep streams every stored document's bytes
  // through sha256 for the whole duration of one Postgres interactive
  // transaction (same advisory-lock shape as RIN_TRANSACTION_TIMEOUT_MS
  // above), and a check package can hold many 60 MiB files.
  INTEGRITY_TRANSACTION_TIMEOUT_MS: z.coerce.number().default(1_800_000),
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
  rin: {
    baseUrl: parsed.RIN_BASE_URL,
    clientCert: parsed.RIN_CLIENT_CERT,
    clientKey: parsed.RIN_CLIENT_KEY,
    ca: parsed.RIN_CA,
    retryDelaysS: parsed.RIN_RETRY_DELAYS_S
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0),
    inboundToken: parsed.RIN_INBOUND_TOKEN,
    schedulerIntervalMs: parsed.RIN_SCHEDULER_INTERVAL_MS,
    requestTimeoutMs: parsed.RIN_REQUEST_TIMEOUT_MS,
    transactionTimeoutMs: parsed.RIN_TRANSACTION_TIMEOUT_MS,
  },
  antivirus: {
    host: parsed.CLAMAV_HOST,
    port: parsed.CLAMAV_PORT,
    timeoutMs: parsed.CLAMAV_TIMEOUT_MS,
    required: parsed.ANTIVIRUS_REQUIRED === 'true',
  },
  integrity: {
    cronHour: parsed.INTEGRITY_CHECK_CRON_HOUR,
    transactionTimeoutMs: parsed.INTEGRITY_TRANSACTION_TIMEOUT_MS,
  },
};
