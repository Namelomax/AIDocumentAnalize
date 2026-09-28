// Renders a QualityReportView (quality/reports.ts) to PDF/DOCX. Deliberately
// its own small renderer rather than reusing pdf.ts/docx.ts's protocol
// layout helpers (those are private to their own modules and shaped around
// ExportDocument, a different document entirely) - same Cyrillic approach as
// pdf.ts: DejaVu Sans embedded from assets/fonts, since the api image has no
// internet access to fetch a substitute font at build or run time.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType, BorderStyle } from 'docx';
import type { QualityReportView } from '../quality/reports.js';
import type { MetricsGroup } from '../quality/metrics.js';
import { reasonLabels, label as labelText } from './labels.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(here, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf');
const FONT_BOLD = path.join(here, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');

function fmt(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

function fmtPct(value: number | null): string {
  return value === null ? '—' : `${(value * 100).toFixed(1)}%`;
}

function fmtTrend(value: number | null): string {
  if (value === null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${(value * 100).toFixed(1)} п.п.`;
}

function passText(pass: boolean | null): string {
  if (pass === null) return 'нет данных';
  return pass ? 'выполнен' : 'НЕ выполнен';
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function groupRow(g: MetricsGroup): string[] {
  return [
    g.key,
    `${g.counts.tp}/${g.counts.fp}/${g.counts.fn}/${g.counts.tn}`,
    fmtPct(g.precision.point),
    fmtPct(g.recall.point),
    g.f1 === null ? '—' : fmt(g.f1),
    fmtPct(g.false_positive_rate.point),
    passText(g.pass.overall),
  ];
}

export function qualityReportFilename(report: QualityReportView, format: 'pdf' | 'docx' | 'json'): string {
  return `quality-report-${formatDate(report.period_start)}-${formatDate(report.period_end)}.${format}`;
}

export async function renderQualityReportPdf(report: QualityReportView): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      bufferPages: true,
      info: { Title: 'Еженедельный отчёт по качеству' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('body', FONT_REGULAR);
    doc.registerFont('bold', FONT_BOLD);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;

    doc.font('bold').fontSize(16).fillColor('#0F172A')
      .text('Еженедельный отчёт по качеству', left, doc.y, { width });
    doc.moveDown(0.3);
    doc.font('body').fontSize(10).fillColor('#475569')
      .text(`Период: ${formatDate(report.period_start)} — ${formatDate(report.period_end)}`, left, doc.y, { width });
    doc.moveDown(1);

    const m = report.payload.metrics.overall;
    doc.font('bold').fontSize(12).fillColor('#0F172A').text('Приёмочные метрики (раздел 14.3)', left, doc.y, { width });
    doc.moveDown(0.3);
    const lines = [
      `Precision: ${fmtPct(m.precision.point)} (порог ≥ ${m.thresholds.precisionMin * 100}%) — ${passText(m.pass.precision)}`,
      `Recall: ${fmtPct(m.recall.point)} (порог ≥ ${m.thresholds.recallMin * 100}%) — ${passText(m.pass.recall)}`,
      `F1: ${m.f1 === null ? '—' : fmt(m.f1)} (порог ≥ ${m.thresholds.f1Min}) — ${passText(m.pass.f1)}`,
      `False Positive Rate: ${fmtPct(m.false_positive_rate.point)} (порог ≤ ${m.thresholds.fprMax * 100}%) — ${passText(m.pass.false_positive_rate)}`,
      `Выборка: ${report.payload.metrics.sample_size} GOLD-меток`,
      `Итог: ${passText(m.pass.overall)}`,
    ];
    doc.font('body').fontSize(9.5).fillColor('#0F172A');
    for (const line of lines) { doc.text(line, left, doc.y, { width }); doc.moveDown(0.15); }
    doc.moveDown(0.5);

    doc.font('bold').fontSize(12).fillColor('#0F172A').text('Динамика к предыдущей неделе', left, doc.y, { width });
    doc.moveDown(0.3);
    doc.font('body').fontSize(9.5).fillColor('#0F172A');
    const t = report.payload.trend;
    for (const [label, value] of [['Precision', t.precision], ['Recall', t.recall], ['F1', t.f1], ['FPR', t.false_positive_rate]] as const) {
      doc.text(`${label}: ${fmtTrend(value)}`, left, doc.y, { width });
      doc.moveDown(0.15);
    }
    doc.moveDown(0.5);

    doc.font('bold').fontSize(12).fillColor('#0F172A').text('По модальности', left, doc.y, { width });
    doc.moveDown(0.3);
    doc.font('body').fontSize(8.5).fillColor('#0F172A');
    for (const g of report.payload.metrics.by_modality) {
      doc.text(groupRow(g).join(' · '), left, doc.y, { width });
      doc.moveDown(0.15);
    }
    doc.moveDown(0.5);

    doc.font('bold').fontSize(12).fillColor('#0F172A').text('Причины отклонений инспекторами', left, doc.y, { width });
    doc.moveDown(0.3);
    doc.font('body').fontSize(9.5).fillColor('#0F172A');
    if (report.payload.metrics.rejection_reasons.length === 0) {
      doc.text('Отклонений за период не было.', left, doc.y, { width });
      doc.moveDown(0.15);
    } else {
      for (const r of report.payload.metrics.rejection_reasons) {
        doc.text(`${labelText(reasonLabels, r.reason_code, r.reason_code)}: ${r.count}`, left, doc.y, { width });
        doc.moveDown(0.15);
      }
    }
    doc.moveDown(0.5);

    doc.font('bold').fontSize(12).fillColor('#0F172A').text('Рекомендации по донастройке', left, doc.y, { width });
    doc.moveDown(0.3);
    doc.font('body').fontSize(9.5).fillColor('#0F172A');
    for (const rec of report.payload.recommendations) {
      doc.text(`• ${rec}`, left, doc.y, { width });
      doc.moveDown(0.2);
    }

    doc.end();
  });
}

const FONT = 'Times New Roman';

function para(text: string, opts: { bold?: boolean; size?: number; color?: string } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: FONT, bold: opts.bold, size: opts.size ?? 20, color: opts.color })],
    spacing: { after: 80 },
  });
}

function headerCell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: true, font: FONT, size: 17 })] })], shading: { fill: 'EDF1F7' } });
}
function bodyCell(text: string): TableCell {
  return new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: text || '—', font: FONT, size: 17 })] })] });
}
function table(headers: string[], rows: string[][]): Table {
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
    rows: [new TableRow({ children: headers.map(headerCell), tableHeader: true }), ...rows.map((r) => new TableRow({ children: r.map(bodyCell) }))],
  });
}

export async function renderQualityReportDocx(report: QualityReportView): Promise<Buffer> {
  const m = report.payload.metrics.overall;
  const t = report.payload.trend;
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: 'Еженедельный отчёт по качеству', font: FONT })] }),
    para(`Период: ${formatDate(report.period_start)} — ${formatDate(report.period_end)}`, { color: '64748B', size: 18 }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Приёмочные метрики (раздел 14.3)', font: FONT })] }),
    table(
      ['Метрика', 'Значение', 'Порог', 'Результат'],
      [
        ['Precision', fmtPct(m.precision.point), `≥ ${m.thresholds.precisionMin * 100}%`, passText(m.pass.precision)],
        ['Recall', fmtPct(m.recall.point), `≥ ${m.thresholds.recallMin * 100}%`, passText(m.pass.recall)],
        ['F1', m.f1 === null ? '—' : fmt(m.f1), `≥ ${m.thresholds.f1Min}`, passText(m.pass.f1)],
        ['False Positive Rate', fmtPct(m.false_positive_rate.point), `≤ ${m.thresholds.fprMax * 100}%`, passText(m.pass.false_positive_rate)],
      ],
    ),
    para(`Выборка: ${report.payload.metrics.sample_size} GOLD-меток. Итог: ${passText(m.pass.overall)}`, { bold: true }),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Динамика к предыдущей неделе', font: FONT })] }),
    table(
      ['Метрика', 'Изменение'],
      [
        ['Precision', fmtTrend(t.precision)],
        ['Recall', fmtTrend(t.recall)],
        ['F1', fmtTrend(t.f1)],
        ['FPR', fmtTrend(t.false_positive_rate)],
      ],
    ),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'По модальности', font: FONT })] }),
    table(
      ['Модальность', 'TP/FP/FN/TN', 'Precision', 'Recall', 'F1', 'FPR', 'Итог'],
      report.payload.metrics.by_modality.map(groupRow),
    ),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Причины отклонений инспекторами', font: FONT })] }),
    ...(report.payload.metrics.rejection_reasons.length === 0
      ? [para('Отклонений за период не было.', { color: '94A3B8' })]
      : [table(['Причина', 'Количество'], report.payload.metrics.rejection_reasons.map((r) => [labelText(reasonLabels, r.reason_code, r.reason_code), String(r.count)]))]),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: 'Рекомендации по донастройке', font: FONT })] }),
    ...report.payload.recommendations.map((rec) => para(`• ${rec}`)),
  ];

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}
