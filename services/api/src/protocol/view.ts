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

// One member of an unsplit composite candidate (module docstring below,
// buildFinding) - only what the inspector needs to see before splitting;
// its evidence/decision live on the atom's own finding once it is split and
// visible on its own.
export interface CompositeAtomView {
  id: string;
  param_code: string;
  title: string;
  expected_value: string | null;
  actual_value: string | null;
  delta: string | null;
}

export interface CompositeView {
  atoms: CompositeAtomView[];
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
  // Set only for an unsplit composite candidate (services/api's visibility
  // rule, checks/visibility.ts) - its members, so the inspector can see what
  // a split would produce before doing it. Never set on an atom or an
  // ordinary, atomic finding.
  composite?: CompositeView;
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
  // Free-search hypotheses (section 9.5) counted on their own: a SUSPICION
  // is never a violation, so it must never inflate `candidates`.
  suspicions: number;
}

// A hypothesis in the shape of a finding, plus how it was found and how sure
// the model was (section 9.5, table Suspicions of section 10). Kept as its
// own type rather than reusing FindingView's fields loosely, so a caller
// cannot forget the two fields that make a suspicion a suspicion.
export interface SuspicionView extends FindingView {
  detection_method: string | null;
  confidence: number | null;
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
  // Free-search hypotheses (Global Constraint: a hypothesis is not a
  // violation) - their own section, never merged into `findings`.
  suspicions: SuspicionView[];
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

// The check's subject is a worker-authored key (`room X`, `floor total`,
// `function X`, …) baked into evidence_group_id, so it must stay exactly as
// stored - only the finding title translates it for the inspector to read.
// Anything the worker didn't emit one of these three shapes for is shown
// as-is rather than guessed at.
function subjectLabel(subject: string): string {
  // A composite candidate's own subject (worker's app.explication.compare,
  // `f"rooms {first}..{last}"`) - a run of consecutive rooms, not one room.
  const composite = subject.match(/^rooms (.+)\.\.(.+)$/);
  if (composite) return `помещения ${composite[1]}–${composite[2]}`;
  const room = subject.match(/^room (.+)$/);
  if (room) return `помещение ${room[1]}`;
  if (subject === 'floor total') return 'итог по этажу';
  const fn = subject.match(/^function (.+)$/);
  if (fn) return `назначение помещения ${fn[1]}`;
  return subject;
}

// The parameter's name and the check's subject (a room, a floor total, …)
// joined with a dash, so the inspector reads what within the parameter this
// finding is about without opening the evidence card.
function findingTitle(check: Check, param: ParamForView | undefined): string {
  const name = param?.parameterName ?? check.paramCode;
  return check.subject ? `${name} — ${subjectLabel(check.subject)}` : name;
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

function buildCompositeAtomView(atom: Check): CompositeAtomView {
  return {
    id: atom.id,
    param_code: atom.paramCode,
    // A compact label, not the full findingTitle: the composite card lists
    // every atom next to each other, where the parameter name (shared by
    // all of them) would only repeat.
    title: atom.subject ? subjectLabel(atom.subject) : atom.paramCode,
    expected_value: atom.expectedValue,
    actual_value: atom.actualValue,
    delta: atom.delta,
  };
}

export function buildFinding(
  check: CheckWithFragments,
  param: ParamForView | undefined,
  inspectorsById: Map<string, InspectorForView>,
  // The composite's own members, when `check` is an unsplit composite -
  // absent (or empty) for every atom and every ordinary, atomic finding.
  compositeAtoms?: Check[],
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
    composite: compositeAtoms && compositeAtoms.length > 0
      ? { atoms: compositeAtoms.map(buildCompositeAtomView) }
      : undefined,
  };
}

// Same card as a finding, with the two fields a hypothesis adds. Built on
// top of buildFinding rather than duplicating its field list, so the two
// never drift apart on the fields they share.
export function buildSuspicion(
  check: CheckWithFragments,
  param: ParamForView | undefined,
  inspectorsById: Map<string, InspectorForView>,
): SuspicionView {
  return {
    ...buildFinding(check, param, inspectorsById),
    detection_method: check.detectionMethod,
    confidence: check.confidence,
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
// SUSPICION is a third, equally disjoint set: it does carry a finding_status,
// so it is not completeness, but a free-search hypothesis is never a finding
// either (Global Constraint: a hypothesis is not a violation) - it gets its
// own section instead.
export function splitChecks<T extends Check>(
  checks: T[],
): { findings: T[]; suspicions: T[]; completeness: T[] } {
  const findings = checks.filter(
    (check) => check.findingStatus !== null && check.findingStatus !== 'SUSPICION',
  );
  const suspicions = checks.filter((check) => check.findingStatus === 'SUSPICION');
  const completeness = checks.filter((check) => check.findingStatus === null);
  return { findings, suspicions, completeness };
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
    suspicions: 0,
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
      case 'SUSPICION':
        summary.suspicions += 1;
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

// The pure half of routes/protocols.ts's atomsByParent: given the FULL row
// set of a process (composites and their atoms alike - not the
// visibility-filtered list buildProtocolResponse itself reads), groups every
// atom under its parent's id. Used directly by a superseded protocol's
// snapshot (routes/protocols.ts), which has no live `checks` rows left to
// query atoms out of - the snapshot already carries every row it needs.
export function groupAtomsByParent<T extends Check & { parentCheckId: string | null }>(
  checks: T[],
): Map<string, T[]> {
  const byParent = new Map<string, T[]>();
  for (const check of checks) {
    if (check.parentCheckId === null) continue;
    const list = byParent.get(check.parentCheckId) ?? [];
    list.push(check);
    byParent.set(check.parentCheckId, list);
  }
  return byParent;
}

export function buildProtocolResponse(
  protocol: Protocol,
  checks: CheckWithFragments[],
  paramsByCode: Map<string, ParamForView>,
  inspectorsById: Map<string, InspectorForView>,
  // An unsplit composite's own members, keyed by the composite's check id
  // (routes/protocols.ts's atomsByParent) - empty by default so a caller
  // that has none to give (e.g. a route that never has composites in reach)
  // does not have to build an empty Map just to call this.
  compositeAtomsByParent: Map<string, Check[]> = new Map(),
): ProtocolResponse {
  const { findings, suspicions, completeness } = splitChecks(checks);
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
    findings: findings.map((check) => buildFinding(
      check, paramsByCode.get(check.paramCode), inspectorsById, compositeAtomsByParent.get(check.id),
    )),
    suspicions: suspicions.map((check) => buildSuspicion(check, paramsByCode.get(check.paramCode), inspectorsById)),
  };
}
