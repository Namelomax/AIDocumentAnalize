// Renders the shared ExportDocument (model.ts) to PDF bytes with pdfkit.
//
// Cyrillic pitfall (task spec): pdfkit's built-in fonts (Helvetica, Times…)
// carry no Cyrillic glyphs at all - a document built with them "succeeds"
// and opens, but every Russian word is empty boxes. DejaVu Sans is embedded
// from assets/fonts (shipped in the repo, not fetched) specifically because
// the API image is built and runs with no internet access - there would be
// nowhere to download a substitute font from at build or run time.
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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

const here = path.dirname(fileURLToPath(import.meta.url));
// Two levels up from src/export/ (or dist/export/ once built) is the
// package root, where assets/ sits next to src/ and dist/ alike - the same
// relative path resolves correctly in dev (tsx), in tests (vitest) and in
// the production image (dist/export/pdf.js -> /app/assets/fonts).
const FONT_REGULAR = path.join(here, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(here, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

const PAGE_MARGIN = 36;

function formatDate(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().replace('T', ' ').slice(0, 19);
}

function formatValue(value: string | null, unit: string | null): string {
  if (value === null) return '—';
  return unit ? `${value} ${unit}` : value;
}

// Wraps a running PDFDocument with the layout helpers every section below
// draws with - column-free, manual y bookkeeping, because pdfkit has no
// built-in table/flow primitive that copes with per-row variable height.
class Layout {
  doc: PDFKit.PDFDocument;
  left: number;
  right: number;
  width: number;

  constructor(doc: PDFKit.PDFDocument) {
    this.doc = doc;
    this.left = doc.page.margins.left;
    this.right = doc.page.width - doc.page.margins.right;
    this.width = this.right - this.left;
  }

  private bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  ensureSpace(height: number): void {
    if (this.doc.y + height > this.bottom()) this.doc.addPage();
  }

  heading(text: string, size = 13): void {
    this.ensureSpace(size + 10);
    this.doc.font('bold').fontSize(size).fillColor('#0F172A').text(text, this.left, this.doc.y, { width: this.width });
    this.doc.moveDown(0.4);
  }

  subheading(text: string): void {
    this.ensureSpace(20);
    this.doc.font('bold').fontSize(10).fillColor('#1B4E9B').text(text, this.left, this.doc.y, { width: this.width });
    this.doc.moveDown(0.2);
  }

  paragraph(text: string, opts: { size?: number; color?: string; italic?: boolean } = {}): void {
    const size = opts.size ?? 9;
    const height = this.doc.font('body').fontSize(size).heightOfString(text, { width: this.width });
    this.ensureSpace(height + 4);
    this.doc
      .font('body')
      .fontSize(size)
      .fillColor(opts.color ?? '#0F172A')
      .text(text, this.left, this.doc.y, { width: this.width });
    this.doc.moveDown(0.2);
  }

  // A "Label: value" line, label in bold, value in the regular weight - the
  // one shape every evidence/decision field below uses.
  field(labelText: string, value: string): void {
    const prefix = `${labelText}: `;
    const size = 8.5;
    this.doc.font('bold').fontSize(size);
    const prefixWidth = this.doc.widthOfString(prefix);
    const full = `${prefix}${value}`;
    const height = this.doc.heightOfString(full, { width: this.width });
    this.ensureSpace(height + 2);
    const y = this.doc.y;
    this.doc.font('bold').fontSize(size).fillColor('#475569').text(prefix, this.left, y, { continued: true, width: this.width });
    this.doc.font('body').fontSize(size).fillColor('#0F172A').text(value, { width: this.width - prefixWidth });
    this.doc.moveDown(0.1);
  }

  rule(): void {
    this.ensureSpace(8);
    const y = this.doc.y + 2;
    this.doc.moveTo(this.left, y).lineTo(this.right, y).lineWidth(0.5).strokeColor('#E2E8F0').stroke();
    this.doc.y = y + 6;
  }

  spacer(height = 6): void {
    this.doc.y += height;
  }
}

interface Column {
  header: string;
  width: number;
}

// A compact, one-row-per-record table for tables 1 and 4 (task spec: those
// two can run to 100+ rows each in the reference package, and only a card
// per row would make the PDF unusable). Word-wraps within each cell and
// grows the row to the tallest cell instead of truncating, so nothing here
// silently drops information the way a fixed-height row would.
function drawTable(layout: Layout, columns: Column[], rows: string[][]): void {
  const { doc, left } = layout;
  const totalWidth = columns.reduce((sum, c) => sum + c.width, 0);
  const cellPad = 3;

  function drawHeaderRow(): void {
    layout.ensureSpace(20);
    doc.font('bold').fontSize(8).fillColor('#475569');
    const y = doc.y;
    let x = left;
    for (const col of columns) {
      doc.text(col.header, x + cellPad, y + cellPad, { width: col.width - cellPad * 2 });
      x += col.width;
    }
    const headerHeight = 16;
    doc
      .moveTo(left, y + headerHeight)
      .lineTo(left + totalWidth, y + headerHeight)
      .lineWidth(0.7)
      .strokeColor('#94A3B8')
      .stroke();
    doc.y = y + headerHeight + 2;
  }

  drawHeaderRow();
  doc.font('body').fontSize(8).fillColor('#0F172A');

  for (const row of rows) {
    let maxHeight = 10;
    for (let i = 0; i < columns.length; i += 1) {
      const h = doc.heightOfString(row[i] ?? '—', { width: columns[i].width - cellPad * 2 });
      if (h > maxHeight) maxHeight = h;
    }
    const rowHeight = maxHeight + cellPad * 2;

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      drawHeaderRow();
      doc.font('body').fontSize(8).fillColor('#0F172A');
    }

    const y = doc.y;
    let x = left;
    for (let i = 0; i < columns.length; i += 1) {
      doc.text(row[i] ?? '—', x + cellPad, y + cellPad, { width: columns[i].width - cellPad * 2 });
      x += columns[i].width;
    }
    doc.y = y + rowHeight;
    doc
      .moveTo(left, doc.y)
      .lineTo(left + totalWidth, doc.y)
      .lineWidth(0.3)
      .strokeColor('#E2E8F0')
      .stroke();
    doc.y += 1;
  }
  layout.spacer(10);
}

function drawEvidence(layout: Layout, evidence: EvidenceView[]): void {
  if (evidence.length === 0) {
    layout.field('Доказательства', 'нет прикреплённых источников');
    return;
  }
  evidence.forEach((fragment, index) => {
    layout.ensureSpace(90);
    layout.doc
      .font('bold')
      .fontSize(8.5)
      .fillColor('#1B4E9B')
      .text(
        `Источник ${index + 1} — ${label(evidenceRoleLabels, fragment.role, fragment.role)}`,
        layout.left,
        layout.doc.y,
        { width: layout.width },
      );
    layout.doc.moveDown(0.1);
    layout.field('file_id', fragment.file_id);
    layout.field('SHA-256', fragment.file_sha256);
    layout.field('Стадия', fragment.stage);
    layout.field('Шифр документа', fragment.document_code ?? '—');
    layout.field('Редакция', fragment.revision ?? '—');
    layout.field('Статус утверждения', fragment.approval_status);
    layout.field('Лист/страница', String(fragment.sheet_page));
    layout.field('Bbox (норм. координаты)', fragment.bbox.map((v) => v.toFixed(4)).join(', '));
    layout.field('Извлечённое значение', fragment.extracted_value ?? '—');
    layout.spacer(2);
  });
}

function drawDecision(layout: Layout, decision: DecisionView | null): void {
  if (!decision) {
    layout.field('Решение инспектора', 'не вынесено');
    return;
  }
  layout.field('Решение инспектора', label(statusLabels, decision.status, decision.status ?? '—'));
  layout.field('Причина отклонения', decision.reason_code ? label(reasonLabels, decision.reason_code) : '—');
  layout.field('Комментарий инспектора', decision.comment ?? '—');
  layout.field('Инспектор', decision.inspector.full_name ?? decision.inspector.id);
  layout.field('Дата решения', formatDate(decision.decided_at));
}

function drawFindingCard(layout: Layout, finding: FindingView, extra?: { detectionMethod: string | null; confidence: number | null }): void {
  layout.ensureSpace(30);
  layout.doc.font('bold').fontSize(10).fillColor('#0F172A').text(finding.title, layout.left, layout.doc.y, { width: layout.width });
  layout.doc.moveDown(0.15);

  layout.field('Идентификатор находки', finding.id);
  layout.field('Код параметра', finding.param_code);
  layout.field('Раздел матрицы', finding.section ?? '—');
  layout.field('Ожидаемое значение', formatValue(finding.expected_value, finding.unit));
  layout.field('Фактическое значение', formatValue(finding.actual_value, finding.unit));
  layout.field('Отклонение (Δ)', finding.delta ?? '—');
  layout.field('Нормативная ссылка', finding.norm_reference ?? '—');
  layout.field('Обоснование', finding.rationale ?? '—');
  // Never phrased as a risk/severity of the violation itself - see the
  // Param.reviewPriority comment in schema.prisma and the task spec.
  layout.field('Очерёдность проверки (не оценка нарушения)', finding.review_priority);
  layout.field('Статус находки', label(statusLabels, finding.finding_status, finding.finding_status ?? '—'));
  if (extra) {
    layout.field('Способ обнаружения', label(detectionMethodLabels, extra.detectionMethod, extra.detectionMethod ?? '—'));
    layout.field('Уверенность модели', extra.confidence !== null ? extra.confidence.toFixed(2) : '—');
  }
  layout.spacer(2);
  drawDecision(layout, finding.decision);
  layout.spacer(2);
  layout.doc.font('bold').fontSize(9).fillColor('#475569').text('Доказательства:', layout.left, layout.doc.y);
  layout.doc.moveDown(0.1);
  drawEvidence(layout, finding.evidence);
  layout.rule();
  layout.spacer(4);
}

function drawEmpty(layout: Layout, text: string): void {
  layout.paragraph(text, { color: '#94A3B8', italic: true });
  layout.spacer(6);
}

export async function renderProtocolPdf(document: ExportDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PAGE_MARGIN, bottom: PAGE_MARGIN, left: PAGE_MARGIN, right: PAGE_MARGIN },
      bufferPages: true,
      info: { Title: `Протокол проверки № ${document.protocol_number}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('body', FONT_REGULAR);
    doc.registerFont('bold', FONT_BOLD);
    doc.font('body');

    const layout = new Layout(doc);
    const p = document.protocol;

    layout.heading(`Протокол проверки № ${document.protocol_number}`, 16);
    layout.paragraph(`Объект: ${document.object_name}`, { size: 10 });
    layout.paragraph(
      `Статус: ${label(protocolStatusLabels, p.status, p.status)} · Версия: ${p.version} · Создан: ${formatDate(p.created_at)}`,
    );
    if (p.finalized_at) {
      layout.paragraph(
        `Финализирован: ${formatDate(p.finalized_at)}${document.finalized_by_name ? ` · Кем: ${document.finalized_by_name}` : ''}`,
      );
    }
    layout.paragraph(
      `matrix_version ${p.matrix_version} · model_version ${p.model_version} · dataset_version ${p.dataset_version}`,
      { size: 8, color: '#64748B' },
    );
    layout.paragraph(`input_manifest_hash: ${p.input_manifest_hash}`, { size: 8, color: '#64748B' });
    layout.spacer(6);

    // Section 9.2: "Статус загрузки документов" and "Тип проверки".
    layout.subheading('Статус загрузки документов');
    layout.paragraph(
      `ПД: ${label(stageCompletenessLabels, document.pd_completeness, 'нет данных')} · ` +
        `РД: ${label(stageCompletenessLabels, document.rd_completeness, 'нет данных')} · ` +
        `ИД: ${label(stageCompletenessLabels, document.id_completeness, 'нет данных')}`,
    );
    layout.subheading('Тип проверки (сценарий загрузки)');
    layout.paragraph(document.scenario ? label(scenarioLabels, document.scenario, document.scenario) : 'нет данных');
    layout.spacer(4);

    const s = document.summary;
    layout.subheading('Сводка');
    layout.paragraph(
      `Проверено параметров: ${s.checked} · Кандидатов: ${s.candidates} · Подтверждено: ${s.confirmed} · ` +
        `Расхождений не выявлено: ${s.negative} · Без доказательств: ${s.missing_evidence} · Неприменимо: ${s.not_applicable} · ` +
        `Нельзя сопоставить: ${s.not_comparable} · Требует уточнения: ${s.clarification_required} · Гипотез: ${s.suspicions}`,
    );
    layout.spacer(6);
    layout.paragraph(
      'Очерёдность проверки (review_priority) определяет только порядок рассмотрения инспектором и нигде в этом протоколе не является оценкой тяжести или статусом нарушения.',
      { size: 8, color: '#94A3B8' },
    );
    layout.rule();
    layout.spacer(6);

    // Table 1: completeness and comparability - compact, can run to 100+ rows.
    layout.heading('1. Комплектность и сопоставимость', 12);
    if (document.completeness.length === 0) {
      drawEmpty(layout, 'Нет записей с проблемами комплектности или сопоставимости.');
    } else {
      drawTable(
        layout,
        [
          { header: 'Код', width: 60 },
          { header: 'Наименование параметра', width: 210 },
          { header: 'Статус', width: 110 },
          { header: 'Обоснование', width: layout.width - 60 - 210 - 110 },
        ],
        document.completeness.map((row) => [
          row.param_code,
          row.parameter_name ?? row.param_code,
          label(statusLabels, row.completeness_status, row.completeness_status),
          row.rationale ?? '—',
        ]),
      );
    }
    layout.spacer(8);

    // Table 2: preliminary candidates - a full evidence card each.
    layout.heading(`2. Предварительные кандидаты (${document.candidates.length})`, 12);
    if (document.candidates.length === 0) {
      drawEmpty(layout, 'Кандидатов нет.');
    } else {
      document.candidates.forEach((finding) => drawFindingCard(layout, finding));
    }
    layout.spacer(8);

    // Table 3: violations the inspector confirmed - a full evidence card each.
    layout.heading(`3. Подтверждённые инспектором нарушения (${document.confirmed.length})`, 12);
    if (document.confirmed.length === 0) {
      drawEmpty(layout, 'Подтверждённых нарушений нет.');
    } else {
      document.confirmed.forEach((finding) => drawFindingCard(layout, finding));
    }
    layout.spacer(8);

    // Table 4: checked, no discrepancy - compact, can run to 100+ rows.
    layout.heading(`4. Проверенные отрицательные результаты (${document.negative.length})`, 12);
    if (document.negative.length === 0) {
      drawEmpty(layout, 'Нет проверенных отрицательных результатов.');
    } else {
      drawTable(
        layout,
        [
          { header: 'Код', width: 55 },
          { header: 'Параметр', width: 175 },
          { header: 'Ожидается', width: 70 },
          { header: 'Фактически', width: 70 },
          { header: 'Источники', width: 60 },
          { header: 'Кем проверено', width: layout.width - 55 - 175 - 70 - 70 - 60 },
        ],
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
      );
    }
    layout.spacer(8);

    // Not one of the customer's five named tables (see model.ts) - shown
    // only when non-empty, right after the tables an inspector expects.
    if (document.clarification.length > 0) {
      layout.heading(`Требует уточнения (${document.clarification.length})`, 12);
      document.clarification.forEach((finding) => drawFindingCard(layout, finding));
      layout.spacer(8);
    }

    // Table 5: free-search hypotheses - a full card each (Global Constraint:
    // a hypothesis is never a violation, but it still needs its evidence).
    layout.heading(`5. Гипотезы свободного поиска (${document.suspicions.length})`, 12);
    layout.paragraph(
      'Гипотезы не входят в число нарушений и не используются для обучения модели (Общее ограничение ТЗ).',
      { size: 8, color: '#94A3B8' },
    );
    if (document.suspicions.length === 0) {
      drawEmpty(layout, 'Гипотез нет.');
    } else {
      document.suspicions.forEach((suspicion) =>
        drawFindingCard(layout, suspicion, { detectionMethod: suspicion.detection_method, confidence: suspicion.confidence }),
      );
    }

    doc.end();
  });
}
