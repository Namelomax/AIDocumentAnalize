// Russian labels for the pdf/docx renderers only - the xml renderer keeps the
// raw codes (machine-readable, per the task spec), so these never leak into
// xml.ts. Mirrors services/web/src/labels.ts's own vocabulary; duplicated
// rather than imported because the two are separate npm packages/services.

export const statusLabels: Record<string, string> = {
  CANDIDATE: 'Кандидат',
  CONFIRMED_VIOLATION: 'Нарушение подтверждено',
  NEGATIVE_VERIFIED: 'Проверено, расхождений нет',
  MISSING_EVIDENCE: 'Нет доказательства',
  NOT_APPLICABLE: 'Неприменимо',
  NOT_COMPARABLE: 'Нельзя сопоставить',
  CLARIFICATION_REQUIRED: 'Требует уточнения',
  SUSPICION: 'Гипотеза',
};

export const protocolStatusLabels: Record<string, string> = {
  READY: 'Готов к верификации',
  VERIFYING: 'Верификация',
  VERIFICATION_COMPLETED: 'Верификация завершена',
  PROTOCOL_FINALIZED: 'Финализирован',
};

export const reasonLabels: Record<string, string> = {
  WRONG_REVISION: 'Актуальная редакция выбрана неверно',
  APPROVED_CHANGE: 'Есть согласованное изменение',
  OCR_ERROR: 'Ошибка OCR',
  BINDING_ERROR: 'Ошибка привязки',
  NOT_APPLICABLE: 'Параметр неприменим',
  OTHER: 'Иное',
};

// StageCompleteness (services/worker/app/domain/completeness.py): UPLOADED |
// PARTIAL | MISSING | NOT_APPLICABLE. null reads the same as "нет данных" -
// no process has ever run for the object.
export const stageCompletenessLabels: Record<string, string> = {
  UPLOADED: 'Загружено полностью',
  PARTIAL: 'Загружено частично',
  MISSING: 'Отсутствует',
  NOT_APPLICABLE: 'Неприменимо',
};

export const scenarioLabels: Record<string, string> = {
  FULL: 'Полный комплект (ПД + РД + ИД)',
  PD_RD_ONLY: 'ПД + РД',
  PD_ID_ONLY: 'ПД + ИД',
  RD_ID_ONLY: 'РД + ИД',
  SINGLE_ONLY: 'Одна стадия',
  PARTIALLY_LOADED: 'Частичная загрузка',
};

export const detectionMethodLabels: Record<string, string> = {
  LOGICAL: 'Логический анализ',
  SEMANTIC: 'Семантический диссонанс',
  NORMATIVE: 'Нормативный анализ',
  ML: 'ML-паттерн',
};

export const evidenceRoleLabels: Record<string, string> = {
  expected: 'Ожидаемое значение',
  actual: 'Фактическое значение',
};

export function label(map: Record<string, string>, code: string | null | undefined, fallback = '—'): string {
  if (!code) return fallback;
  return map[code] ?? code;
}
