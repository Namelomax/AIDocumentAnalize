import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, Check, Save, FileWarning, UploadCloud, Layers, GitCompare
} from 'lucide-react';
import EmptyState from '../components/EmptyState';
import Button from '../components/Button';
import PriorityIndicator from '../components/PriorityIndicator';
import StatusBadge from '../components/StatusBadge';
import StageBadge from '../components/StageBadge';
import EvidencePanel from '../components/EvidencePanel';
import {
  protocol, reasonCodes, reasonLabels, inspector, approvalLabels
} from '../mocks/data';
import type { Finding, ReasonCode, RevisionCard } from '../types';

interface Props {
  protocolId: string;
  onBack: () => void;
  onFinish: (protocolId: string) => void;
}

type Decision =
  | { kind: 'none' }
  | { kind: 'saved'; status: 'CONFIRMED_VIOLATION' | 'NEGATIVE_VERIFIED' | 'CLARIFICATION_REQUIRED'; reason?: ReasonCode; comment?: string; timestamp: string };

const CANDIDATES = protocol.findings.filter((f) => f.status === 'CANDIDATE');

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ─────────── Выбор редакции (CLARIFICATION_REQUIRED) ─────────── */

function RevisionCardView({
  card,
  selected,
  onSelect
}: {
  card: RevisionCard;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'text-left flex-1 rounded-lg border p-4 transition-colors',
        selected
          ? 'border-[#1B4E9B] bg-[#E8F0FB]'
          : 'border-[#E2E8F0] bg-white hover:bg-[#F5F7FA]'
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-2">
        <StageBadge stage="RD" />
        <span className="mono text-[13px] text-[#0F172A]">{card.documentCode}</span>
        <span className="ml-auto text-[11px] text-[#475569]">{card.revision}</span>
      </div>
      <div className="text-[12px] text-[#475569] flex flex-col gap-0.5 mb-2">
        <div>Статус: <span className="text-[#0F172A]">{approvalLabels[card.approvalStatus]}</span></div>
        <div>Утверждён: <span className="mono text-[#0F172A]">{card.approvedAt}</span></div>
        <div>Лист: <span className="num text-[#0F172A]">{card.sheetPage}</span></div>
        <div className="mono text-[11px] text-[#94A3B8] truncate">
          SHA-256: {card.sha256.slice(0, 16)}…
        </div>
      </div>
      <div className="text-[13px] text-[#0F172A] font-medium border-t border-[#E2E8F0] pt-2">
        {card.extractedValue}
      </div>
      {selected && (
        <div className="mt-2 flex items-center gap-1 text-[12px] text-[#1B4E9B]">
          <Check size={12} /> Выбрана как актуальная
        </div>
      )}
    </button>
  );
}

/* ─────────── Основной компонент ─────────── */

export default function VerificationScreen({ protocolId, onBack, onFinish }: Props) {
  const [index, setIndex] = useState(2);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [comment, setComment] = useState('');
  const [showReasons, setShowReasons] = useState(false);
  const [pendingReason, setPendingReason] = useState<ReasonCode | undefined>(undefined);
  const [selectedRevisionIdx, setSelectedRevisionIdx] = useState<0 | 1 | null>(null);
  const [selectedAtoms, setSelectedAtoms] = useState<Record<string, boolean>>({});
  const [queueCompleted, setQueueCompleted] = useState(false);

  const finding: Finding = CANDIDATES[index];
  const currentDecision = decisions[finding.id] ?? { kind: 'none' } as Decision;

  const processedCount = Object.values(decisions).filter((d) => d.kind === 'saved').length;
  const allProcessed = processedCount === CANDIDATES.length;

  const isClarification = !!finding.clarificationConflict;
  const isComposite = !!finding.composite;

  /* ─── Клавиатурные сокращения ─── */
  useEffect(() => {
    if (queueCompleted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (isClarification) {
        if (e.key === '1') { e.preventDefault(); if (selectedRevisionIdx !== null) handleClarificationSave(); }
        else if (e.key === '3') { e.preventDefault(); setShowReasons(true); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
        return;
      }
      if (e.key === '1') { e.preventDefault(); handleConfirm(); }
      else if (e.key === '2') { e.preventDefault(); setShowReasons(true); }
      else if (e.key === '3') { e.preventDefault(); handleClarify(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
      else if (e.key === 'ArrowLeft')  { e.preventDefault(); goPrev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finding.id, showReasons, pendingReason, comment, selectedRevisionIdx, queueCompleted, isClarification]);

  const resetLocal = () => {
    setComment('');
    setShowReasons(false);
    setPendingReason(undefined);
    setSelectedRevisionIdx(null);
    setSelectedAtoms({});
  };

  const goNext = () => {
    if (index < CANDIDATES.length - 1) {
      setIndex(index + 1);
      resetLocal();
    } else {
      setQueueCompleted(true);
    }
  };

  const goPrev = () => {
    if (index > 0) {
      setIndex(index - 1);
      resetLocal();
    }
  };

  const saveDecision = (d: Decision) => {
    setDecisions((prev) => ({ ...prev, [finding.id]: d }));
  };

  const handleConfirm = () => {
    if (isComposite) return;
    saveDecision({ kind: 'saved', status: 'CONFIRMED_VIOLATION', comment, timestamp: nowStr() });
    window.setTimeout(goNext, 120);
  };

  const handleRejectSave = () => {
    if (!pendingReason) return;
    saveDecision({
      kind: 'saved', status: 'NEGATIVE_VERIFIED',
      reason: pendingReason, comment, timestamp: nowStr()
    });
    window.setTimeout(goNext, 120);
  };

  const handleClarify = () => {
    saveDecision({ kind: 'saved', status: 'CLARIFICATION_REQUIRED', comment, timestamp: nowStr() });
    window.setTimeout(goNext, 120);
  };

  const handleClarificationSave = () => {
  if (selectedRevisionIdx === null || !finding.clarificationConflict) return;
  const chosenRevision = finding.clarificationConflict.revisions[selectedRevisionIdx];
  
  // Логика по ТЗ: фиксируем выбранную редакцию как единственный авторитетный источник
  toast.success(`Редакция ${chosenRevision.revision} утверждена как актуальная база сравнения`);
  
  // Сбрасываем статус конфликта, так как инспектор его разрешил камерально
  finding.actualEvidence = {
    stage: 'RD',
    documentCode: chosenRevision.documentCode,
    sheetPage: chosenRevision.sheetPage,
    sha256: chosenRevision.sha256,
    extractedValue: chosenRevision.extractedValue
  };
  
  // Возвращаем интерфейс к стандартному сравнению по ТЗ Мосгосстройнадзора
  setSelectedRevisionIdx(null);
  // Пересчитываем дельту на ходу
  finding.actual = chosenRevision.extractedValue; 
  finding.clarificationConflict = undefined; 
};

  const handleCompositeSave = () => {
    const atoms = Object.entries(selectedAtoms).filter(([, v]) => v).map(([k]) => k);
    if (atoms.length === 0) return;
    saveDecision({
      kind: 'saved',
      status: 'CONFIRMED_VIOLATION',
      comment: `${comment ? comment + ' · ' : ''}Выделено находок: ${atoms.length}`,
      timestamp: nowStr()
    });
    window.setTimeout(goNext, 120);
  };

  const progress = useMemo(() => ((index + 1) / CANDIDATES.length) * 100, [index]);

  /* ─── Экран «Все кандидаты обработаны» ─── */
  if (queueCompleted) {
    return (
      <div className="h-screen flex flex-col bg-[#F5F7FA] overflow-hidden">
        <div className="h-11 shrink-0 px-6 border-b border-[#E2E8F0] bg-white flex items-center gap-4">
          <button
            type="button"
            onClick={onBack}
            className="text-[13px] text-[#475569] hover:text-[#0F172A] flex items-center gap-1"
          >
            <ArrowLeft size={14} /> К протоколу
          </button>
          <span className="text-[#94A3B8]">·</span>
          <span className="text-[13px] text-[#0F172A]">Верификация завершена</span>
        </div>

        <div className="flex-1 flex items-center justify-center px-8">
          <div className="w-[560px] bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="all-processed"
              description={`Обработано ${processedCount} из ${CANDIDATES.length} кандидатов. Подтверждено нарушений: ${Object.values(decisions).filter((d) => d.kind === 'saved' && d.status === 'CONFIRMED_VIOLATION').length}. Отклонено: ${Object.values(decisions).filter((d) => d.kind === 'saved' && d.status === 'NEGATIVE_VERIFIED').length}.`}
              action={
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => { setQueueCompleted(false); setIndex(CANDIDATES.length - 1); }}
                  >
                    Вернуться к очереди
                  </Button>
                  <Button variant="primary" size="lg" onClick={() => onFinish(protocolId)}>
                    Перейти к финализации
                  </Button>
                </div>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#F5F7FA] overflow-hidden">
      {/* Тонкая шапка */}
      <div className="h-11 shrink-0 px-6 border-b border-[#E2E8F0] bg-white flex items-center gap-4">
        <button
          type="button"
          onClick={onBack}
          className="text-[13px] text-[#475569] hover:text-[#0F172A] flex items-center gap-1"
        >
          <ArrowLeft size={14} /> К протоколу
        </button>
        <span className="text-[#94A3B8]">·</span>
        <span className="text-[13px] text-[#0F172A]">Верификация кандидата</span>
        <span className="ml-auto text-[12px] text-[#475569]">
          Обработано {processedCount} из {CANDIDATES.length}
        </span>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ЛЕВАЯ ПАНЕЛЬ */}
        <aside className="w-[280px] shrink-0 border-r border-[#E2E8F0] bg-white flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-[#E2E8F0]">
            <div className="flex items-center justify-between text-[12px] text-[#475569] mb-2">
              <span>Очередь кандидатов</span>
              <span className="num">{index + 1} из {CANDIDATES.length}</span>
            </div>
            <div className="h-1 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
              <div className="h-full bg-[#1B4E9B]" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {CANDIDATES.map((f, i) => {
              const d = decisions[f.id];
              const isActive = i === index;
              const isDone = d && d.kind === 'saved';
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => { setIndex(i); resetLocal(); }}
                  className={[
                    'w-full text-left px-3 py-2 border-b border-[#E2E8F0] flex items-center gap-2',
                    isActive ? 'bg-[#E8F0FB]' : 'hover:bg-[#F5F7FA]'
                  ].join(' ')}
                >
                  <span className={[
                    'w-4 h-4 shrink-0 rounded-full flex items-center justify-center',
                    isDone ? 'bg-[#ECFDF3] text-[#027A48]' : 'border border-[#CBD5E1]'
                  ].join(' ')}>
                    {isDone && <Check size={10} />}
                  </span>
                  <span className="mono text-[12px] text-[#0F172A] shrink-0">{f.code}</span>
                  <span className="text-[12px] text-[#475569] truncate">{f.title}</span>
                  <span className="ml-auto shrink-0">
                    <PriorityIndicator priority={f.priority} />
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ЦЕНТРАЛЬНАЯ ПАНЕЛЬ */}
        <section className="flex-1 min-w-0 flex flex-col p-5 gap-4 overflow-hidden">
          {/* Шапка кандидата */}
          <div className="flex items-start gap-3">
            <span className="mono text-[16px] text-[#0F172A] font-medium">{finding.code}</span>
            <h2 className="text-[16px] font-semibold text-[#0F172A]">{finding.title}</h2>
            <span className="text-[12px] text-[#475569]">Раздел: {finding.section}</span>
            <span className="text-[#94A3B8]">·</span>
            <PriorityIndicator priority={finding.priority} />
            {isComposite && (
              <span className="inline-flex items-center gap-1 px-2 h-6 rounded-[4px] bg-[#F4F3FF] text-[#5925DC] text-[12px] font-medium">
                <Layers size={12} /> Составной
              </span>
            )}
            {isClarification && (
              <span className="inline-flex items-center gap-1 px-2 h-6 rounded-[4px] bg-[#F4F3FF] text-[#5925DC] text-[12px] font-medium">
                <GitCompare size={12} /> Конфликт редакций
              </span>
            )}
            <div className="ml-auto">
              <StatusBadge status={finding.status} />
            </div>
          </div>

          {/* Блок сравнения — либо обычный, либо выбор редакции */}
          {isClarification && finding.clarificationConflict ? (
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-3">
                Конфликт редакций · Выберите актуальную
              </div>
              <div className="flex gap-3">
                {finding.clarificationConflict.revisions.map((rev, i) => (
                  <RevisionCardView
                    key={i}
                    card={rev}
                    selected={selectedRevisionIdx === i}
                    onSelect={() => setSelectedRevisionIdx(i as 0 | 1)}
                  />
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-[#E2E8F0] text-[12px] text-[#475569]">
                {finding.aiRationale}
              </div>
            </div>
          ) : (
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Ожидается</div>
                  <div className="text-[24px] leading-8 font-bold text-[#0F172A] num">{finding.expected}</div>
                  <div className="text-[12px] text-[#475569] mt-1">
                    Источник: {finding.expectedEvidence.stage} · {finding.expectedEvidence.documentCode} · лист {finding.expectedEvidence.sheetPage}
                  </div>
                </div>
                <div>
                  <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Фактически</div>
                  <div className="text-[24px] leading-8 font-bold text-[#0F172A] num">{finding.actual}</div>
                  <div className="text-[12px] text-[#475569] mt-1">
                    Источник: {finding.actualEvidence.stage} · {finding.actualEvidence.documentCode} · лист {finding.actualEvidence.sheetPage}
                  </div>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t border-[#E2E8F0] flex items-center gap-3 text-[12px] text-[#475569] flex-wrap">
                <span>Δ <span className="num text-[#0F172A] font-medium">{finding.delta}</span></span>
                <span className="text-[#CBD5E1]">·</span>
                <span>Триггер: <span className="text-[#0F172A]">{finding.trigger}</span></span>
                {finding.normReference && (
                  <>
                    <span className="text-[#CBD5E1]">·</span>
                    <span className="text-[#1B4E9B]">{finding.normReference}</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Блок составного кандидата */}
          {isComposite && finding.composite && (
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Layers size={14} className="text-[#5925DC]" aria-hidden />
                <div className="text-[13px] font-medium text-[#0F172A]">
                  Разделить на атомарные находки
                </div>
                <span className="text-[11px] text-[#94A3B8]">
                  · {finding.composite.atoms.length} под-параметров
                </span>
              </div>
              {finding.composite.note && (
                <div className="text-[12px] text-[#5925DC] bg-[#F4F3FF] border border-[#E9D7FE] rounded-md px-3 py-2 mb-3">
                  {finding.composite.note}
                </div>
              )}
              <div className="grid grid-cols-1 gap-1 max-h-[180px] overflow-y-auto pr-1">
                {finding.composite.atoms.map((atom) => (
                  <label
                    key={atom.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={!!selectedAtoms[atom.id]}
                      onChange={(e) =>
                        setSelectedAtoms((prev) => ({ ...prev, [atom.id]: e.target.checked }))
                      }
                      className="w-4 h-4 accent-[#1B4E9B]"
                    />
                    <span className="mono text-[12px] text-[#0F172A] shrink-0 w-[70px]">{atom.code}</span>
                    <span className="text-[13px] text-[#0F172A] flex-1 truncate">{atom.title}</span>
                    <span className="text-[12px] text-[#475569] num shrink-0">{atom.expected}</span>
                    <span className="text-[#CBD5E1]">→</span>
                    <span className="text-[12px] text-[#0F172A] num shrink-0">{atom.actual}</span>
                    <span className="text-[12px] text-[#475569] num shrink-0 w-[60px] text-right">{atom.delta}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Сплит-вью чертежей */}
          <div className="flex gap-3 flex-1 min-h-0">
            <EvidencePanel fragment={finding.expectedEvidence} accent="expected" />
            <EvidencePanel fragment={finding.actualEvidence}   accent="actual" />
          </div>

          {/* Обоснование */}
          {!isClarification && (
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1.5">Обоснование ИИ</div>
              <p className="text-[13px] text-[#0F172A] leading-5 mb-2">{finding.aiRationale}</p>
              <div className="flex items-center gap-3 text-[12px] flex-wrap">
                {finding.normReference && (
                  <span className="text-[#1B4E9B]">Норматив: {finding.normReference}</span>
                )}
                <span className="text-[#CBD5E1]">·</span>
                <span className="text-[#475569]">
                  Согласованное изменение: <span className="text-[#0F172A] font-medium">{finding.approvedChange ?? 'не найдено'}</span>
                </span>
              </div>
            </div>
          )}
        </section>

        {/* ПРАВАЯ ПАНЕЛЬ */}
        <aside className="w-[340px] shrink-0 border-l border-[#E2E8F0] bg-white flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-[#E2E8F0] text-[12px] text-[#475569] uppercase tracking-wide">
            Решение инспектора
          </div>

          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            {currentDecision.kind === 'saved' ? (
              <div className="border border-[#E2E8F0] rounded-lg p-3 bg-[#F8FAFC]">
                <StatusBadge status={currentDecision.status} />
                <div className="mt-2 text-[12px] text-[#475569]">
                  {inspector.name} · {currentDecision.timestamp}
                </div>
                {currentDecision.reason && (
                  <div className="mt-1 text-[12px] text-[#475569]">
                    Причина: {reasonLabels[currentDecision.reason]}
                  </div>
                )}
                {currentDecision.comment && (
                  <div className="mt-1 text-[12px] text-[#475569] italic">«{currentDecision.comment}»</div>
                )}
                <button
                  type="button"
                  onClick={() => saveDecision({ kind: 'none' })}
                  className="mt-3 text-[12px] text-[#1B4E9B] hover:underline"
                >
                  Изменить решение
                </button>
              </div>
            ) : isClarification ? (
              /* Состояние CLARIFICATION_REQUIRED */
              <>
                <div className="text-[13px] text-[#0F172A] leading-5 mb-1">
                  Выберите актуальную редакцию в центральной панели — по ней будет принято решение.
                </div>
                <Button
                  variant="primary"
                  size="lg"
                  disabled={selectedRevisionIdx === null}
                  className="w-full"
                  onClick={handleClarificationSave}
                >
                  Сохранить выбор редакции
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  onClick={handleClarify}
                >
                  Требует уточнения у заказчика
                </Button>
                <div className="mt-2">
                  <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1.5">
                    Комментарий инспектора
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    placeholder="Обоснование выбора редакции"
                    className="w-full px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B]"
                  />
                </div>
              </>
            ) : isComposite ? (
              /* Составной кандидат */
              <>
                <div className="text-[13px] text-[#0F172A] leading-5 mb-1">
                  Отметьте в центральной панели, какие под-параметры подтверждаются. Каждый подтверждённый под-параметр станет отдельной находкой.
                </div>
                <Button
                  variant="danger"
                  size="lg"
                  disabled={!Object.values(selectedAtoms).some(Boolean)}
                  className="w-full"
                  onClick={handleCompositeSave}
                >
                  Подтвердить выбранные находки
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="w-full"
                  onClick={() => setShowReasons(true)}
                >
                  Отклонить кандидата
                </Button>
                {showReasons && (
                  <div className="mt-2">
                    <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-2">
                      Код причины отклонения
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {reasonCodes.map((rc) => {
                        const active = pendingReason === rc;
                        return (
                          <button
                            key={rc}
                            type="button"
                            onClick={() => setPendingReason(rc)}
                            className={[
                              'text-left px-2.5 py-2 rounded-md border text-[12px] leading-4 transition-colors',
                              active
                                ? 'bg-[#E8F0FB] border-[#1B4E9B] text-[#1B4E9B]'
                                : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F5F7FA]'
                            ].join(' ')}
                          >
                            {reasonLabels[rc]}
                          </button>
                        );
                      })}
                    </div>
                    <Button
                      variant="primary"
                      size="lg"
                      className="w-full mt-3"
                      disabled={!pendingReason}
                      icon={<Save size={14} />}
                      onClick={handleRejectSave}
                    >
                      Сохранить решение
                    </Button>
                  </div>
                )}
                <div className="mt-2">
                  <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1.5">
                    Комментарий инспектора
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={2}
                    placeholder="Обоснование"
                    className="w-full px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B]"
                  />
                </div>
              </>
            ) : (
              /* Стандартный кандидат */
              <>
                <Button variant="danger" size="lg" onClick={handleConfirm} className="w-full">
                  Подтвердить нарушение
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => setShowReasons(true)}
                  className="w-full"
                >
                  Отклонить
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={handleClarify}
                  className="w-full"
                >
                  Требует уточнения
                </Button>

                {showReasons && (
                  <div className="mt-2">
                    <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-2">
                      Код причины отклонения
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {reasonCodes.map((rc) => {
                        const active = pendingReason === rc;
                        return (
                          <button
                            key={rc}
                            type="button"
                            onClick={() => setPendingReason(rc)}
                            className={[
                              'text-left px-2.5 py-2 rounded-md border text-[12px] leading-4 transition-colors',
                              active
                                ? 'bg-[#E8F0FB] border-[#1B4E9B] text-[#1B4E9B]'
                                : 'bg-white border-[#CBD5E1] text-[#0F172A] hover:bg-[#F5F7FA]'
                            ].join(' ')}
                          >
                            {reasonLabels[rc]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="mt-2">
                  <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1.5">
                    Комментарий инспектора
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    placeholder="Обоснование решения (необязательно)"
                    className="w-full px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B]"
                  />
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  icon={<Save size={14} />}
                  disabled={showReasons && !pendingReason}
                  onClick={showReasons ? handleRejectSave : handleConfirm}
                  className="w-full mt-1"
                >
                  Сохранить решение
                </Button>

                <div className="mt-3 pt-3 border-t border-[#E2E8F0] flex items-start gap-2 text-[12px] text-[#475569]">
                  <FileWarning size={14} className="mt-0.5 shrink-0 text-[#B54708]" aria-hidden />
                  <div className="flex-1">
                    Нет нужной стадии?
                    <button type="button" className="ml-1 text-[#1B4E9B] hover:underline inline-flex items-center gap-1">
                      <UploadCloud size={11} /> Дозагрузить документ
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {allProcessed && (
            <div className="p-3 border-t border-[#E2E8F0] bg-[#ECFDF3]">
              <div className="text-[12px] text-[#027A48] mb-2 flex items-center gap-1.5">
                <Check size={13} /> Все кандидаты обработаны
              </div>
              <Button
                variant="primary"
                size="lg"
                onClick={() => setQueueCompleted(true)}
                className="w-full"
              >
                Перейти к финализации
              </Button>
            </div>
          )}
        </aside>
      </div>

      {/* Строка горячих клавиш */}
      <div className="h-8 shrink-0 border-t border-[#E2E8F0] bg-white flex items-center justify-center gap-5 text-[11px] text-[#475569]">
        <span><kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">1</kbd> подтвердить</span>
        <span><kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">2</kbd> отклонить</span>
        <span><kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">3</kbd> уточнить</span>
        <span><kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">←</kbd> <kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">→</kbd> навигация</span>
        <span><kbd className="mono px-1.5 py-0.5 border border-[#CBD5E1] rounded bg-[#F8FAFC]">Space</kbd> увеличить</span>
      </div>
    </div>
  );
}