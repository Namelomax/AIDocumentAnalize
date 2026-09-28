import { describe, expect, it } from 'vitest';
import {
  toCompletenessRow,
  toDashboardSummary,
  toEvidenceFragment,
  toFinding,
  toProgress,
  toProjectObject,
  toProtocol,
  toSuspicion,
  toSuspicionListItem,
  toUploadedFile,
  type ApiCompletenessRow,
  type ApiEvidence,
  type ApiFinding,
  type ApiObjectListItem,
  type ApiProgress,
  type ApiProtocol,
  type ApiSuspicion,
  type ApiSuspicionListItem,
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

  it('leaves composite undefined for an ordinary, atomic finding', () => {
    const finding = toFinding(findingFixture);
    expect(finding.composite).toBeUndefined();
  });

  it('maps an unsplit composite candidate into finding.composite.atoms', () => {
    const finding = toFinding({
      ...findingFixture,
      title: 'Полезная / Расчетная площадь — помещения 134–149',
      unit: 'м²',
      composite: {
        atoms: [
          {
            id: 'atom-1', param_code: 'M-003', title: 'помещение 134',
            expected_value: '15.00', actual_value: '14.00', delta: '-1.00',
          },
          {
            id: 'atom-2', param_code: 'M-003', title: 'помещение 149',
            expected_value: '15.00', actual_value: '14.00', delta: '-1.00',
          },
        ],
      },
    });

    expect(finding.composite).toBeDefined();
    expect(finding.composite?.atoms).toHaveLength(2);
    expect(finding.composite?.atoms[0]).toEqual({
      id: 'atom-1', code: 'M-003', title: 'помещение 134',
      expected: '15.00 м²', actual: '14.00 м²', delta: '-1.00',
    });
  });
});

describe('toSuspicion', () => {
  const suspicionFixture: ApiSuspicion = {
    ...findingFixture,
    id: 'check-suspicion',
    param_code: 'SEM-ROOM-FN',
    finding_status: 'SUSPICION',
    detection_method: 'SEMANTIC',
    confidence: 0.9,
  };

  it('carries a suspicion in the shape of a finding, plus its detection method and confidence', () => {
    const suspicion = toSuspicion(suspicionFixture);
    expect(suspicion.id).toBe('check-suspicion');
    expect(suspicion.status).toBe('SUSPICION');
    expect(suspicion.detectionMethod).toBe('semantic');
    expect(suspicion.confidence).toBe(0.9);
  });

  it('maps every engine detection method to the interface vocabulary', () => {
    expect(toSuspicion({ ...suspicionFixture, detection_method: 'LOGICAL' }).detectionMethod).toBe('logical');
    expect(toSuspicion({ ...suspicionFixture, detection_method: 'NORMATIVE' }).detectionMethod).toBe('normative');
    expect(toSuspicion({ ...suspicionFixture, detection_method: 'ML' }).detectionMethod).toBe('ml');
  });

  it('leaves detectionMethod and confidence undefined when the engine reported none', () => {
    const suspicion = toSuspicion({ ...suspicionFixture, detection_method: null, confidence: null });
    expect(suspicion.detectionMethod).toBeUndefined();
    expect(suspicion.confidence).toBeUndefined();
  });
});

describe('toSuspicionListItem', () => {
  it('carries the object and protocol a hypothesis belongs to, alongside its finding fields', () => {
    const fixture: ApiSuspicionListItem = {
      ...findingFixture,
      id: 'check-suspicion',
      finding_status: 'SUSPICION',
      detection_method: 'SEMANTIC',
      confidence: 0.9,
      object_id: 'obj-1',
      object_name: 'Школа №1',
      protocol_id: 'protocol-1',
    };
    const item = toSuspicionListItem(fixture);
    expect(item.objectId).toBe('obj-1');
    expect(item.objectName).toBe('Школа №1');
    expect(item.protocolId).toBe('protocol-1');
    expect(item.detectionMethod).toBe('semantic');
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

describe('toCompletenessRow', () => {
  const completenessFixture: ApiCompletenessRow = {
    param_code: 'M-014',
    parameter_name: 'Площадь МОП',
    completeness_status: 'NOT_COMPARABLE',
    rationale: 'В РД раздел ПЗ отсутствует',
  };

  it('maps a completeness row to camelCase, separately from a finding', () => {
    const row = toCompletenessRow(completenessFixture);
    expect(row).toEqual({
      paramCode: 'M-014',
      parameterName: 'Площадь МОП',
      status: 'NOT_COMPARABLE',
      rationale: 'В РД раздел ПЗ отсутствует',
    });
  });

  it('falls back to the param code when the parameter has no name', () => {
    const row = toCompletenessRow({ ...completenessFixture, parameter_name: null });
    expect(row.parameterName).toBe('M-014');
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
    completeness: [
      { param_code: 'M-014', parameter_name: 'Площадь МОП', completeness_status: 'NOT_COMPARABLE', rationale: null },
    ],
    findings: [findingFixture],
  };

  it('maps summary counters and findings', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.summary.checked).toBe(3);
    expect(protocol.summary.candidates).toBe(1);
    expect(protocol.summary.negative).toBe(1);
    expect(protocol.summary.notComparable).toBe(1);
    expect(protocol.summary.clarificationRequired).toBe(0);
    expect(protocol.findings).toHaveLength(1);
    expect(protocol.findings[0].id).toBe('check-1');
  });

  it('keeps completeness rows in their own list, separate from findings', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.completeness).toHaveLength(1);
    expect(protocol.completeness[0].paramCode).toBe('M-014');
    expect(protocol.findings.every((f) => f.code !== 'M-014')).toBe(true);
  });

  it('maps status, sync_status and finalized_at', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.status).toBe('READY');
    expect(protocol.syncStatus).toBeNull();
    expect(protocol.finalizedAt).toBeNull();
  });

  it('formats finalized_at when the protocol was finalized', () => {
    const protocol = toProtocol({
      ...protocolFixture,
      status: 'PROTOCOL_FINALIZED',
      finalized_at: '2025-11-14T12:00:00.000Z',
    });
    expect(protocol.status).toBe('PROTOCOL_FINALIZED');
    expect(protocol.finalizedAt).toEqual(expect.any(String));
  });

  it('carries technical versions and the input manifest hash through', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.matrixVersion).toBe('1.1');
    expect(protocol.modelVersion).toBe('rules-2026.09');
    expect(protocol.datasetVersion).toBe('none');
    expect(protocol.hash).toBe('c'.repeat(64));
  });

  it('reads suspicions into their own section, separate from findings', () => {
    const protocol = toProtocol({
      ...protocolFixture,
      summary: { ...protocolFixture.summary, suspicions: 1 },
      suspicions: [{ ...findingFixture, id: 'check-suspicion', detection_method: 'ML', confidence: 0.8 }],
    });
    // A hypothesis is never a finding (Global Constraint) — it must not
    // appear in `findings`, only in its own `suspicions` section.
    expect(protocol.findings).toHaveLength(1);
    expect(protocol.findings.some((f) => f.id === 'check-suspicion')).toBe(false);
    expect(protocol.suspicions).toHaveLength(1);
    expect(protocol.suspicions[0]).toMatchObject({ id: 'check-suspicion', detectionMethod: 'ml', confidence: 0.8 });
  });

  it('defaults suspicions to an empty list when the response has none', () => {
    const protocol = toProtocol(protocolFixture);
    expect(protocol.suspicions).toEqual([]);
  });
});

describe('toProgress', () => {
  const progressFixture: ApiProgress = {
    status: 'PARSING',
    files: { total: 5, pdf: 4 },
    pages: { extracted: 12, needs_ocr: 2 },
    checks: { total: 0, candidates: 0 },
    protocol_id: null,
  };

  it('maps every counter to camelCase', () => {
    const progress = toProgress(progressFixture);
    expect(progress).toEqual({
      status: 'PARSING',
      filesTotal: 5,
      filesPdf: 4,
      pagesExtracted: 12,
      pagesNeedsOcr: 2,
      checksTotal: 0,
      checksCandidates: 0,
      protocolId: null,
    });
  });

  it('carries the protocol id through once the pipeline creates one', () => {
    const progress = toProgress({ ...progressFixture, status: 'READY', protocol_id: 'protocol-1' });
    expect(progress.status).toBe('READY');
    expect(progress.protocolId).toBe('protocol-1');
  });
});
