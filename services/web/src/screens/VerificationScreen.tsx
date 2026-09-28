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
import { SkeletonQueue, SkeletonEvidencePanel } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { reasonCodes, reasonLabels, approvalLabels } from '../labels';
import { api, ApiError, splitComposite } from '../api/client';
import { toFinding, type ApiFinding } from '../api/adapters';
import type { Finding, ReasonCode, RevisionCard } from '../types';

interface Props {
  protocolId: string;
  onBack: () => void;
  onFinish: (protocolId: string) => void;
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
  const { push } = useToast();

  const [candidates, setCandidates] = useState<Finding[]>([]);
  // Findings the server has confirmed a decision for, keyed by id — the
  // response from POST .../verdict replaces the finding here directly; this
  // screen never recomputes a status on its own (Plan 7, Task 5).
  const [decided, setDecided] = useState<Record<string, Finding>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [index, setIndex] = useState(0);
  const [comment, setComment] = useState('');
  const [showReasons, setShowReasons] = useState(false);
  const [pendingReason, setPendingReason] = useState<ReasonCode | undefined>(undefined);
  const [selectedRevisionIdx, setSelectedRevisionIdx] = useState<0 | 1 | null>(null);
  const [queueCompleted, setQueueCompleted] = useState(false);

  // Shared by the initial load and by the split button below (Plan: a split
  // composite's atoms only become ordinary candidates once the queue is
  // re-fetched - the server, not this screen, decides what the queue is now).
  const loadCandidates = async (): Promise<boolean> => {
    try {
      const response = await api<{ items: ApiFinding[] }>(
        `/api/v1/protocols/${protocolId}/findings?status=CANDIDATE`,
      );
      setCandidates(response.items.map(toFinding));
      return true;
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить кандидатов');
      return false;
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      const ok = await loadCandidates();
      if (!cancelled && ok) setIndex(0);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocolId]);

  const baseFinding: Finding | undefined = candidates[index];
  const finding: Finding | undefined = baseFinding ? (decided[baseFinding.id] ?? baseFinding) : undefined;

  const processedCount = Object.keys(decided).length;
  const allProcessed = candidates.length > 0 && processedCount === candidates.length;

  const isClarification = !!finding?.clarificationConflict;
  const isComposite = !!finding?.composite;

  /* ─── Клавиатурные сокращения ─── */
  useEffect(() => {
    if (queueCompleted || !finding || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
      if (isClarification) {
        if (e.key === '1') { e.preventDefault(); if (selectedRevisionIdx !== null) handleClarificationSave(); }
        else if (e.key === '3') { e.preventDefault(); setShowReasons(true); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); goNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); goPrev(); }
        return;
      }
      if (isComposite) {
        // Section 9.2: no partial decision on a composite - "1"/"2"/"3" do
        // nothing until it is split; only navigation stays available.
        if (e.key === '1') { e.preventDefault(); void handleCompositeSplit(); }
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
  }, [
    finding?.id, showReasons, pendingReason, comment, selectedRevisionIdx,
    queueCompleted, isClarification, isComposite, saving,
  ]);

  const resetLocal = () => {
    setComment('');
    setShowReasons(false);
    setPendingReason(undefined);
    setSelectedRevisionIdx(null);
  };

  const goNext = () => {
    if (index < candidates.length - 1) {
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

  // Every real decision goes through here — the server's response (already
  // in the finding form the rest of the screen reads) replaces the local
  // entry, so the screen never has to decide the new status itself.
  const submitVerdict = async (
    decision: 'CONFIRMED_VIOLATION' | 'NEGATIVE_VERIFIED' | 'CLARIFICATION_REQUIRED',
    reasonCode?: ReasonCode,
  ) => {
    if (!finding) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { decision };
      if (reasonCode) body.reason_code = reasonCode;
      if (comment.trim()) body.comment = comment.trim();
      const updated = await api<ApiFinding>(`/api/v1/findings/${finding.id}/verdict`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const mapped = toFinding(updated);
      setDecided((prev) => ({ ...prev, [mapped.id]: mapped }));
      window.setTimeout(goNext, 120);
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось сохранить решение',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleConfirm = () => {
    if (isComposite || saving) return;
    void submitVerdict('CONFIRMED_VIOLATION');
  };

  const handleRejectSave = () => {
    if (!pendingReason || !comment.trim() || saving) return;
    void submitVerdict('NEGATIVE_VERIFIED', pendingReason);
  };

  const handleClarify = () => {
    if (saving) return;
    void submitVerdict('CLARIFICATION_REQUIRED');
  };

  const handleEditDecision = () => {
    if (!finding) return;
    setDecided((prev) => {
      const next = { ...prev };
      delete next[finding.id];
      return next;
    });
    resetLocal();
  };

  // The engine has no endpoint yet to recompute a check after an inspector
  // resolves a revision conflict (Plan 6 scope, deferred) — updated locally
  // only, same as the mock this screen replaces. toFinding() never sets
  // clarificationConflict from real data, so this path stays unreachable
  // until that endpoint exists.
  const handleClarificationSave = () => {
    if (selectedRevisionIdx === null || !finding?.clarificationConflict) return;
    const chosenRevision = finding.clarificationConflict.revisions[selectedRevisionIdx];
    const updatedFinding: Finding = {
      ...finding,
      actual: chosenRevision.extractedValue,
      actualEvidence: {
        ...finding.actualEvidence,
        stage: 'RD',
        documentCode: chosenRevision.documentCode,
        revision: chosenRevision.revision,
        approvalStatus: chosenRevision.approvalStatus,
        sheetPage: chosenRevision.sheetPage,
        sha256: chosenRevision.sha256,
        extractedValue: chosenRevision.extractedValue,
      },
      clarificationConflict: undefined,
    };
    setCandidates((prev) => prev.map((f) => (f.id === updatedFinding.id ? updatedFinding : f)));
    setSelectedRevisionIdx(null);
  };

  // Section 9.2: a composite candidate cannot be confirmed partially - the
  // only action available on it is splitting it into its atomic findings
  // (POST /findings/:id/split). The queue is re-fetched afterwards so the
  // atoms appear as ordinary candidates the inspector then decides one by
  // one, same as any other candidate.
  const handleCompositeSplit = async () => {
    if (!finding?.composite || saving) return;
    setSaving(true);
    try {
      await splitComposite(finding.id);
      const ok = await loadCandidates();
      if (ok) {
        setIndex(0);
        resetLocal();
        push({ kind: 'success', message: `Кандидат разделён на ${finding.composite.atoms.length} находок` });
      }
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось разделить кандидата',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const progress = useMemo(
    () => (candidates.length > 0 ? ((index + 1) / candidates.length) * 100 : 0),
    [index, candidates.length],
  );

  if (loading) {
    return (
      <div className="h-screen flex flex-col bg-[#F5F7FA] overflow-hidden">
        <div className="h-11 shrink-0 px-6 border-b border-[#E2E8F0] bg-white flex items-center gap-4">
          <button type="button" onClick={onBack} className="text-[13px] text-[#475569] hover:text-[#0F172A] flex items-center gap-1">
            <ArrowLeft size={14} /> К протоколу
          </button>
        </div>
        <div className="flex-1 flex min-h-0">
          <aside className="w-[280px] shrink-0 border-r border-[#E2E8F0] bg-white overflow-y-auto">
            <SkeletonQueue />
          </aside>
          <section className="flex-1 min-w-0 flex gap-3 p-5">
            <SkeletonEvidencePanel />
            <SkeletonEvidencePanel />
          </section>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="h-screen flex flex-col bg-[#F5F7FA] overflow-hidden">
        <div className="h-11 shrink-0 px-6 border-b border-[#E2E8F0] bg-white flex items-center gap-4">
          <button type="button" onClick={onBack} className="text-[13px] text-[#475569] hover:text-[#0F172A] flex items-center gap-1">
            <ArrowLeft size={14} /> К протоколу
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            {loadError}
          </div>
        </div>
      </div>
    );
  }

  if (candidates.length === 0 || !finding) {
    return (
      <div className="h-screen flex flex-col bg-[#F5F7FA] overflow-hidden">
        <div className="h-11 shrink-0 px-6 border-b border-[#E2E8F0] bg-white flex items-center gap-4">
          <button type="button" onClick={onBack} className="text-[13px] text-[#475569] hover:text-[#0F172A] flex items-center gap-1">
            <ArrowLeft size={14} /> К протоколу
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="w-[480px] bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="no-candidates"
              title="Нет кандидатов для верификации"
              description="В этом протоколе не осталось необработанных кандидатов."
              action={<Button variant="secondary" onClick={onBack}>Вернуться к протоколу</Button>}
            />
          </div>
        </div>
      </div>
    );
  }

  /* ─── Экран «Все кандидаты обработаны» ─── */
  if (queueCompleted) {
    const confirmedCount = Object.values(decided).filter((f) => f.decision?.status === 'CONFIRMED_VIOLATION').length;
    const rejectedCount = Object.values(decided).filter((f) => f.decision?.status === 'NEGATIVE_VERIFIED').length;
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
              description={`Обработано ${processedCount} из ${candidates.length} кандидатов. Подтверждено нарушений: ${confirmedCount}. Отклонено: ${rejectedCount}.`}
              action={
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => { setQueueCompleted(false); setIndex(candidates.length - 1); }}
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
          Обработано {processedCount} из {candidates.length}
        </span>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* ЛЕВАЯ ПАНЕЛЬ */}
        <aside className="w-[280px] shrink-0 border-r border-[#E2E8F0] bg-white flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-[#E2E8F0]">
            <div className="flex items-center justify-between text-[12px] text-[#475569] mb-2">
              <span>Очередь кандидатов</span>
              <span className="num">{index + 1} из {candidates.length}</span>
            </div>
            <div className="h-1 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
              <div className="h-full bg-[#1B4E9B]" style={{ width: `${progress}%` }} />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {candidates.map((f, i) => {
              const isActive = i === index;
              const isDone = !!decided[f.id];
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

          {/* Блок составного кандидата - что войдёт в разделение */}
          {isComposite && finding.composite && (
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Layers size={14} className="text-[#5925DC]" aria-hidden />
                <div className="text-[13px] font-medium text-[#0F172A]">
                  Составной кандидат
                </div>
                <span className="text-[11px] text-[#94A3B8]">
                  · {finding.composite.atoms.length} находок после разделения
                </span>
              </div>
              {finding.composite.note && (
                <div className="text-[12px] text-[#5925DC] bg-[#F4F3FF] border border-[#E9D7FE] rounded-md px-3 py-2 mb-3">
                  {finding.composite.note}
                </div>
              )}
              <div className="grid grid-cols-1 gap-1 max-h-[180px] overflow-y-auto pr-1">
                {finding.composite.atoms.map((atom) => (
                  <div
                    key={atom.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-md border border-[#E2E8F0]"
                  >
                    <span className="mono text-[12px] text-[#0F172A] shrink-0 w-[70px]">{atom.code}</span>
                    <span className="text-[13px] text-[#0F172A] flex-1 truncate">{atom.title}</span>
                    <span className="text-[12px] text-[#475569] num shrink-0">{atom.expected}</span>
                    <span className="text-[#CBD5E1]">→</span>
                    <span className="text-[12px] text-[#0F172A] num shrink-0">{atom.actual}</span>
                    <span className="text-[12px] text-[#475569] num shrink-0 w-[60px] text-right">{atom.delta}</span>
                  </div>
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
            {finding.decision ? (
              <div className="border border-[#E2E8F0] rounded-lg p-3 bg-[#F8FAFC]">
                <StatusBadge status={finding.status} />
                <div className="mt-2 text-[12px] text-[#475569]">
                  {finding.decision.inspector} · {finding.decision.timestamp}
                </div>
                {finding.decision.reasonCode && (
                  <div className="mt-1 text-[12px] text-[#475569]">
                    Причина: {reasonLabels[finding.decision.reasonCode]}
                  </div>
                )}
                {finding.decision.comment && (
                  <div className="mt-1 text-[12px] text-[#475569] italic">«{finding.decision.comment}»</div>
                )}
                <button
                  type="button"
                  onClick={handleEditDecision}
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
                  disabled={saving}
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
              /* Составной кандидат - section 9.2: "нельзя подтвердить
                 частично". The only action available is the split itself;
                 confirm/reject/clarify stay unavailable until the atoms it
                 produces are reloaded as ordinary candidates. */
              <>
                <div className="text-[13px] text-[#0F172A] leading-5 mb-1">
                  Составной кандидат нельзя подтвердить частично. Разделите его на атомарные находки — каждая станет отдельным кандидатом с собственным решением.
                </div>
                <Button
                  variant="danger"
                  size="lg"
                  disabled={saving}
                  className="w-full"
                  onClick={() => void handleCompositeSplit()}
                >
                  {saving ? 'Разделение…' : `Разделить на ${finding.composite?.atoms.length ?? 0} находок`}
                </Button>
              </>
            ) : (
              /* Стандартный кандидат */
              <>
                <Button variant="danger" size="lg" onClick={handleConfirm} disabled={saving} className="w-full">
                  Подтвердить нарушение
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={() => setShowReasons(true)}
                  disabled={saving}
                  className="w-full"
                >
                  Отклонить
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  onClick={handleClarify}
                  disabled={saving}
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
                    Комментарий инспектора {showReasons && <span className="text-[#B42318]">· обязателен при отклонении</span>}
                  </div>
                  <textarea
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    rows={3}
                    placeholder={showReasons ? 'Обоснование отклонения (обязательно)' : 'Обоснование решения (необязательно)'}
                    className="w-full px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B]"
                  />
                </div>

                <Button
                  variant="primary"
                  size="lg"
                  icon={<Save size={14} />}
                  disabled={saving || (showReasons && (!pendingReason || !comment.trim()))}
                  onClick={showReasons ? handleRejectSave : handleConfirm}
                  className="w-full mt-1"
                >
                  {saving ? 'Сохранение…' : 'Сохранить решение'}
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
