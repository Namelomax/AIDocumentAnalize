// Renders the shared ExportDocument (model.ts) to a .docx with the `docx`
// package. Unlike pdf.ts, no font has to be embedded here: a .docx stores
// its text as plain Unicode XML (word/document.xml) and leaves rendering to
// whatever font Word/LibreOffice picks at open time - Times New Roman ships
// with Cyrillic on every platform this is likely to be opened on, so it is
// named explicitly below rather than left to the library's default.
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, BorderStyle } from 'docx';
import type { DecisionView, EvidenceView, FindingView, SuspicionView } from '../protocol/view.js';
import type { ExportDocument } from './model.js';
import {
  detectionMethodLabels,
  evidenceRoleLabels,
  label,
  protocolStatusLabels,
  reasonLabels,
  scenarioLabels,
  stageCompletenessLabels,
  statusLabels,
} from './labels.js';

const FONT = 'Times New Roman';

function formatDate(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

function formatValue(value: string | null, unit: string | null): string {
  if (value === null) return '—';
  return unit ? `${value} ${unit}` : value;
}

function heading(text: string, level: (typeof HeadingLevel)[keyof typeof HeadingLevel]): Paragraph {
  return new Paragraph({ heading: level, children: [new TextRun({ text, font: FONT })] });
}

function paragraph(text: string, opts: { italic?: boolean; size?: number; color?: string } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, italics: opts.italic, size: opts.size, color: opts.color })],
    spacing: { after: 80 },
  });
}

// "Label: value" run pair - the one shape every evidence/decision field
// below uses, matching pdf.ts's own `field()`.
function field(labelText: string, value: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text: `${labelText}: `, bold: true, font: FONT, size: 18 }),
      new TextRun({ text: value, font: FONT, size: 18 }),
    ],
    spacing: { after: 40 },
  });
}

function evidenceParagraphs(evidence: EvidenceView[]): Paragraph[] {
  if (evidence.length === 0) return [field('Доказательства', 'нет прикреплённых источников')];
  const out: Paragraph[] = [];
  evidence.forEach((fragment, index) => {
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Источник ${index + 1} — ${label(evidenceRoleLabels, fragment.role, fragment.role)}`,
            bold: true,
            font: FONT,
            size: 19,
            color: '1B4E9B',
          }),
        ],
        spacing: { before: 60, after: 40 },
      }),
    );
    out.push(field('file_id', fragment.file_id));
    out.push(field('SHA-256', fragment.file_sha256));
    out.push(field('Стадия', fragment.stage));
    out.push(field('Шифр документа', fragment.document_code ?? '—'));
    out.push(field('Редакция', fragment.revision ?? '—'));
    out.push(field('Статус утверждения', fragment.approval_status));
    out.push(field('Лист/страница', String(fragment.sheet_page)));
    out.push(field('Bbox (норм. координаты)', fragment.bbox.map((v) => v.toFixed(4)).join(', ')));
    out.push(field('Извлечённое значение', fragment.extracted_value ?? '—'));
  });
  return out;
}

function decisionParagraphs(decision: DecisionView | null): Paragraph[] {
  if (!decision) return [field('Решение инспектора', 'не вынесено')];
  return [
    field('Решение инспектора', label(statusLabels, decision.status, decision.status ?? '—')),
    field('Причина отклонения', decision.reason_code ? label(reasonLabels, decision.reason_code) : '—'),
    field('Комментарий инспектора', decision.comment ?? '—'),
    field('Инспектор', decision.inspector.full_name ?? decision.inspector.id),
    field('Дата решения', formatDate(decision.decided_at)),
  ];
}

function findingCard(
  finding: FindingView,
  extra?: { detectionMethod: string | null; confidence: number | null },
): Paragraph[] {
  const out: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: finding.title, bold: true, font: FONT, size: 22 })],
      spacing: { before: 160, after: 60 },
    }),
    field('Идентификатор находки', finding.id),
    field('Код параметра', finding.param_code),
    field('Раздел матрицы', finding.section ?? '—'),
    field('Ожидаемое значение', formatValue(finding.expected_value, finding.unit)),
    field('Фактическое значение', formatValue(finding.actual_value, finding.unit)),
    field('Отклонение (Δ)', finding.delta ?? '—'),
    field('Нормативная ссылка', finding.norm_reference ?? '—'),
    field('Обоснование', finding.rationale ?? '—'),
    // Never phrased as a risk/severity of the violation - see schema.prisma's
    // Param.reviewPriority comment and the task spec.
    field('Очерёдность проверки (не оценка нарушения)', finding.review_priority),
    field('Статус находки', label(statusLabels, finding.finding_status, finding.finding_status ?? '—')),
  ];
  if (extra) {
    out.push(field('Способ обнаружения', label(detectionMethodLabels, extra.detectionMethod, extra.detectionMethod ?? '—')));
    out.push(field('Уверенность модели', extra.confidence !== null ? extra.confidence.toFixed(2) : '—'));
  }
  out.push(...decisionParagraphs(finding.decision));
  out.push(
    new Paragraph({
      children: [new TextRun({ text: 'Доказательства:', bold: true, font: FONT, size: 19, color: '475569' })],
      spacing: { before: 60, after: 40 },
    }),
  );
  out.push(...evidenceParagraphs(finding.evidence));
  return out;
}

function headerCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, font: FONT, size: 17 })] })],
    shading: { fill: 'EDF1F7' },
  });
}

function bodyCell(text: string): TableCell {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: text || '—', font: FONT, size: 17 })] })],
  });
}

// A compact one-row-per-record table for tables 1 and 4 (task spec: those
// two can run to 100+ rows in the reference package - a card per row would
// make the document unusable).
function compactTable(headers: string[], rows: string[][]): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
      left: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
      right: { style: BorderStyle.SINGLE, size: 2, color: 'CBD5E1' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'E2E8F0' },
    },
    rows: [
      new TableRow({ children: headers.map(headerCell), tableHeader: true }),
      ...rows.map((row) => new TableRow({ children: row.map(bodyCell) })),
    ],
  });
}

function emptyNote(text: string): Paragraph {
  return paragraph(text, { italic: true, size: 18, color: '94A3B8' });
}

export async function renderProtocolDocx(document: ExportDocument): Promise<Buffer> {
  const p = document.protocol;
  const s = document.summary;

  const children: (Paragraph | Table)[] = [];

  children.push(heading(`Протокол проверки № ${document.protocol_number}`, HeadingLevel.TITLE));
  children.push(paragraph(`Объект: ${document.object_name}`, { size: 22 }));
  children.push(
    paragraph(
      `Статус: ${label(protocolStatusLabels, p.status, p.status)} · Версия: ${p.version} · Создан: ${formatDate(p.created_at)}`,
    ),
  );
  if (p.finalized_at) {
    children.push(
      paragraph(
        `Финализирован: ${formatDate(p.finalized_at)}${document.finalized_by_name ? ` · Кем: ${document.finalized_by_name}` : ''}`,
      ),
    );
  }
  children.push(
    paragraph(`matrix_version ${p.matrix_version} · model_version ${p.model_version} · dataset_version ${p.dataset_version}`, {
      size: 16,
      color: '64748B',
    }),
  );
  children.push(paragraph(`input_manifest_hash: ${p.input_manifest_hash}`, { size: 16, color: '64748B' }));

  // Section 9.2: "Статус загрузки документов" and "Тип проверки".
  children.push(heading('Статус загрузки документов', HeadingLevel.HEADING_2));
  children.push(
    paragraph(
      `ПД: ${label(stageCompletenessLabels, document.pd_completeness, 'нет данных')} · ` +
        `РД: ${label(stageCompletenessLabels, document.rd_completeness, 'нет данных')} · ` +
        `ИД: ${label(stageCompletenessLabels, document.id_completeness, 'нет данных')}`,
    ),
  );
  children.push(heading('Тип проверки (сценарий загрузки)', HeadingLevel.HEADING_2));
  children.push(paragraph(document.scenario ? label(scenarioLabels, document.scenario, document.scenario) : 'нет данных'));

  children.push(heading('Сводка', HeadingLevel.HEADING_2));
  children.push(
    paragraph(
      `Проверено параметров: ${s.checked} · Кандидатов: ${s.candidates} · Подтверждено: ${s.confirmed} · ` +
        `Расхождений не выявлено: ${s.negative} · Без доказательств: ${s.missing_evidence} · Неприменимо: ${s.not_applicable} · ` +
        `Нельзя сопоставить: ${s.not_comparable} · Требует уточнения: ${s.clarification_required} · Гипотез: ${s.suspicions}`,
    ),
  );
  children.push(
    paragraph(
      'Очерёдность проверки (review_priority) определяет только порядок рассмотрения инспектором и нигде в этом протоколе не является оценкой тяжести или статусом нарушения.',
      { size: 16, color: '94A3B8', italic: true },
    ),
  );

  children.push(heading('1. Комплектность и сопоставимость', HeadingLevel.HEADING_1));
  if (document.completeness.length === 0) {
    children.push(emptyNote('Нет записей с проблемами комплектности или сопоставимости.'));
  } else {
    children.push(
      compactTable(
        ['Код', 'Наименование параметра', 'Статус', 'Обоснование'],
        document.completeness.map((row) => [
          row.param_code,
          row.parameter_name ?? row.param_code,
          label(statusLabels, row.completeness_status, row.completeness_status),
          row.rationale ?? '—',
        ]),
      ),
    );
  }

  children.push(heading(`2. Предварительные кандидаты (${document.candidates.length})`, HeadingLevel.HEADING_1));
  if (document.candidates.length === 0) {
    children.push(emptyNote('Кандидатов нет.'));
  } else {
    document.candidates.forEach((finding) => children.push(...findingCard(finding)));
  }

  children.push(heading(`3. Подтверждённые инспектором нарушения (${document.confirmed.length})`, HeadingLevel.HEADING_1));
  if (document.confirmed.length === 0) {
    children.push(emptyNote('Подтверждённых нарушений нет.'));
  } else {
    document.confirmed.forEach((finding) => children.push(...findingCard(finding)));
  }

  children.push(heading(`4. Проверенные отрицательные результаты (${document.negative.length})`, HeadingLevel.HEADING_1));
  if (document.negative.length === 0) {
    children.push(emptyNote('Нет проверенных отрицательных результатов.'));
  } else {
    children.push(
      compactTable(
        ['Код', 'Параметр', 'Ожидается', 'Фактически', 'Источники', 'Кем проверено'],
        document.negative.map((finding) => [
          finding.param_code,
          finding.title,
          formatValue(finding.expected_value, finding.unit),
          formatValue(finding.actual_value, finding.unit),
          finding.sources.join('+') || '—',
          finding.decision
            ? `${finding.decision.inspector.full_name ?? finding.decision.inspector.id}${finding.decision.comment ? `: ${finding.decision.comment}` : ''}`
            : 'Автоматически (движок)',
        ]),
      ),
    );
  }

  // Not one of the customer's five named tables (see model.ts) - shown only
  // when non-empty.
  if (document.clarification.length > 0) {
    children.push(heading(`Требует уточнения (${document.clarification.length})`, HeadingLevel.HEADING_1));
    document.clarification.forEach((finding) => children.push(...findingCard(finding)));
  }

  children.push(heading(`5. Гипотезы свободного поиска (${document.suspicions.length})`, HeadingLevel.HEADING_1));
  children.push(
    paragraph('Гипотезы не входят в число нарушений и не используются для обучения модели (Общее ограничение ТЗ).', {
      size: 16,
      color: '94A3B8',
      italic: true,
    }),
  );
  if (document.suspicions.length === 0) {
    children.push(emptyNote('Гипотез нет.'));
  } else {
    document.suspicions.forEach((suspicion) =>
      children.push(...findingCard(suspicion, { detectionMethod: suspicion.detection_method, confidence: suspicion.confidence })),
    );
  }

  const doc = new Document({
    // Times New Roman on every run by default (see the module comment above)
    // - individual TextRuns above still repeat `font: FONT` so nothing
    // depends on this default alone.
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
