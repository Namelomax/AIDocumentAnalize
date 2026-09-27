// The only place that knows both schemas (Plan 7, Task 4): the API's
// snake_case response shapes (mirrored below from services/api's actual
// routes — objects.ts, dashboard.ts, protocols.ts, protocol/view.ts) on one
// side, the interface's camelCase types (src/types/index.ts) on the other.
// No screen or component should read an API field name directly; everything
// goes through a function here.
import type {
  ApprovalStatus,
  CompletenessStatus,
  DocStage,
  EvidenceFragment,
  Finding,
  FindingDecision,
  FindingStatus,
  ObjectProcess,
  ProcessStatus,
  ProjectObject,
  Protocol,
  ReasonCode,
  ReviewPriority,
  UploadedFile,
} from '../types';

/* ─────────── Форма ответов API (snake_case) ─────────── */

export interface ApiCompleteness {
  pd: string | null;
  rd: string | null;
  id: string | null;
}

// GET /api/v1/objects → items[]; GET /api/v1/objects/:id shares every field.
export interface ApiObjectListItem {
  id: string;
  name: string;
  address: string | null;
  customer: string | null;
  contractor: string | null;
  permit_number: string | null;
  completeness: ApiCompleteness;
  process_status: string | null;
  latest_process_id: string | null;
  latest_protocol_id: string | null;
  candidates: number;
  confirmed: number;
  updated_at: string | null;
  indicator: 'green' | 'yellow' | 'red';
}

export interface ApiObjectProcess {
  process_id: string;
  status: string;
  scenario: string | null;
  created_at: string;
  protocol_id: string | null;
  protocol_version: number | null;
}

export interface ApiObjectDetail extends ApiObjectListItem {
  processes: ApiObjectProcess[];
}

// GET /api/v1/objects/:id/files → items[]. A registry row carries
// doc_stage = null; toUploadedFile is only meant to be called on the rest —
// the caller filters that row out and shows it separately (Task 4 spec).
export interface ApiFileItem {
  id: string;
  file_name: string;
  doc_stage: string | null;
  discipline: string | null;
  document_code: string | null;
  revision: string | null;
  approval_status: string | null;
  page_count: number;
  size_bytes: number;
  file_sha256: string;
  from_manifest: boolean;
  uploaded_at: string;
  process_id: string;
}

export interface ApiDashboardSummary {
  objects_in_work: number;
  awaiting_verification: number;
  candidates_to_review: number;
  finalized_this_month: number;
}

export interface ApiEvidence {
  role: string;
  file_id: string;
  file_sha256: string;
  stage: string;
  document_code: string | null;
  revision: string | null;
  approval_status: string;
  sheet_page: number;
  bbox: [number, number, number, number];
  extracted_value: string | null;
  image_url: string;
}

export interface ApiDecision {
  status: string | null;
  reason_code: string | null;
  comment: string | null;
  inspector: { id: string; full_name: string | null };
  decided_at: string | null;
}

// The finding form from services/api/src/protocol/view.ts (FindingView).
export interface ApiFinding {
  id: string;
  evidence_group_id: string;
  param_code: string;
  section: string | null;
  title: string;
  unit: string | null;
  expected_value: string | null;
  actual_value: string | null;
  delta: string | null;
  trigger_logic: string | null;
  norm_reference: string | null;
  rationale: string | null;
  review_priority: string;
  finding_status: string | null;
  engine_status: string | null;
  completeness_status: string;
  sources: string[];
  evidence: ApiEvidence[];
  decision: ApiDecision | null;
}

export interface ApiCompletenessRow {
  param_code: string;
  parameter_name: string | null;
  completeness_status: string;
  rationale: string | null;
}

export interface ApiProtocolSummary {
  checked: number;
  candidates: number;
  confirmed: number;
  negative: number;
  missing_evidence: number;
  not_applicable: number;
  not_comparable: number;
  clarification_required: number;
}

export interface ApiProtocol {
  id: string;
  object_id: string;
  process_id: string;
  version: number;
  status: string;
  sync_status: string | null;
  matrix_version: string;
  model_version: string;
  dataset_version: string;
  input_manifest_hash: string;
  created_at: string;
  finalized_at: string | null;
  summary: ApiProtocolSummary;
  completeness: ApiCompletenessRow[];
  findings: ApiFinding[];
}

/* ─────────── Общие преобразования ─────────── */

// "14.11.2025 10:22", the format every mock timestamp already used.
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// StageCompleteness values (services/worker/app/domain/completeness.py):
// UPLOADED | PARTIAL | MISSING | NOT_APPLICABLE. null means the object has no
// process yet, which reads the same as MISSING — nothing was uploaded either
// way.
function mapCompletenessStatus(value: string | null): CompletenessStatus {
  switch (value) {
    case 'UPLOADED': return 'full';
    case 'PARTIAL': return 'partial';
    case 'NOT_APPLICABLE': return 'not_applicable';
    default: return 'missing';
  }
}

// process_status is null when an object has never had a process created for
// it. 'PENDING' ("Ожидает обработки") is the closest existing label for
// that — there is no separate "no process yet" value in the interface.
function mapProcessStatus(value: string | null): ProcessStatus {
  return (value as ProcessStatus | null) ?? 'PENDING';
}

/* ─────────── Объекты ─────────── */

export function toProjectObject(api: ApiObjectListItem): ProjectObject {
  return {
    id: api.id,
    name: api.name,
    address: api.address ?? '',
    // The designer's layout labels this "Застройщик"; the API's `customer`
    // is the closest match — section 10's Objects table has no field
    // literally named "developer". `contractor` rides along for the object
    // card, which the mock data never needed to show.
    developer: api.customer ?? '',
    contractor: api.contractor ?? undefined,
    permit: api.permit_number ?? '',
    completeness: {
      PD: mapCompletenessStatus(api.completeness.pd),
      RD: mapCompletenessStatus(api.completeness.rd),
      ID: mapCompletenessStatus(api.completeness.id),
    },
    processStatus: mapProcessStatus(api.process_status),
    latestProcessId: api.latest_process_id,
    latestProtocolId: api.latest_protocol_id,
    candidates: api.candidates,
    confirmed: api.confirmed,
    updatedAt: api.updated_at ? formatDateTime(api.updated_at) : '—',
    indicator: api.indicator,
  };
}

export function toObjectProcess(api: ApiObjectProcess): ObjectProcess {
  return {
    processId: api.process_id,
    status: api.status as ProcessStatus,
    scenario: api.scenario,
    createdAt: formatDateTime(api.created_at),
    protocolId: api.protocol_id,
    protocolVersion: api.protocol_version,
  };
}

export function toDashboardSummary(api: ApiDashboardSummary) {
  return {
    objectsInWork: api.objects_in_work,
    awaitingVerification: api.awaiting_verification,
    candidatesToReview: api.candidates_to_review,
    finalizedThisMonth: api.finalized_this_month,
  };
}

// GET /api/v1/upload/limits — read once by the upload screen instead of the
// hardcoded 50/200 MB the mock UI used to show (Task 4 spec: the real limit
// is 60 MB per file, and a hardcoded copy would drift from it again).
export interface ApiUploadLimits {
  max_file_bytes: number;
  max_package_bytes: number;
  supported_formats: string[];
  registry_formats: string[];
}

export interface UploadLimits {
  maxFileBytes: number;
  maxPackageBytes: number;
  supportedFormats: string[];
  registryFormats: string[];
}

export function toUploadLimits(api: ApiUploadLimits): UploadLimits {
  return {
    maxFileBytes: api.max_file_bytes,
    maxPackageBytes: api.max_package_bytes,
    supportedFormats: api.supported_formats,
    registryFormats: api.registry_formats,
  };
}

/* ─────────── Файлы ─────────── */

export function toUploadedFile(api: ApiFileItem): UploadedFile {
  return {
    id: api.id,
    name: api.file_name,
    // Only meant to be called for a row with a real stage; the registry row
    // (doc_stage = null) is filtered out and shown separately by the caller.
    stage: (api.doc_stage ?? 'PD') as DocStage,
    mark: api.discipline ?? '',
    code: api.document_code ?? '',
    revision: api.revision ? `Ред. ${api.revision}` : '—',
    approvalStatus: (api.approval_status ?? 'DRAFT') as ApprovalStatus,
    sheets: api.page_count,
    size: `${(api.size_bytes / 1024 / 1024).toFixed(1)} МБ`,
    sha256: api.file_sha256,
  };
}

/* ─────────── Доказательства, находки, протокол ─────────── */

export function toEvidenceFragment(api: ApiEvidence): EvidenceFragment {
  return {
    fileId: api.file_id,
    sha256: api.file_sha256,
    stage: api.stage as DocStage,
    documentCode: api.document_code ?? '',
    revision: api.revision ?? '',
    approvalStatus: api.approval_status as ApprovalStatus,
    sheetPage: api.sheet_page,
    bbox: api.bbox,
    extractedValue: api.extracted_value ?? '—',
    role: api.role === 'actual' ? 'actual' : 'expected',
    imageUrl: api.image_url,
  };
}

// A blank card rather than a crash when a finding has no fragment for a
// role (e.g. MISSING_EVIDENCE candidates carry no evidence array at all).
// Finding keeps one fragment per side rather than the API's evidence array
// until Task 5 reshapes the verification screen around it directly.
function blankEvidence(role: 'expected' | 'actual'): EvidenceFragment {
  return {
    fileId: '', sha256: '', stage: 'PD', documentCode: '', revision: '',
    approvalStatus: 'DRAFT', sheetPage: 0, bbox: [0, 0, 0, 0],
    extractedValue: '—', role, imageUrl: '',
  };
}

function pickEvidence(evidence: ApiEvidence[], role: 'expected' | 'actual'): EvidenceFragment {
  const byRole = evidence.find((e) => e.role === role);
  const fallback = byRole ?? evidence[0];
  return fallback ? toEvidenceFragment(fallback) : blankEvidence(role);
}

function formatValue(value: string | null, unit: string | null): string {
  if (value === null) return '—';
  return unit ? `${value} ${unit}` : value;
}

function toFindingDecision(api: ApiDecision | null): FindingDecision | undefined {
  if (!api || !api.status) return undefined;
  return {
    status: api.status as FindingDecision['status'],
    reasonCode: (api.reason_code ?? undefined) as ReasonCode | undefined,
    comment: api.comment ?? undefined,
    inspector: api.inspector.full_name ?? api.inspector.id,
    timestamp: api.decided_at ? formatDateTime(api.decided_at) : '—',
  };
}

export function toFinding(api: ApiFinding): Finding {
  // Task 4 spec: the finding's status comes from finding_status, falling
  // back to completeness_status when it is absent (a completeness-only row
  // read through /findings/:id, or reused directly for a display).
  const status = (api.finding_status ?? api.completeness_status) as FindingStatus;
  return {
    id: api.id,
    code: api.param_code,
    section: api.section ?? '',
    title: api.title,
    unit: api.unit ?? undefined,
    expected: formatValue(api.expected_value, api.unit),
    actual: formatValue(api.actual_value, api.unit),
    delta: api.delta ?? '—',
    trigger: api.trigger_logic ?? '',
    normReference: api.norm_reference,
    // The API carries no separate "approved change" field — an approved
    // change is recorded as the inspector's decision reason (APPROVED_CHANGE)
    // instead, not a fact about the finding itself.
    approvedChange: null,
    aiRationale: api.rationale ?? '',
    priority: api.review_priority as ReviewPriority,
    status,
    sources: api.sources as DocStage[],
    expectedEvidence: pickEvidence(api.evidence, 'expected'),
    actualEvidence: pickEvidence(api.evidence, 'actual'),
    decision: toFindingDecision(api.decision),
  };
}

export function toProtocol(api: ApiProtocol): Protocol {
  return {
    id: api.id,
    // The API has no separate human protocol number (section 10's Protocols
    // table has none either) — the id's short form stands in for display
    // until Task 5, which owns the protocol screen, decides the real format.
    number: api.id.slice(0, 8),
    objectId: api.object_id,
    createdAt: formatDateTime(api.created_at),
    version: api.version,
    // Mismatch carried over from the mock model: Protocol.processStatus was
    // named for a Process (PENDING/PARSING/READY/VERIFYING/COMPLETED/
    // FINALIZED) but a protocol's own status also includes
    // VERIFICATION_COMPLETED and PROTOCOL_FINALIZED, which are not part of
    // that union. Left as a direct cast for Task 5 to resolve together with
    // the protocol screen it feeds.
    processStatus: api.status as ProcessStatus,
    matrixVersion: api.matrix_version,
    modelVersion: api.model_version,
    datasetVersion: api.dataset_version,
    hash: api.input_manifest_hash,
    summary: {
      checked: api.summary.checked,
      candidates: api.summary.candidates,
      confirmed: api.summary.confirmed,
      negative: api.summary.negative,
      noEvidence: api.summary.missing_evidence,
      notApplicable: api.summary.not_applicable,
      // not_comparable and clarification_required have no slot in the
      // current summary shape; Task 5 extends it alongside the protocol
      // screen's completeness tab.
    },
    findings: api.findings.map(toFinding),
  };
}
