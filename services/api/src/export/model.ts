// The one place all three export formats (pdf.ts, docx.ts, xml.ts) read from.
// Built on top of protocol/view.ts's own ProtocolResponse rather than
// querying checks/params/inspectors again, so an export can never show a
// number the /protocols/:id endpoint itself would disagree with. The three
// renderers differ only in how they format these fields (labels vs raw
// codes, cards vs compact rows) - never in which fields they draw from.
import type { CompletenessRow, FindingView, ProtocolResponse, ProtocolSummary, SuspicionView } from '../protocol/view.js';

export interface ExportDocument {
  // Section 9.2: no separate human protocol number exists in the schema (see
  // web/src/api/adapters.ts's toProtocol) - the id's short form is the same
  // stand-in the interface already shows the inspector, so the exported
  // file's name matches what the inspector sees on screen.
  protocol_number: string;
  protocol: ProtocolResponse;
  object_name: string;
  // Section 9.2's "Статус загрузки документов" / "Тип проверки" - carried
  // here as raw codes (StageCompleteness / LoadScenario) rather than labels,
  // so the XML renderer stays machine-readable and only pdf.ts/docx.ts
  // translate them for the inspector to read.
  scenario: string | null;
  pd_completeness: string | null;
  rd_completeness: string | null;
  id_completeness: string | null;
  finalized_by_name: string | null;
  summary: ProtocolSummary;
  completeness: CompletenessRow[];
  // The four disjoint finding buckets a protocol status can put a check in
  // (section 9.2's four tables besides completeness). `clarification` is not
  // one of the customer's five named tables, but a check an inspector sent
  // back for clarification is a real, decided outcome (see verdicts.ts's
  // DECISIONS) that no export may silently drop - it gets its own, clearly
  // labelled extra section instead of being folded into one of the five.
  candidates: FindingView[];
  confirmed: FindingView[];
  negative: FindingView[];
  clarification: FindingView[];
  suspicions: SuspicionView[];
}

export interface ExportExtras {
  objectName: string;
  scenario: string | null;
  pdCompleteness: string | null;
  rdCompleteness: string | null;
  idCompleteness: string | null;
  finalizedByName: string | null;
}

export function buildExportDocument(protocol: ProtocolResponse, extras: ExportExtras): ExportDocument {
  const candidates = protocol.findings.filter((f) => f.finding_status === 'CANDIDATE');
  const confirmed = protocol.findings.filter((f) => f.finding_status === 'CONFIRMED_VIOLATION');
  const negative = protocol.findings.filter((f) => f.finding_status === 'NEGATIVE_VERIFIED');
  // Whatever is left of `findings` beyond the three statuses above - today
  // only CLARIFICATION_REQUIRED, kept as a catch-all rather than a literal
  // filter so a future finding_status never disappears from every export
  // silently.
  const known = new Set(['CANDIDATE', 'CONFIRMED_VIOLATION', 'NEGATIVE_VERIFIED']);
  const clarification = protocol.findings.filter((f) => !known.has(f.finding_status ?? ''));

  return {
    protocol_number: protocol.id.slice(0, 8),
    protocol,
    object_name: extras.objectName,
    scenario: extras.scenario,
    pd_completeness: extras.pdCompleteness,
    rd_completeness: extras.rdCompleteness,
    id_completeness: extras.idCompleteness,
    finalized_by_name: extras.finalizedByName,
    summary: protocol.summary,
    completeness: protocol.completeness,
    candidates,
    confirmed,
    negative,
    clarification,
    suspicions: protocol.suspicions,
  };
}

export type ExportFormat = 'pdf' | 'docx' | 'xml';

// "protocol-<номер>-v<версия>.<ext>" (task spec) - both components are
// already filesystem/URL-safe (a hex id slice, an integer), so no sanitizing
// is needed before it goes into Content-Disposition.
export function exportFilename(document: ExportDocument, format: ExportFormat): string {
  return `protocol-${document.protocol_number}-v${document.protocol.version}.${format}`;
}
