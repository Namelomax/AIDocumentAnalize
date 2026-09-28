import client from 'prom-client';

// Customer's ТЗ p.31: "Интеграция с Prometheus для сбора метрик". One
// private registry rather than prom-client's global default, so importing
// this module twice in the same process (as vitest's watch mode can) never
// registers a metric name twice and throws.
export const registry = new client.Registry();

// CPU seconds, RSS, event loop lag, GC pauses - everything the alert rule
// HighCpu reads (deploy/monitoring/alert-rules.yml) comes from here, not
// from anything defined below.
client.collectDefaultMetrics({ register: registry });

// Labelled by route *pattern* (request.routeOptions.url, e.g.
// "/api/v1/findings/:check_id/verdict"), never the raw URL: a raw URL
// carries a fresh uuid on every request, and that cardinality would make
// this histogram unusable (and eventually take down Prometheus itself).
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds, by method, route pattern and status code',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// Section 9.3 decisions (CONFIRMED_VIOLATION / NEGATIVE_VERIFIED /
// CLARIFICATION_REQUIRED) recorded through POST /findings/:check_id/verdict.
export const verdictsTotal = new client.Counter({
  name: 'inspector_verdicts_total',
  help: 'Verdicts recorded by inspectors, by decision',
  labelNames: ['status'],
  registers: [registry],
});

// POST /findings/:check_id/split: a composite candidate split into its
// atomic findings.
export const compositeSplitsTotal = new client.Counter({
  name: 'inspector_composite_splits_total',
  help: 'Composite candidates split into their atomic findings',
  registers: [registry],
});

// POST /protocols/:protocol_id/finalize.
export const finalizationsTotal = new client.Counter({
  name: 'inspector_finalizations_total',
  help: 'Protocols finalized',
  registers: [registry],
});

// Customer's ТЗ p.31, "Проверка целостности данных" (integrity.ts). Files
// that failed the most recent completed sweep - mismatched or missing -
// read by deploy/monitoring/alert-rules.yml's IntegrityFailures. Set back to
// 0 by a run that finds nothing wrong, not left at whatever an older failing
// run last reported.
export const integrityFailuresGauge = new client.Gauge({
  name: 'inspector_integrity_failures',
  help: 'Files that failed the most recently completed integrity check (mismatched or missing hash)',
  registers: [registry],
});

// Unix seconds the most recent completed sweep finished - clean or not, this
// is only about whether the job itself is still running at all
// (IntegrityCheckStale reads it; IntegrityFailures above is what actually
// reads whether files failed).
export const integrityLastRunTimestamp = new client.Gauge({
  name: 'inspector_integrity_last_run_timestamp',
  help: 'Unix timestamp (seconds) the most recently completed integrity check finished',
  registers: [registry],
});
