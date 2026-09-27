// Pure functions that turn Prisma rows into the protocol response shape of
// section 9.2/10 of the specification. Kept free of Fastify and Prisma
// queries so the assembly can be tested without HTTP or a database.
import type { Check, EvidenceFragment, Param, Protocol, User } from '@prisma/client';

export type CheckWithFragments = Check & { fragments: EvidenceFragment[] };

// Only the columns a finding actually reads, so a caller can pass a partial
// projection instead of a full Param row.
export type ParamForView = Pick<
  Param,
  'section' | 'parameterName' | 'unit' | 'triggerLogic' | 'spReference' | 'gostReference'
>;

export type InspectorForView = Pick<User, 'id' | 'fullName'>;

export interface EvidenceView {
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

export interface DecisionView {
  status: string | null;
  reason_code: string | null;
  comment: string | null;
  inspector: { id: string; full_name: string | null };
  decided_at: Date | null;
}

export interface FindingView {
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
  evidence: EvidenceView[];
  decision: DecisionView | null;
}

export interface CompletenessRow {
  param_code: string;
  parameter_name: string | null;
  completeness_status: string;
  rationale: string | null;
}

export interface ProtocolSummary {
  checked: number;
  candidates: number;
  confirmed: number;
  negative: number;
  missing_evidence: number;
  not_applicable: number;
  not_comparable: number;
  clarification_required: number;
}

export interface ProtocolResponse {
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
  created_at: Date;
  finalized_at: Date | null;
  summary: ProtocolSummary;
  completeness: CompletenessRow[];
  findings: FindingView[];
}

function evidenceView(fragment: EvidenceFragment): EvidenceView {
  return {
    role: fragment.role,
    file_id: fragment.fileId,
    file_sha256: fragment.fileSha256,
    stage: fragment.stage,
    document_code: fragment.documentCode,
    revision: fragment.revision,
    approval_status: fragment.approvalStatus,
    sheet_page: fragment.sheetPage,
    bbox: [fragment.x0, fragment.y0, fragment.x1, fragment.y1],
    extracted_value: fragment.extractedValue,
    // The image key lives on `pages`, keyed by file and page number - this
    // is a route the client follows, not a storage key it can forge.
    image_url: `/api/v1/files/${fragment.fileId}/pages/${fragment.sheetPage}/image`,
  };
}

// СП and ГОСТ references are the two normative sources section 9.2 asks a
// finding to cite; the values already carry their "СП …" / "ГОСТ …" prefix.
function normReference(param: ParamForView | undefined): string | null {
  const parts = [param?.spReference, param?.gostReference].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join('; ') : null;
}

// The parameter's name and the check's subject (a room, a floor total, …)
// joined with a dash, so the inspector reads what within the parameter this
// finding is about without opening the evidence card.
function findingTitle(check: Check, param: ParamForView | undefined): string {
  const name = param?.parameterName ?? check.paramCode;
  return check.subject ? `${name} — ${check.subject}` : name;
}

function decisionView(
  check: Check,
  inspectorsById: Map<string, InspectorForView>,
): DecisionView | null {
  if (!check.verifiedBy) return null;
  const inspector = inspectorsById.get(check.verifiedBy);
  return {
    status: check.findingStatus,
    reason_code: check.verdictReasonCode,
    comment: check.verdictComment,
    inspector: { id: check.verifiedBy, full_name: inspector?.fullName ?? null },
    decided_at: check.verifiedAt,
  };
}

export function buildFinding(
  check: CheckWithFragments,
  param: ParamForView | undefined,
  inspectorsById: Map<string, InspectorForView>,
): FindingView {
  return {
    id: check.id,
    evidence_group_id: check.evidenceGroupId,
    param_code: check.paramCode,
    section: param?.section ?? null,
    title: findingTitle(check, param),
    unit: param?.unit ?? null,
    expected_value: check.expectedValue,
    actual_value: check.actualValue,
    delta: check.delta,
    trigger_logic: param?.triggerLogic ?? null,
    norm_reference: normReference(param),
    rationale: check.rationale,
    review_priority: check.reviewPriority,
    finding_status: check.findingStatus,
    engine_status: check.engineStatus,
    completeness_status: check.completenessStatus,
    // Distinct stages behind the evidence, in the order they were attached.
    sources: [...new Set(check.fragments.map((fragment) => fragment.stage))],
    evidence: check.fragments.map(evidenceView),
    decision: decisionView(check, inspectorsById),
  };
}

export function buildCompletenessRow(check: Check, param: ParamForView | undefined): CompletenessRow {
  return {
    param_code: check.paramCode,
    parameter_name: param?.parameterName ?? null,
    completeness_status: check.completenessStatus,
    rationale: check.rationale,
  };
}

// Section 9.2 keeps completeness/comparability and findings as separate
// tables of the protocol. A check without a finding_status was never
// compared - it belongs to completeness, never to findings, and never both.
export function splitChecks<T extends Check>(checks: T[]): { findings: T[]; completeness: T[] } {
  const findings = checks.filter((check) => check.findingStatus !== null);
  const completeness = checks.filter((check) => check.findingStatus === null);
  return { findings, completeness };
}

export function buildSummary(checks: Check[]): ProtocolSummary {
  const summary: ProtocolSummary = {
    checked: checks.length,
    candidates: 0,
    confirmed: 0,
    negative: 0,
    missing_evidence: 0,
    not_applicable: 0,
    not_comparable: 0,
    clarification_required: 0,
  };
  for (const check of checks) {
    switch (check.findingStatus) {
      case 'CANDIDATE':
        summary.candidates += 1;
        break;
      case 'CONFIRMED_VIOLATION':
        summary.confirmed += 1;
        break;
      case 'NEGATIVE_VERIFIED':
        summary.negative += 1;
        break;
      case null:
        // No finding_status: the outcome to count is why it wasn't
        // comparable, which lives in completeness_status instead.
        switch (check.completenessStatus) {
          case 'MISSING_EVIDENCE':
            summary.missing_evidence += 1;
            break;
          case 'NOT_APPLICABLE':
            summary.not_applicable += 1;
            break;
          case 'NOT_COMPARABLE':
            summary.not_comparable += 1;
            break;
          case 'CLARIFICATION_REQUIRED':
            summary.clarification_required += 1;
            break;
          default:
            break;
        }
        break;
      default:
        break;
    }
  }
  return summary;
}

export function buildProtocolResponse(
  protocol: Protocol,
  checks: CheckWithFragments[],
  paramsByCode: Map<string, ParamForView>,
  inspectorsById: Map<string, InspectorForView>,
): ProtocolResponse {
  const { findings, completeness } = splitChecks(checks);
  return {
    id: protocol.id,
    object_id: protocol.objectId,
    process_id: protocol.processId,
    version: protocol.version,
    status: protocol.status,
    sync_status: protocol.syncStatus,
    matrix_version: protocol.matrixVersion,
    model_version: protocol.modelVersion,
    dataset_version: protocol.datasetVersion,
    input_manifest_hash: protocol.inputManifestHash,
    created_at: protocol.createdAt,
    finalized_at: protocol.finalizedAt,
    summary: buildSummary(checks),
    completeness: completeness.map((check) => buildCompletenessRow(check, paramsByCode.get(check.paramCode))),
    findings: findings.map((check) => buildFinding(check, paramsByCode.get(check.paramCode), inspectorsById)),
  };
}
