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

export type ReviewPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export type ReasonCode =
  | 'WRONG_REVISION'
  | 'APPROVED_CHANGE'
  | 'OCR_ERROR'
  | 'BINDING_ERROR'
  | 'NOT_APPLICABLE'
  | 'OTHER';

export interface EvidenceFragment {
  sha256: string;
  stage: DocStage;
  documentCode: string;
  revision: string;
  approvalStatus: ApprovalStatus;
  sheetPage: number;
  bbox: [number, number, number, number]; // нормализованные [0..1]
  extractedValue: string;
  role: 'expected' | 'actual';
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
  developer: string;
  permit: string;
  completeness: {
    PD: 'full' | 'partial' | 'missing';
    RD: 'full' | 'partial' | 'missing';
    ID: 'full' | 'partial' | 'missing';
  };
  processStatus: ProcessStatus;
  candidates: number;
  confirmed: number;
  updatedAt: string;
  indicator: 'green' | 'yellow' | 'red';
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

export interface Protocol {
  id: string;
  number: string;
  objectId: string;
  createdAt: string;
  version: number;
  processStatus: ProcessStatus;
  matrixVersion: string;
  modelVersion: string;
  datasetVersion: string;
  hash: string;
  summary: {
    checked: number;
    candidates: number;
    confirmed: number;
    negative: number;
    noEvidence: number;
    notApplicable: number;
  };
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