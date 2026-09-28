// The machine-readable export (task spec: "XML — полный, машиночитаемый, со
// всеми полями всех проверок и доказательств"). Element/attribute names
// follow the field names the rest of the API already answers with
// (protocol/view.ts, snake_case) - a consumer that already parses
// GET /protocols/:id finds the same vocabulary here.
import type { DecisionView, EvidenceView, FindingView, SuspicionView } from '../protocol/view.js';
import type { ExportDocument } from './model.js';

// Hand-rolled rather than a templating dependency: the shape below is fixed
// and small, and escaping is the only thing that actually has to be correct.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function attr(name: string, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return ` ${name}="${escapeXml(String(value))}"`;
}

function el(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return `<${name}/>`;
  return `<${name}>${escapeXml(String(value))}</${name}>`;
}

function evidenceXml(evidence: EvidenceView): string {
  return `<fragment${attr('role', evidence.role)}${attr('file_id', evidence.file_id)}${attr('file_sha256', evidence.file_sha256)}${attr('stage', evidence.stage)}${attr('document_code', evidence.document_code)}${attr('revision', evidence.revision)}${attr('approval_status', evidence.approval_status)}${attr('sheet_page', evidence.sheet_page)}${attr('bbox', evidence.bbox.join(','))}${attr('extracted_value', evidence.extracted_value)}${attr('image_url', evidence.image_url)}/>`;
}

function decisionXml(decision: DecisionView | null): string {
  if (!decision) return '<decision/>';
  return [
    `<decision${attr('status', decision.status)}${attr('reason_code', decision.reason_code)}${attr('decided_at', decision.decided_at ? decision.decided_at.toISOString() : null)}>`,
    el('comment', decision.comment),
    `<inspector${attr('id', decision.inspector.id)}${attr('full_name', decision.inspector.full_name)}/>`,
    '</decision>',
  ].join('');
}

function findingXml(tag: string, finding: FindingView, extra: Record<string, string | number | null> = {}): string {
  const attrs = [
    attr('id', finding.id),
    attr('evidence_group_id', finding.evidence_group_id),
    attr('param_code', finding.param_code),
    attr('section', finding.section),
    attr('title', finding.title),
    attr('unit', finding.unit),
    attr('expected_value', finding.expected_value),
    attr('actual_value', finding.actual_value),
    attr('delta', finding.delta),
    attr('review_priority', finding.review_priority),
    attr('finding_status', finding.finding_status),
    attr('engine_status', finding.engine_status),
    attr('completeness_status', finding.completeness_status),
    ...Object.entries(extra).map(([key, value]) => attr(key, value)),
  ].join('');
  return [
    `<${tag}${attrs}>`,
    el('trigger_logic', finding.trigger_logic),
    el('norm_reference', finding.norm_reference),
    el('rationale', finding.rationale),
    `<sources>${finding.sources.map((s) => `<source>${escapeXml(s)}</source>`).join('')}</sources>`,
    `<evidence>${finding.evidence.map(evidenceXml).join('')}</evidence>`,
    decisionXml(finding.decision),
    `</${tag}>`,
  ].join('');
}

function suspicionXml(suspicion: SuspicionView): string {
  return findingXml('hypothesis', suspicion, {
    detection_method: suspicion.detection_method,
    confidence: suspicion.confidence,
  });
}

// Every string this module ever puts between tags goes through escapeXml
// first, so a literal "><" only ever occurs at a real tag boundary - never
// inside escaped text or an attribute value. That makes a single global
// split-and-indent pass safe: without it, tables 1 and 4 alone (up to 280+
// rows in the reference package) would land on one unreadable multi-hundred-
// kilobyte line, and "first 30 lines of the xml" (task spec's own
// acceptance check) would show almost nothing.
function prettyPrint(xml: string): string {
  const lines = xml.replace(/>\s*</g, '>\n<').split('\n').filter((line) => line.length > 0);
  let depth = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('<?') || line.startsWith('<!--')) {
      out.push(line);
      continue;
    }
    const closingOnly = line.startsWith('</');
    const selfClosing = line.endsWith('/>');
    // Open and close tag of the very same element on one line (a leaf value
    // like <rationale>text</rationale>) - it never nests a child of its own,
    // so it must not push the indent level up for what follows.
    const completeElement = /^<([a-zA-Z_][\w.-]*)(?:\s[^>]*)?>.*<\/\1>$/.test(line);
    if (closingOnly) depth = Math.max(0, depth - 1);
    out.push('  '.repeat(depth) + line);
    if (!closingOnly && !selfClosing && !completeElement) depth += 1;
  }
  return out.join('\n');
}

export function renderProtocolXml(document: ExportDocument): string {
  const p = document.protocol;
  const s = document.summary;

  const root = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    // Review priority is order-of-review only (Global Constraint), never a
    // violation verdict - called out here once, at the root, rather than on
    // every review_priority attribute below.
    '<!-- review_priority: очерёдность проверки инспектором; не является правовой оценкой и не статусом нарушения -->',
    `<protocol${attr('id', p.id)}${attr('object_id', p.object_id)}${attr('process_id', p.process_id)}${attr('version', p.version)}${attr('status', p.status)}${attr('sync_status', p.sync_status)}${attr('matrix_version', p.matrix_version)}${attr('model_version', p.model_version)}${attr('dataset_version', p.dataset_version)}${attr('input_manifest_hash', p.input_manifest_hash)}>`,
    el('object_name', document.object_name),
    el('created_at', p.created_at.toISOString()),
    el('finalized_at', p.finalized_at ? p.finalized_at.toISOString() : null),
    el('finalized_by', document.finalized_by_name),
    // Section 9.2's "Статус загрузки документов" / "Тип проверки".
    [
      '<document_upload_status>',
      el('pd_completeness', document.pd_completeness),
      el('rd_completeness', document.rd_completeness),
      el('id_completeness', document.id_completeness),
      '</document_upload_status>',
      '<check_type>',
      el('scenario', document.scenario),
      '</check_type>',
    ].join(''),
    [
      `<summary${attr('checked', s.checked)}${attr('candidates', s.candidates)}${attr('confirmed', s.confirmed)}${attr('negative', s.negative)}${attr('missing_evidence', s.missing_evidence)}${attr('not_applicable', s.not_applicable)}${attr('not_comparable', s.not_comparable)}${attr('clarification_required', s.clarification_required)}${attr('suspicions', s.suspicions)}/>`,
    ].join(''),
    // Table 1: completeness and comparability.
    [
      '<completeness_and_comparability>',
      ...document.completeness.map(
        (row) =>
          `<row${attr('param_code', row.param_code)}${attr('parameter_name', row.parameter_name)}${attr('completeness_status', row.completeness_status)}${attr('rationale', row.rationale)}/>`,
      ),
      '</completeness_and_comparability>',
    ].join(''),
    // Table 2: preliminary candidates.
    `<candidates>${document.candidates.map((f) => findingXml('finding', f)).join('')}</candidates>`,
    // Table 3: violations confirmed by the inspector.
    `<confirmed_violations>${document.confirmed.map((f) => findingXml('finding', f)).join('')}</confirmed_violations>`,
    // Table 4: checked, no discrepancy found.
    `<negative_verified>${document.negative.map((f) => findingXml('finding', f)).join('')}</negative_verified>`,
    // Not one of the customer's five named tables, but a real decided
    // outcome (see model.ts) - never silently dropped from the one export
    // meant to carry every field of every check.
    `<clarification_required>${document.clarification.map((f) => findingXml('finding', f)).join('')}</clarification_required>`,
    // Table 5: free-search hypotheses (Global Constraint: never a violation).
    `<free_search_hypotheses>${document.suspicions.map(suspicionXml).join('')}</free_search_hypotheses>`,
    '</protocol>',
  ];

  return prettyPrint(root.join(''));
}
