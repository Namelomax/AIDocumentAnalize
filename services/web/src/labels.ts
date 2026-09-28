// Russian labels for the interface's own vocabulary of statuses, stages and
// reasons. These are not sample data — every screen reads them regardless of
// what backs it, real objects throughout (Plan 7).
import type { CompletenessStatus, ReasonCode } from './types';

export const statusLabels: Record<string, string> = {
  CANDIDATE:              'Кандидат',
  CONFIRMED_VIOLATION:    'Нарушение подтверждено',
  NEGATIVE_VERIFIED:      'Проверено, расхождений нет',
  MISSING_EVIDENCE:       'Нет доказательства',
  NOT_APPLICABLE:         'Неприменимо',
  NOT_COMPARABLE:         'Нельзя сопоставить',
  CLARIFICATION_REQUIRED: 'Требует уточнения',
  SUSPICION:              'Гипотеза'
};

export const processStatusLabels: Record<string, string> = {
  PENDING:   'Ожидает обработки',
  PARSING:   'Обработка',
  READY:     'Готов к верификации',
  VERIFYING: 'Верификация',
  COMPLETED: 'Завершён',
  FINALIZED: 'Финализирован',
  // Customer's ТЗ p.17: a process.start task that still fails after its
  // retries (services/worker/app/pipeline.py) - never reached by editing a
  // process's own decisions, only by the worker itself.
  FAILED:    'Ошибка обработки'
};

// FAILED is shown in red wherever a process status chip appears
// (DashboardScreen, ObjectScreen, ProcessingScreen); every other status
// keeps its default text colour.
export function processStatusColor(status: string): string | undefined {
  return status === 'FAILED' ? '#B42318' : undefined;
}

export const approvalLabels: Record<string, string> = {
  DRAFT: 'Черновик',
  APPROVED: 'Утверждён',
  FOR_CONSTRUCTION: 'В производство работ',
  SUPERSEDED: 'Заменён',
  CANCELLED: 'Отменён'
};

export const reasonLabels: Record<ReasonCode, string> = {
  WRONG_REVISION:   'Актуальная редакция выбрана неверно',
  APPROVED_CHANGE:  'Есть согласованное изменение',
  OCR_ERROR:        'Ошибка OCR',
  BINDING_ERROR:    'Ошибка привязки',
  NOT_APPLICABLE:   'Параметр неприменим',
  OTHER:            'Иное'
};

export const reasonCodes: ReasonCode[] = [
  'WRONG_REVISION', 'APPROVED_CHANGE', 'OCR_ERROR',
  'BINDING_ERROR', 'NOT_APPLICABLE', 'OTHER'
];

export const detectionLabels: Record<string, string> = {
  logical:   'Логический анализ',
  semantic:  'Семантический диссонанс',
  normative: 'Нормативный анализ',
  ml:        'ML-паттерн'
};

// Stage upload completeness (dashboard, upload and object screens).
// 'not_applicable' is new in Plan 7 — the API's StageCompleteness reports it
// for a stage the checked scenario does not require, a value the mock data
// never had to show.
export const completenessLabels: Record<CompletenessStatus, string> = {
  full:           'Загружено полностью',
  partial:        'Загружено частично',
  missing:        'Отсутствует',
  not_applicable: 'Неприменимо'
};

// Fallback labels for the upload rejection codes documents.ts (services/api)
// can send. The server already sends a ready Russian `message` for every
// rejection (section 9.1), which the upload screen shows directly — this map
// only covers the case a response somehow arrives without one.
export const uploadRejectionLabels: Record<string, string> = {
  UNSUPPORTED_FORMAT: 'Неподдерживаемый формат файла',
  FILE_TOO_LARGE: 'Файл больше допустимого размера',
  CORRUPTED_FILE: 'Файл повреждён или не читается',
  DUPLICATE: 'Такой файл уже загружен по этому объекту',
  MULTIPLE_MANIFESTS: 'В пакете может быть только один реестр',
  PACKAGE_TOO_LARGE: 'Пакет больше допустимого объёма',
  INTERNAL_ERROR: 'Файл не сохранён из-за внутренней ошибки'
};
