import { useEffect, useMemo, useState } from 'react';
import {
  Check, Loader2, Clock, Info, ArrowRight, AlertCircle
} from 'lucide-react';
import Button from '../components/Button';
import { api, ApiError } from '../api/client';
import { toProgress, type ApiProgress, type ProcessProgress } from '../api/adapters';
import { processStatusLabels } from '../labels';

interface Props {
  objectId?: string;
  processId?: string;
  onBack: () => void;
  onComplete: (protocolId: string) => void;
}

interface StageView {
  key: string;
  label: string;
  counter: string;
  done: boolean;
  active: boolean;
  // The one stage this screen cannot honestly report: drawing analysis has
  // no rule engine behind it without a GPU stand (Plan 7, Task 5) — shown as
  // permanently unavailable rather than invented progress numbers.
  unavailable?: boolean;
}

// A process moves PENDING -> PARSING -> READY -> VERIFYING -> COMPLETED ->
// FINALIZED. This screen only cares about the boundary the processing
// pipeline itself owns: parsing is done once the process leaves PARSING.
function isParsingDone(status: ProcessProgress['status']): boolean {
  return status !== 'PENDING' && status !== 'PARSING';
}

function buildStages(progress: ProcessProgress): StageView[] {
  const parsingDone = isParsingDone(progress.status);
  const matchingDone = progress.status !== 'PENDING' && progress.status !== 'PARSING';

  return [
    {
      key: 'ocr',
      label: 'Распознавание (OCR)',
      counter: `${progress.pagesExtracted} стр. из ${progress.filesPdf} PDF`,
      done: parsingDone,
      active: !parsingDone,
    },
    {
      key: 'nlp',
      label: 'Извлечение значений (NLP)',
      counter: `${progress.checksTotal} проверок`,
      done: parsingDone,
      active: !parsingDone,
    },
    {
      key: 'cv',
      label: 'Анализ чертежей (CV)',
      counter: 'требует GPU-стенда',
      done: false,
      active: false,
      unavailable: true,
    },
    {
      key: 'cmp',
      label: progress.checksTotal > 0 ? `Сопоставление ${progress.checksTotal} параметров` : 'Сопоставление',
      counter: matchingDone ? 'готово' : '—',
      done: matchingDone,
      active: parsingDone && !matchingDone,
    },
  ];
}

export default function ProcessingScreen({ objectId, processId, onBack, onComplete }: Props) {
  const [objectName, setObjectName] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProcessProgress | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);

  // A cheap, best-effort lookup for the breadcrumb only — the screen still
  // works if it fails, since the object's name is not what drives this page.
  useEffect(() => {
    if (!objectId) return;
    let cancelled = false;
    (async () => {
      try {
        const detail = await api<{ name: string }>(`/api/v1/objects/${objectId}`);
        if (!cancelled) setObjectName(detail.name);
      } catch {
        // Breadcrumb falls back to a generic label below.
      }
    })();
    return () => { cancelled = true; };
  }, [objectId]);

  // Poll every two seconds until the pipeline leaves PENDING/PARSING; stop
  // polling once it does, and always stop when the screen is left (Plan 7,
  // Task 5: "опрос прекращается при уходе с экрана").
  useEffect(() => {
    if (!processId) return;
    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        const data = await api<ApiProgress>(`/api/v1/processes/${processId}/progress`);
        if (cancelled) return;
        const mapped = toProgress(data);
        setProgress(mapped);
        setPollError(null);
        if (mapped.status === 'PENDING' || mapped.status === 'PARSING') {
          timer = window.setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!cancelled) {
          setPollError(err instanceof ApiError ? err.message : 'Не удалось получить ход обработки');
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [processId]);

  const stages = useMemo(() => (progress ? buildStages(progress) : []), [progress]);
  const done = progress ? isParsingDone(progress.status) : false;

  if (!processId) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
          <h1 className="text-[20px] leading-7 font-semibold text-[#0F172A]">Обработка комплекта документов</h1>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            Процесс не выбран — вернитесь к загрузке и запустите проверку.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      {/* Шапка */}
      <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
        <nav className="text-[12px] text-[#94A3B8] mb-2 flex items-center gap-1.5" aria-label="Хлебные крошки">
          <span>Объекты</span>
          <span aria-hidden>/</span>
          <span className="text-[#475569]">{objectName ?? 'Объект'}</span>
          <span aria-hidden>/</span>
          <span className="text-[#475569]">Обработка</span>
        </nav>
        <h1 className="text-[20px] leading-7 font-semibold text-[#0F172A]">
          Обработка комплекта документов
        </h1>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        <div className="grid grid-cols-12 gap-6">
          {/* ЛЕВАЯ ЧАСТЬ */}
          <div className="col-span-8 flex flex-col gap-5">

            {pollError && (
              <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318] flex items-start gap-2">
                <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden />
                {pollError}
              </div>
            )}

            {/* Стадии */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-6">
              {!progress ? (
                <div className="text-[13px] text-[#94A3B8]">Загрузка хода обработки…</div>
              ) : (
                <div className="flex items-start">
                  {stages.map((s, i) => {
                    const isDone = s.done;
                    const isActive = !isDone && s.active;
                    return (
                      <div key={s.key} className="flex items-start flex-1">
                        <div className="flex-1 flex flex-col items-center text-center">
                          <div
                            className={[
                              'w-9 h-9 rounded-full flex items-center justify-center mb-2 border',
                              isDone
                                ? 'bg-[#ECFDF3] border-[#A6F4C5] text-[#027A48]'
                                : isActive
                                  ? 'bg-[#E8F0FB] border-[#1B4E9B] text-[#1B4E9B]'
                                  : 'bg-[#F8FAFC] border-[#E2E8F0] text-[#94A3B8]'
                            ].join(' ')}
                            aria-hidden
                          >
                            {isDone
                              ? <Check size={16} />
                              : isActive
                                ? <Loader2 size={16} className="animate-spin" />
                                : <span className="num text-[13px]">{i + 1}</span>}
                          </div>
                          <div
                            className={[
                              'text-[13px] mb-1 leading-4',
                              isDone || isActive
                                ? 'text-[#0F172A] font-medium'
                                : 'text-[#94A3B8]'
                            ].join(' ')}
                          >
                            {s.label}
                          </div>
                          <div className="text-[11px] text-[#475569] num">{s.counter}</div>
                        </div>
                        {i < stages.length - 1 && (
                          <div
                            className="flex-1 h-px bg-[#E2E8F0] mt-4 mx-2 self-start"
                            aria-hidden
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Общий прогресс */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] text-[#475569]">Общий прогресс</span>
                <span className="text-[16px] font-semibold text-[#0F172A]">
                  {progress ? (processStatusLabels[progress.status] ?? progress.status) : '—'}
                </span>
              </div>
              <div className="h-2 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
                <div
                  className={[
                    'h-full bg-[#1B4E9B] transition-all duration-300',
                    done ? 'w-full' : 'w-2/3 animate-pulse'
                  ].join(' ')}
                  role="progressbar"
                  aria-valuenow={done ? 100 : undefined}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <div className="mt-2 text-[12px] text-[#475569]">
                {!progress
                  ? 'Получение хода обработки…'
                  : done
                    ? 'Обработка завершена. Протокол готов к верификации.'
                    : `Файлов: ${progress.filesTotal} (PDF: ${progress.filesPdf}) · Страниц распознано: ${progress.pagesExtracted} · Проверок: ${progress.checksTotal}`}
              </div>
            </div>

            {/* Баннер */}
            <div className="bg-[#E8F0FB] border border-[#B2CCF5] rounded-lg px-4 py-3 flex items-start gap-3">
              <Info size={16} className="text-[#1B4E9B] shrink-0 mt-0.5" aria-hidden />
              <div className="text-[13px] text-[#16407F] leading-5">
                Можно закрыть страницу — проверка продолжится.
                Вернитесь на этот экран позже, чтобы увидеть готовность протокола.
              </div>
            </div>

            {/* Кнопки */}
            <div className="flex items-center justify-end gap-3">
              <Button variant="ghost" onClick={onBack}>
                Назад к документам
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={!done || !progress?.protocolId}
                icon={<ArrowRight size={14} />}
                onClick={() => progress?.protocolId && onComplete(progress.protocolId)}
              >
                {done ? 'Открыть протокол' : 'Обработка…'}
              </Button>
            </div>
          </div>

          {/* ПРАВАЯ ЧАСТЬ: показатели */}
          <div className="col-span-4">
            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden sticky top-0">
              <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center gap-2">
                <Clock size={14} className="text-[#475569]" aria-hidden />
                <span className="text-[13px] font-medium text-[#0F172A]">
                  Текущие показатели
                </span>
              </div>
              {!progress ? (
                <div className="px-4 py-6 text-[12px] text-[#94A3B8]">Загрузка…</div>
              ) : (
                <div className="divide-y divide-[#E2E8F0] text-[12px] text-[#475569]">
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Файлы</span>
                    <span className="num text-[#0F172A]">{progress.filesTotal} (PDF: {progress.filesPdf})</span>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Страниц распознано</span>
                    <span className="num text-[#0F172A]">{progress.pagesExtracted}</span>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Требуют OCR</span>
                    <span className="num text-[#0F172A]">{progress.pagesNeedsOcr}</span>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Проверок всего</span>
                    <span className="num text-[#0F172A]">{progress.checksTotal}</span>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Кандидатов</span>
                    <span className="num text-[#0F172A]">{progress.checksCandidates}</span>
                  </div>
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span>Статус процесса</span>
                    <span className="text-[#0F172A]">{processStatusLabels[progress.status] ?? progress.status}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
