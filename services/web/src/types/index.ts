export type FindingStatus =
  | 'CANDIDATE'
  | 'CONFIRMED_VIOLATION'
  | 'NEGATIVE_VERIFIED'
  | 'MISSING_EVIDENCE'
  | 'NOT_APPLICABLE'
  | 'NOT_COMPARABLE'
  | 'CLARIFICATION_REQUIRED'
  | 'SUSPICION';

export type ProcessStatus =
  | 'PENDING' | 'PARSING' | 'READY' | 'VERIFYING' | 'COMPLETED' | 'FINALIZED';

export type DocStage = 'PD' | 'RD' | 'ID';

export type ApprovalStatus =
  | 'DRAFT' | 'APPROVED' | 'FOR_CONSTRUCTION' | 'SUPERSEDED' | 'CANCELLED';

// The interface's own vocabulary for a stage's upload completeness (dashboard
// and upload screens). 'not_applicable' is new in Plan 7: the API's
// StageCompleteness carries it for a stage a scenario does not require, which
// the mock data never had to represent.
export type CompletenessStatus = 'full' | 'partial' | 'missing' | 'not_applicable';

export type ReviewPriority = 'HIGH' | 'MEDIUM' | 'LOW';

// A protocol's own lifecycle (section 9.3), distinct from ProcessStatus:
// FINALIZED/COMPLETED never apply to a protocol, and VERIFICATION_COMPLETED/
// PROTOCOL_FINALIZED never apply to a process. Kept as its own union rather
// than folded into ProcessStatus, which the mock model used to do (see
// adapters.ts, toProtocol).
export type ProtocolStatus = 'READY' | 'VERIFYING' | 'VERIFICATION_COMPLETED' | 'PROTOCOL_FINALIZED';

// Transfer to ИАИС «РиН» (section 9.6) is a stub on the server — this only
// reflects what protocols.sync_status already reports, never invented here.
export type SyncStatus = 'PENDING_SYNC' | 'SYNCED';

// The subset of FindingStatus a completeness/comparability row can carry —
// a check without a finding_status was never compared, so it can never be a
// CANDIDATE, a decided outcome, or a hypothesis (services/api's
// buildCompletenessRow only ever sees these four).
export type CompletenessRowStatus =
  | 'MISSING_EVIDENCE' | 'NOT_APPLICABLE' | 'NOT_COMPARABLE' | 'CLARIFICATION_REQUIRED';

export type ReasonCode =
  | 'WRONG_REVISION'
  | 'APPROVED_CHANGE'
  | 'OCR_ERROR'
  | 'BINDING_ERROR'
  | 'NOT_APPLICABLE'
  | 'OTHER';

export interface EvidenceFragment {
  // Which file the fragment was cut from (ТЗ requires `file_id` on the
  // evidence card so the inspector can open the source file it came from).
  fileId: string;
  sha256: string;
  stage: DocStage;
  documentCode: string;
  revision: string;
  approvalStatus: ApprovalStatus;
  sheetPage: number;
  bbox: [number, number, number, number]; // нормализованные [0..1]
  extractedValue: string;
  role: 'expected' | 'actual';
  // The page image to render behind the bbox overlay; fetched through
  // apiBlob() and turned into an object URL by the evidence panel.
  imageUrl: string;
}

export interface FindingDecision {
  status: 'CONFIRMED_VIOLATION' | 'NEGATIVE_VERIFIED' | 'CLARIFICATION_REQUIRED';
  reasonCode?: ReasonCode;
  comment?: string;
  inspector: string;
  timestamp: string;
}

export interface Finding {
  id: string;
  code: string;
  section: string;
  title: string;
  unit?: string;
  expected: string;
  actual: string;
  delta: string;
  trigger: string;
  normReference?: string | null;
  approvedChange?: string | null;
  aiRationale: string;
  priority: ReviewPriority;
  status: FindingStatus;
  sources: DocStage[];
  expectedEvidence: EvidenceFragment;
  actualEvidence: EvidenceFragment;
  decision?: FindingDecision;
    composite?: {
    atoms: CompositeAtom[];
    note?: string;
  };
  clarificationConflict?: ClarificationConflict;
  detectionMethod?: DetectionMethod;
  confidence?: number;
}

export interface ProjectObject {
  id: string;
  name: string;
  address: string;
  // Rendered by every screen as "Застройщик" — mapped from the API's
  // `customer` field (see adapters.ts); `contractor` has no place in the
  // designer's layout yet and is carried separately for the object card.
  developer: string;
  contractor?: string;
  permit: string;
  completeness: Record<DocStage, CompletenessStatus>;
  processStatus: ProcessStatus;
  latestProcessId: string | null;
  latestProtocolId: string | null;
  candidates: number;
  confirmed: number;
  updatedAt: string;
  indicator: 'green' | 'yellow' | 'red';
}

// One process in an object's history (GET /objects/:id → processes[]),
// newest first — used by the object card's "Протоколы"/"История" tabs.
export interface ObjectProcess {
  processId: string;
  status: ProcessStatus;
  scenario: string | null;
  createdAt: string;
  protocolId: string | null;
  protocolVersion: number | null;
}

export interface UploadedFile {
  id: string;
  name: string;
  stage: DocStage;
  mark: string;
  code: string;
  revision: string;
  approvalStatus: ApprovalStatus;
  sheets: number;
  size: string;
  sha256: string;
}

// One row of the protocol's completeness/comparability table (section 9.2:
// "раздельные таблицы: комплектность и сопоставимость; кандидаты…") — a
// check that was never compared, so it carries none of a finding's fields
// (expected/actual/evidence/priority).
export interface ProtocolCompletenessRow {
  paramCode: string;
  parameterName: string;
  status: CompletenessRowStatus;
  rationale: string;
}

export interface Protocol {
  id: string;
  number: string;
  objectId: string;
  createdAt: string;
  version: number;
  status: ProtocolStatus;
  syncStatus: SyncStatus | null;
  matrixVersion: string;
  modelVersion: string;
  datasetVersion: string;
  hash: string;
  finalizedAt: string | null;
  summary: {
    checked: number;
    candidates: number;
    confirmed: number;
    negative: number;
    noEvidence: number;
    notApplicable: number;
    notComparable: number;
    clarificationRequired: number;
  };
  completeness: ProtocolCompletenessRow[];
  findings: Finding[];
}

export interface CompositeAtom {
  id: string;
  code: string;
  title: string;
  expected: string;
  actual: string;
  delta: string;
}

export interface RevisionCard {
  sha256: string;
  documentCode: string;
  revision: string;
  approvalStatus: ApprovalStatus;
  approvedAt: string;
  sheetPage: number;
  extractedValue: string;
}

export interface ClarificationConflict {
  revisions: [RevisionCard, RevisionCard];
}

export type DetectionMethod = 'logical' | 'semantic' | 'normative' | 'ml';