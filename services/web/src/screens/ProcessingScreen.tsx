import { useEffect, useMemo, useState } from 'react';
import {
  Check, Loader2, Clock, Info, FileWarning, ArrowRight
} from 'lucide-react';
import Button from '../components/Button';
import { processingLog, processingStages, objects } from '../mocks/data';

interface Props {
  objectId?: string;
  onBack: () => void;
  onComplete: () => void;
}

interface Stage {
  key: string;
  label: string;
  counter: string;
  done?: boolean;
  active?: boolean;
}

const STAGES = processingStages as Stage[];

export default function ProcessingScreen({ objectId, onBack, onComplete }: Props) {
  const obj = useMemo(
    () => objects.find((o) => o.id === objectId) ?? objects[0],
    [objectId]
  );

  const [progress, setProgress] = useState(68);

  useEffect(() => {
    if (progress >= 100) return;
    const t = window.setTimeout(() => {
      setProgress((p) => Math.min(100, p + 3));
    }, 200);
    return () => window.clearTimeout(t);
  }, [progress]);

  const done = progress >= 100;
  const remaining = done ? 0 : Math.max(1, Math.round((100 - progress) / 17));
  const remainingLabel = remaining === 1 ? 'минута' : 'минуты';

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      {/* Шапка */}
      <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
        <nav className="text-[12px] text-[#94A3B8] mb-2 flex items-center gap-1.5" aria-label="Хлебные крошки">
          <span>Объекты</span>
          <span aria-hidden>/</span>
          <span className="text-[#475569]">{obj.name}</span>
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

            {/* Стадии */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-6">
              <div className="flex items-start">
                {STAGES.map((s, i) => {
                  const isDone = s.done === true;
                  const isActive = !isDone && s.active === true;
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
                      {i < STAGES.length - 1 && (
                        <div
                          className="flex-1 h-px bg-[#E2E8F0] mt-4 mx-2 self-start"
                          aria-hidden
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Общий прогресс */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-[13px] text-[#475569]">Общий прогресс</span>
                <span className="text-[16px] font-semibold num text-[#0F172A]">{progress}%</span>
              </div>
              <div className="h-2 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#1B4E9B] transition-all duration-300"
                  style={{ width: `${progress}%` }}
                  role="progressbar"
                  aria-valuenow={progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                />
              </div>
              <div className="mt-2 text-[12px] text-[#475569]">
                {done
                  ? 'Обработка завершена. Протокол готов к верификации.'
                  : `Осталось примерно ${remaining} ${remainingLabel}`}
              </div>
            </div>

            {/* Баннер */}
            <div className="bg-[#E8F0FB] border border-[#B2CCF5] rounded-lg px-4 py-3 flex items-start gap-3">
              <Info size={16} className="text-[#1B4E9B] shrink-0 mt-0.5" aria-hidden />
              <div className="text-[13px] text-[#16407F] leading-5">
                Можно закрыть страницу — проверка продолжится.
                Мы уведомим о готовности протокола.
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
                disabled={!done}
                icon={<ArrowRight size={14} />}
                onClick={onComplete}
              >
                {done ? 'Открыть протокол' : 'Обработка…'}
              </Button>
            </div>
          </div>

          {/* ПРАВАЯ ЧАСТЬ: Журнал */}
          <div className="col-span-4">
            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden sticky top-0">
              <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center gap-2">
                <Clock size={14} className="text-[#475569]" aria-hidden />
                <span className="text-[13px] font-medium text-[#0F172A]">
                  Журнал обработки
                </span>
              </div>
              <div className="divide-y divide-[#E2E8F0] max-h-[calc(100vh-260px)] overflow-y-auto">
                {processingLog.map((row, i) => (
                  <div
                    key={`${row.time}-${i}`}
                    className={[
                      'px-4 py-2 text-[12px] flex items-start gap-3 leading-4',
                      row.warn ? 'text-[#B54708] bg-[#FFFAEB]' : 'text-[#475569]'
                    ].join(' ')}
                  >
                    {row.warn && (
                      <FileWarning size={13} className="shrink-0 mt-0.5 text-[#B54708]" aria-hidden />
                    )}
                    <span className="mono shrink-0">{row.time}</span>
                    <span className="flex-1 break-words">{row.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}