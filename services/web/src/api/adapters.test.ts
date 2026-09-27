import { describe, expect, it } from 'vitest';
import {
  toDashboardSummary,
  toEvidenceFragment,
  toFinding,
  toProjectObject,
  toProtocol,
  toUploadedFile,
  type ApiEvidence,
  type ApiFinding,
  type ApiObjectListItem,
  type ApiProtocol,
} from './adapters';

// Fixtures below mirror the real response shapes of services/api (see
// src/protocol/view.ts and src/routes/objects.ts), not just the illustrative
// JSON of Plan 6/7 — both agree on field names.

const evidenceFixture: ApiEvidence = {
  role: 'expected',
  file_id: 'file-1',
  file_sha256: 'a'.repeat(64),
  stage: 'PD',
  document_code: 'АНО/150321/1-П-АР',
  revision: '1',
  approval_status: 'APPROVED',
  sheet_page: 1,
  bbox: [0.1, 0.2, 0.3, 0.4],
  extracted_value: '18.20',
  image_url: '/api/v1/files/file-1/pages/1/image',
};

const findingFixture: ApiFinding = {
  id: 'check-1',
  evidence_group_id: 'group-1',
  param_code: 'M-003',
  section: 'ПЗ',
  title: 'Полезная / Расчетная площадь — room 1.109',
  unit: 'м²',
  expected_value: null,
  actual_value: '18.20',
  delta: null,
  trigger_logic: 'room added in RD',
  norm_reference: 'СП 54.13330.2022; ГОСТ 12345',
  rationale: 'В РД добавлено помещение 1.109',
  review_priority: 'MEDIUM',
  finding_status: 'CANDIDATE',
  engine_status: 'CANDIDATE',
  completeness_status: 'COMPLETE',
  sources: ['PD', 'RD'],
  evidence: [evidenceFixture, { ...evidenceFixture, role: 'actual', file_id: 'file-2' }],
  decision: null,
};

describe('toEvidenceFragment', () => {
  it('maps snake_case fields to the camelCase EvidenceFragment shape', () => {
    const fragment = toEvidenceFragment(evidenceFixture);
    expect(fragment).toEqual({
      fileId: 'file-1',
      sha256: 'a'.repeat(64),
      stage: 'PD',
      documentCode: 'АНО/150321/1-П-АР',
      revision: '1',
      approvalStatus: 'APPROVED',
      sheetPage: 1,
      bbox: [0.1, 0.2, 0.3, 0.4],
      extractedValue: '18.20',
      role: 'expected',
      imageUrl: '/api/v1/files/file-1/pages/1/image',
    });
  });

  it('carries the bbox through as four numbers, unchanged', () => {
    const fragment = toEvidenceFragment(evidenceFixture);
    expect(fragment.bbox).toHaveLength(4);
    expect(fragment.bbox).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('falls back to the "expected" role for anything other than "actual"', () => {
    const fragment = toEvidenceFragment({ ...evidenceFixture, role: 'something-else' });
    expect(fragment.role).toBe('expected');
  });
});

describe('toFinding', () => {
  it('maps snake_case finding fields to camelCase', () => {
    const finding = toFinding(findingFixture);
    expect(finding.id).toBe('check-1');
    expect(finding.code).toBe('M-003');
    expect(finding.title).toBe('Полезная / Расчетная площадь — room 1.109');
    expect(finding.aiRationale).toBe('В РД добавлено помещение 1.109');
    expect(finding.priority).toBe('MEDIUM');
    expect(finding.normReference).toBe('СП 54.13330.2022; ГОСТ 12345');
  });

  it('takes status from finding_status when present', () => {
    const finding = toFinding(findingFixture);
    expect(finding.status).toBe('CANDIDATE');
  });

  it('falls back to completeness_status when finding_status is absent', () => {
    const finding = toFinding({
      ...findingFixture,
      finding_status: null,
      completeness_status: 'NOT_COMPARABLE',
    });
    expect(finding.status).toBe('NOT_COMPARABLE');
  });

  it('splits the evidence array into expected/actual fragments by role', () => {
    const finding = toFinding(findingFixture);
    expect(finding.expectedEvidence.fileId).toBe('file-1');
    expect(finding.actualEvidence.fileId).toBe('file-2');
  });

  it('maps a decision from verified_by/reason_code once the finding carries one', () => {
    const finding = toFinding({
      ...findingFixture,
      finding_status: 'NEGATIVE_VERIFIED',
      decision: {
        status: 'NEGATIVE_VERIFIED',
        reason_code: 'APPROVED_CHANGE',
        comment: 'Согласовано письмом №12',
        inspector: { id: 'user-1', full_name: 'Смирнов А.В.' },
        decided_at: '2025-11-14T10:42:00.000Z',
      },
    });
    expect(finding.decision).toEqual({
      status: 'NEGATIVE_VERIFIED',
      reasonCode: 'APPROVED_CHANGE',
      comment: 'Согласовано письмом №12',
      inspector: 'Смирнов А.В.',
      timestamp: expect.any(String),
    });
  });

  it('leaves decision undefined when the finding has none', () => {
    const finding = toFinding(findingFixture);
    expect(finding.decision).toBeUndefined();
  });
});

describe('toProjectObject', () => {
  const objectFixture: ApiObjectListItem = {
    id: 'obj-1',
    name: 'Школа №1',
    address: 'г. Москва, ул. Примерная, д. 1',
    customer: 'ГБУ «Мосстройразвитие»',
    contractor: 'ООО «Подрядчик»',
    permit_number: 'РС-77-000000-2025',
    completeness: { pd: 'UPLOADED', rd: 'PARTIAL', id: null },
    process_status: 'READY',
    latest_process_id: 'proc-1',
    latest_protocol_id: 'proto-1',
    candidates: 2,
    confirmed: 1,
    updated_at: '2025-11-14T10:22:00.000Z',
    indicator: 'yellow',
  };

  it('maps customer to developer and permit_number to permit', () => {
    const object = toProjectObject(objectFixture);
    expect(object.developer).toBe('ГБУ «Мосстройразвитие»');
    expect(object.contractor).toBe('ООО «Подрядчик»');
    expect(object.permit).toBe('РС-77-000000-2025');
  });

  it('maps StageCompleteness values to the interface completeness vocabulary', () => {
    const object = toProjectObject(objectFixture);
    expect(object.completeness).toEqual({ PD: 'full', RD: 'partial', ID: 'missing' });
  });

  it('maps NOT_APPLICABLE completeness', () => {
    const object = toProjectObject({
      ...objectFixture,
      completeness: { pd: 'NOT_APPLICABLE', rd: 'UPLOADED', id: 'UPLOADED' },
    });
    expect(object.completeness.PD).toBe('not_applicable');
  });

  it('falls back to PENDING when the object has no process yet', () => {
    const object = toProjectObject({ ...objectFixture, process_status: null });
    expect(object.processStatus).toBe('PENDING');
  });

  it('carries the indicator color through unchanged', () => {
    const object = toProjectObject(objectFixture);
    expect(object.indicator).toBe('yellow');
  });
});

describe('toUploadedFile', () => {
  it('formats size in megabytes and revision with the "Ред." prefix', () => {
    const file = toUploadedFile({
      id: 'file-1',
      file_name: 'АР-01.pdf',
      doc_stage: 'PD',
      discipline: 'АР',
      document_code: 'АНО/150321/1-П-АР',
      revision: '2',
      approval_status: 'APPROVED',
      page_count: 21,
      size_bytes: 2 * 1024 * 1024,
      file_sha256: 'b'.repeat(64),
      from_manifest: false,
      uploaded_at: '2025-11-14T10:22:00.000Z',
      process_id: 'proc-1',
    });
    expect(file.stage).toBe('PD');
    expect(file.size).toBe('2.0 МБ');
    expect(file.revision).toBe('Ред. 2');
    expect(file.sheets).toBe(21);
  });
});

describe('toDashboardSummary', () => {
  it('maps every counter', () => {
    const summary = toDashboardSummary({
      objects_in_work: 12,
      awaiting_verification: 4,
      candidates_to_review: 37,
      finalized_this_month: 8,
    });
    expect(summary).toEqual({
      objectsInWork: 12,
      awaitingVerification: 4,
      candidatesToReview: 37,
      finalizedThisMonth: 8,
    });
  });
});

describe('toProtocol', () => {
  const protocolFixture: ApiProtocol = {
    id: 'protocol-1',
    object_id: 'obj-1',
    process_id: 'proc-1',
    version: 1,
    status: 'READY',
    sync_status: null,
    matrix_version: '1.1',
    model_version: 'rules-2026.09',
    dataset_version: 'none',
    input_manifest_hash: 'c'.repeat(64),
    created_at: '2025-11-14T10:14:00.000Z',
    finalized_at: null,
    summary: {
      checked: 3, candidates: 1, confirmed: 0, negative: 1,
      missing_evidence: 0, not_applicable: 0, not_comparable: 1,
      clarification_required: 0,
    },
    completeness: [],
    findings: [findingFixture],
  };

  it('maps summary counters and findings', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.summary.checked).toBe(3);
    expect(protocol.summary.candidates).toBe(1);
    expect(protocol.summary.negative).toBe(1);
    expect(protocol.findings).toHaveLength(1);
    expect(protocol.findings[0].id).toBe('check-1');
  });

  it('carries technical versions and the input manifest hash through', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.matrixVersion).toBe('1.1');
    expect(protocol.modelVersion).toBe('rules-2026.09');
    expect(protocol.datasetVersion).toBe('none');
    expect(protocol.hash).toBe('c'.repeat(64));
  });
});
