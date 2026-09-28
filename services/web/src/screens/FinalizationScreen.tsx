import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, FileType, FileCode, AlertCircle, Undo2 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import { useToast } from '../components/Toast';
import { api, ApiError, getSession } from '../api/client';
import { toProtocol, type ApiProtocol } from '../api/adapters';
import type { Protocol } from '../types';

interface Props {
  protocolId: string;
  onBack: () => void;
}

// Not exposed anywhere else in the interface (Sidebar shows the raw role
// string from the session) — kept local to this screen rather than in
// labels.ts, which Task 5 does not otherwise touch.
const ROLE_LABELS: Record<string, string> = {
  INSPECTOR: 'Инспектор',
  SUPERVISOR: 'Супервизор',
  ADMIN: 'Администратор',
  ML_ENGINEER: 'ML-инженер',
};

function StatTile({ label, value, total, accent }: {
  label: string; value: number; total?: number; accent?: 'ok' | 'warn' | 'danger';
}) {
  const color = accent === 'ok' ? '#027A48' : accent === 'warn' ? '#B54708' : accent === 'danger' ? '#B42318' : '#0F172A';
  return (
    <div className="flex-1 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
      <div className="text-[12px] text-[#475569] mb-1">{label}</div>
      <div className="text-[28px] leading-9 font-semibold num" style={{ color }}>
        {value}
        {total !== undefined && <span className="text-[#94A3B8] text-[16px] ml-1">из {total}</span>}
      </div>
    </div>
  );
}

export default function FinalizationScreen({ protocolId, onBack }: Props) {
  const { push } = useToast();
  const session = getSession();

  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showFinalizeModal, setShowFinalizeModal] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [pendingCandidates, setPendingCandidates] = useState<number | null>(null);

  const [showUnfinalizeModal, setShowUnfinalizeModal] = useState(false);
  const [unfinalizeReason, setUnfinalizeReason] = useState('');
  const [unfinalizing, setUnfinalizing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const data = await api<ApiProtocol>(`/api/v1/protocols/${protocolId}`);
        if (!cancelled) setProtocol(toProtocol(data));
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить протокол');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [protocolId]);

  const isFinalized = protocol?.status === 'PROTOCOL_FINALIZED';
  const canFinalize = !!protocol && !isFinalized && !finalizing;
  // Section 9.3: only a supervisor or an administrator may undo a
  // finalization — an inspector who finalized it cannot take it back alone.
  const canUnfinalize = isFinalized
    && (session?.user.role === 'SUPERVISOR' || session?.user.role === 'ADMIN');

  const handleFinalizeConfirm = async () => {
    if (!protocol) return;
    setFinalizing(true);
    try {
      const data = await api<ApiProtocol>(`/api/v1/protocols/${protocolId}/finalize`, { method: 'POST' });
      setProtocol(toProtocol(data));
      setPendingCandidates(null);
      setShowFinalizeModal(false);
      push({ kind: 'success', message: 'Протокол финализирован' });
    } catch (err) {
      setShowFinalizeModal(false);
      if (err instanceof ApiError && err.code === 'CANDIDATES_PENDING') {
        // The 409 body carries the pending check ids, but the shared client
        // (client.ts) only surfaces `error`/`message` from an error
        // response — the count already on screen (this protocol's own
        // summary) says the same thing without a second endpoint.
        setPendingCandidates(protocol.summary.candidates);
        push({
          kind: 'error',
          message: 'Финализация невозможна',
          detail: `Остались необработанные кандидаты: ${protocol.summary.candidates}`,
        });
      } else {
        push({
          kind: 'error',
          message: 'Не удалось финализировать протокол',
          detail: err instanceof ApiError ? err.message : undefined,
        });
      }
    } finally {
      setFinalizing(false);
    }
  };

  const handleUnfinalizeConfirm = async () => {
    if (!unfinalizeReason.trim()) return;
    setUnfinalizing(true);
    try {
      const data = await api<ApiProtocol>(`/api/v1/protocols/${protocolId}/unfinalize`, {
        method: 'POST',
        body: JSON.stringify({ reason: unfinalizeReason.trim() }),
      });
      setProtocol(toProtocol(data));
      setShowUnfinalizeModal(false);
      setUnfinalizeReason('');
      push({ kind: 'success', message: 'Финализация отменена' });
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось отменить финализацию',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setUnfinalizing(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
          <div className="h-6 w-64 bg-[#EDF1F7] rounded animate-pulse" />
        </div>
        <div className="flex-1 flex items-center justify-center text-[13px] text-[#94A3B8]">Загрузка…</div>
      </div>
    );
  }

  if (loadError || !protocol) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <PageHeader
          crumbs={['Объекты', 'Финализация']}
          title="Финализация протокола"
          actions={
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Назад
            </Button>
          }
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            {loadError ?? 'Протокол не найден'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', `Протокол № ${protocol.number}`, 'Финализация']}
        title="Финализация протокола"
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Назад к верификации
            </Button>
            {canUnfinalize && (
              <Button variant="secondary" icon={<Undo2 size={14} />} onClick={() => setShowUnfinalizeModal(true)}>
                Отменить финализацию
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!canFinalize}
              title={isFinalized ? 'Протокол уже финализирован' : undefined}
              onClick={() => setShowFinalizeModal(true)}
            >
              Финализировать протокол
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {isFinalized && (
          <div className="mb-5 bg-[#ECFDF3] border border-[#A6F4C5] rounded-lg px-4 py-3 text-[13px] text-[#027A48]">
            Протокол финализирован{protocol.finalizedAt ? ` ${protocol.finalizedAt}` : ''}. Дозагрузка документов и изменение решений недоступны.
            Отмена финализации — только супервизором или администратором.
          </div>
        )}

        {pendingCandidates !== null && !isFinalized && (
          <div className="mb-5 bg-[#FFFAEB] border border-[#FEDF89] rounded-lg px-4 py-3 text-[13px] text-[#B54708] flex items-start gap-2">
            <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden />
            Финализация невозможна: остались необработанные кандидаты — {pendingCandidates}.
            Вернитесь к верификации и примите решение по каждому из них.
          </div>
        )}

        {/* Сводка */}
        <div className="flex gap-4 mb-5">
          <StatTile label="Подтверждено нарушений" value={protocol.summary.confirmed} accent="danger" />
          <StatTile label="Отклонено" value={protocol.summary.negative} />
          <StatTile label="Требует уточнения" value={protocol.summary.clarificationRequired} accent="warn" />
          <StatTile
            label="Осталось кандидатов"
            value={protocol.summary.candidates}
            accent={protocol.summary.candidates > 0 ? 'warn' : 'ok'}
          />
        </div>

        {/* Свёрнутый блок MISSING_EVIDENCE */}
        <details className="bg-white border border-[#E2E8F0] rounded-lg mb-5">
          <summary className="px-4 py-3 cursor-pointer text-[13px] text-[#0F172A] flex items-center gap-2 select-none">
            <AlertCircle size={14} className="text-[#475569]" aria-hidden />
            Без доказательств — <span className="num">{protocol.summary.noEvidence}</span> записей
            <span className="text-[12px] text-[#94A3B8] ml-2">· не включаются в число нарушений</span>
          </summary>
          <div className="px-4 pb-4 text-[12px] text-[#475569]">
            Список параметров без достаточного пакета документов для проверки. Не влияют на итоговый протокол и не учитываются при выгрузке в ИАИС.
          </div>
        </details>

        {/* Выгрузка */}
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 mb-5">
          <div className="text-[13px] font-medium text-[#0F172A] mb-3">Выгрузка протокола</div>
          <div className="flex gap-3">
            <Button variant="secondary" icon={<FileText size={14} />} disabled title="Появится в следующем обновлении">PDF</Button>
            <Button variant="secondary" icon={<FileType size={14} />} disabled title="Появится в следующем обновлении">DOCX</Button>
            <Button variant="secondary" icon={<FileCode size={14} />} disabled title="Появится в следующем обновлении">XML</Button>
          </div>
        </div>

        {/* ИАИС */}
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 mb-5">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-[#94A3B8] shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-[#0F172A]">
                Передача в ИАИС «Разрешения и нарушения»
              </div>
              <div className="text-[12px] text-[#475569] mt-1">
                {protocol.syncStatus === 'SYNCED'
                  ? 'Протокол передан.'
                  : protocol.syncStatus === 'PENDING_SYNC'
                    ? 'Передача поставлена в очередь.'
                    : 'Автоматическая передача пока не подключена — решение инспектора уже зафиксировано в протоколе независимо от неё.'}
              </div>
            </div>
          </div>
        </div>

        {/* Финальная кнопка */}
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="lg"
            disabled={!canFinalize}
            onClick={() => setShowFinalizeModal(true)}
          >
            Финализировать протокол
          </Button>
        </div>

        <div className="mt-6 text-[12px] text-[#94A3B8] mono">
          {isFinalized
            ? `Финализирован: ${protocol.finalizedAt ?? '—'}`
            : session
              ? `Финализацию выполнит: ${session.user.fullName || session.user.login} · ${ROLE_LABELS[session.user.role] ?? session.user.role}`
              : null}
        </div>
      </div>

      {/* Модальное окно финализации */}
      {showFinalizeModal && (
        <div
          className="fixed inset-0 z-50 bg-[#0F172A]/40 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="finalize-title"
        >
          <div className="w-[480px] bg-white rounded-xl shadow-lg p-6">
            <h3 id="finalize-title" className="text-[16px] font-semibold text-[#0F172A] mb-3">
              Финализировать протокол?
            </h3>
            <p className="text-[13px] text-[#475569] leading-5 mb-5">
              После финализации дозагрузка документов и изменение решений станут невозможны.
              Отмена финализации доступна только супервизору или администратору.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowFinalizeModal(false)} disabled={finalizing}>Отмена</Button>
              <Button variant="primary" onClick={() => void handleFinalizeConfirm()} disabled={finalizing}>
                {finalizing ? 'Финализация…' : 'Финализировать'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Модальное окно отмены финализации — причина обязательна (раздел 9.3) */}
      {showUnfinalizeModal && (
        <div
          className="fixed inset-0 z-50 bg-[#0F172A]/40 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby="unfinalize-title"
        >
          <div className="w-[480px] bg-white rounded-xl shadow-lg p-6">
            <h3 id="unfinalize-title" className="text-[16px] font-semibold text-[#0F172A] mb-3">
              Отменить финализацию?
            </h3>
            <p className="text-[13px] text-[#475569] leading-5 mb-3">
              Протокол вернётся в статус «Верификация завершена». Укажите причину — она попадёт в журнал аудита.
            </p>
            <textarea
              value={unfinalizeReason}
              onChange={(e) => setUnfinalizeReason(e.target.value)}
              rows={3}
              placeholder="Причина отмены финализации (обязательно)"
              className="w-full px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B] mb-5"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowUnfinalizeModal(false)} disabled={unfinalizing}>Отмена</Button>
              <Button
                variant="danger"
                onClick={() => void handleUnfinalizeConfirm()}
                disabled={unfinalizing || !unfinalizeReason.trim()}
              >
                {unfinalizing ? 'Отмена финализации…' : 'Отменить финализацию'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
