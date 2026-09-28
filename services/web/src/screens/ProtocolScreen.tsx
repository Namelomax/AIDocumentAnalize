import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArrowLeft, FileText, FileType, FileCode, CheckCircle2, Clock } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import PriorityIndicator from '../components/PriorityIndicator';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import IncrementalUploadButton from '../components/IncrementalUploadButton';
import SyncStatusChip from '../components/SyncStatusChip';
import { SkeletonTable } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { api, apiBlob, saveBlob, ApiError } from '../api/client';
import { toProtocol, type ApiProtocol } from '../api/adapters';
import { ARCHIVED_PROTOCOL_BANNER, protocolStatusColor, protocolStatusLabels } from '../labels';
import type { DocStage, FindingStatus, Protocol, ReviewPriority } from '../types';

interface Props {
  protocolId: string;
  onBack: () => void;
  onOpenVerification: (protocolId: string) => void;
  onOpenHypotheses: (protocolId: string) => void;
}

type TabKey = 'completeness' | 'candidates' | 'confirmed' | 'verified' | 'hypotheses';

// One status per finding tab; 'completeness' has none — it reads from
// protocol.completeness, a separate table entirely (section 9.2).
const FINDING_TAB_STATUS: Record<Exclude<TabKey, 'completeness'>, FindingStatus> = {
  candidates: 'CANDIDATE',
  confirmed: 'CONFIRMED_VIOLATION',
  verified: 'NEGATIVE_VERIFIED',
  hypotheses: 'SUSPICION',
};

const TAB_LABELS: Record<TabKey, string> = {
  completeness: 'Комплектность и сопоставимость',
  candidates: 'Кандидаты',
  confirmed: 'Подтверждённые нарушения',
  verified: 'Проверено, расхождений нет',
  hypotheses: 'Гипотезы свободного поиска',
};

const TAB_ORDER: TabKey[] = ['completeness', 'candidates', 'confirmed', 'verified', 'hypotheses'];

// Extension of the task's own "pdf" | "docx" | "xml" export formats
// (routes/export.ts), kept local to the two screens that offer a download.
type ExportFormat = 'pdf' | 'docx' | 'xml';

export default function ProtocolScreen({
  protocolId, onBack, onOpenVerification, onOpenHypotheses
}: Props) {
  const { push } = useToast();
  const [protocol, setProtocol] = useState<Protocol | null>(null);
  const [objectName, setObjectName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('candidates');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | ReviewPriority>('ALL');
  const [exportingFormat, setExportingFormat] = useState<ExportFormat | null>(null);

  // GET /api/v1/protocols/:id/export?format=… (task spec) - the filename
  // matches the same "protocol-<number>-v<версия>" the inspector already
  // sees in the page title, built from the same fields the API's own
  // export/model.ts names the file with.
  const handleExport = async (format: ExportFormat) => {
    if (!protocol) return;
    setExportingFormat(format);
    try {
      const blob = await apiBlob(`/api/v1/protocols/${protocolId}/export?format=${format}`);
      saveBlob(blob, `protocol-${protocol.number}-v${protocol.version}.${format}`);
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось выгрузить протокол',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const loadProtocol = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    setLoadError(null);
    try {
      const data = await api<ApiProtocol>(`/api/v1/protocols/${protocolId}`);
      const mapped = toProtocol(data);
      setProtocol(mapped);
      // Best-effort only — the breadcrumb falls back to a generic label
      // if this second call fails, the protocol itself already loaded.
      try {
        const objectDetail = await api<{ name: string }>(`/api/v1/objects/${mapped.objectId}`);
        setObjectName(objectDetail.name);
      } catch {
        // Ignored — see comment above.
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить протокол');
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [protocolId]);

  useEffect(() => {
    if (!protocolId) {
      setLoading(false);
      setLoadError('Протокол не выбран');
      return;
    }
    void loadProtocol(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [protocolId]);

  // Customer's ТЗ "Дозагрузка файлов": once the worker's incremental update
  // finishes, this screen's own protocol id (unlike ObjectScreen's, which
  // points at the object) may now be a SUPERSEDED version - the freshly
  // created one is a different id entirely, which only a real navigation
  // (not a re-fetch of protocolId) can follow. A re-fetch here still shows
  // the inspector the accurate (now archived) state of what they had open,
  // with the banner below explaining why nothing on it is actionable anymore.
  const handleIncrementalUpdate = useCallback(() => { void loadProtocol(false); }, [loadProtocol]);

  const counts = useMemo<Record<TabKey, number>>(() => {
    if (!protocol) return { completeness: 0, candidates: 0, confirmed: 0, verified: 0, hypotheses: 0 };
    return {
      completeness: protocol.completeness.length,
      candidates: protocol.findings.filter((f) => f.status === 'CANDIDATE').length,
      confirmed: protocol.findings.filter((f) => f.status === 'CONFIRMED_VIOLATION').length,
      verified: protocol.findings.filter((f) => f.status === 'NEGATIVE_VERIFIED').length,
      // Hypotheses live in their own section of the protocol (protocol.suspicions),
      // never in `findings` (Global Constraint: a hypothesis is not a violation).
      hypotheses: protocol.suspicions.length,
    };
  }, [protocol]);

  const findingRows = useMemo(() => {
    if (!protocol || activeTab === 'completeness') return [];
    // Hypotheses are a disjoint list of their own (protocol.suspicions), not
    // a finding_status to filter `findings` by — see counts.hypotheses above.
    let list = activeTab === 'hypotheses'
      ? protocol.suspicions
      : protocol.findings.filter((f) => f.status === FINDING_TAB_STATUS[activeTab]);
    if (priorityFilter !== 'ALL') list = list.filter((f) => f.priority === priorityFilter);
    return list;
  }, [protocol, activeTab, priorityFilter]);

  const completenessRows = protocol?.completeness ?? [];
  const candidatesCount = protocol?.findings.filter((f) => f.status === 'CANDIDATE').length ?? 0;

  // Customer's ТЗ "Дозагрузка файлов": allowed up to finalization, and never
  // on an already-archived (SUPERSEDED) version - the same two statuses
  // services/api's routes/processDocuments.ts itself refuses (PARSING is
  // covered by the process's own status, which this screen does not poll;
  // the endpoint still refuses it server-side either way).
  const isArchived = protocol?.status === 'SUPERSEDED';
  const uploadDisabled = !protocol || protocol.status === 'PROTOCOL_FINALIZED' || isArchived;
  const uploadDisabledReason = protocol?.status === 'PROTOCOL_FINALIZED'
    ? 'Протокол финализирован — дозагрузка невозможна'
    : isArchived ? ARCHIVED_PROTOCOL_BANNER : undefined;

  // "Тип проверки" is derived from the stages the protocol's own findings
  // actually cite, not a hardcoded label — a protocol with only PD+RD
  // findings never claims to have checked ИД.
  const stagesInPlay = useMemo(() => {
    const set = new Set<DocStage>();
    protocol?.findings.forEach((f) => f.sources.forEach((s) => set.add(s)));
    return set;
  }, [protocol]);
  const checkTypeLabel = useMemo(() => {
    if (stagesInPlay.size === 0) return 'Нет данных';
    return (['PD', 'RD', 'ID'] as const)
      .filter((s) => stagesInPlay.has(s))
      .map((s) => ({ PD: 'ПД', RD: 'РД', ID: 'ИД' }[s]))
      .join(' + ');
  }, [stagesInPlay]);

  if (loading) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
          <div className="h-6 w-64 bg-[#EDF1F7] rounded animate-pulse" />
        </div>
        <div className="flex-1 overflow-auto px-8 py-5">
          <SkeletonTable rows={8} />
        </div>
      </div>
    );
  }

  if (loadError || !protocol) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <PageHeader
          crumbs={['Объекты', 'Протокол']}
          title="Протокол"
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
        crumbs={['Объекты', objectName ?? 'Объект', `Протокол № ${protocol.number}`]}
        title={`Протокол проверки № ${protocol.number}`}
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Назад
            </Button>
            <IncrementalUploadButton
              processId={protocol.processId}
              disabled={uploadDisabled}
              disabledReason={uploadDisabledReason}
              label="Дозагрузить документы"
              onUpdated={handleIncrementalUpdate}
            />
            <Button
              variant="secondary"
              icon={<FileText size={14} />}
              disabled={exportingFormat !== null}
              title="Выгрузить протокол в PDF"
              onClick={() => void handleExport('pdf')}
            >
              {exportingFormat === 'pdf' ? 'Экспорт…' : 'PDF'}
            </Button>
            <Button
              variant="secondary"
              icon={<FileType size={14} />}
              disabled={exportingFormat !== null}
              title="Выгрузить протокол в DOCX"
              onClick={() => void handleExport('docx')}
            >
              {exportingFormat === 'docx' ? 'Экспорт…' : 'DOCX'}
            </Button>
            <Button
              variant="secondary"
              icon={<FileCode size={14} />}
              disabled={exportingFormat !== null}
              title="Выгрузить протокол в XML"
              onClick={() => void handleExport('xml')}
            >
              {exportingFormat === 'xml' ? 'Экспорт…' : 'XML'}
            </Button>
            <Button
              variant="primary"
              disabled={candidatesCount > 0 || isArchived}
              title={isArchived
                ? ARCHIVED_PROTOCOL_BANNER
                : candidatesCount > 0
                  ? `Остались необработанные кандидаты: ${candidatesCount}`
                  : 'Завершить верификацию'}
              onClick={() => onOpenVerification(protocolId)}
            >
              Завершить верификацию
            </Button>
          </>
        }
      />

      {isArchived && (
        <div className="mx-8 mt-4 flex items-center gap-2 bg-[#F1F5F9] border border-[#CBD5E1] rounded-lg px-4 py-2.5 text-[13px] text-[#475569]">
          <Archive size={14} aria-hidden />
          {ARCHIVED_PROTOCOL_BANNER}
        </div>
      )}

      <div className="flex-1 overflow-auto px-8 py-5">
        {/* Технические версии */}
        <div className="mono text-[11px] text-[#94A3B8] mb-3">
          matrix_version {protocol.matrixVersion} · model_version {protocol.modelVersion} ·
          dataset_version {protocol.datasetVersion} · hash {protocol.hash.slice(0, 12)}…
        </div>

        {/* Шапка протокола */}
        <div className="grid grid-cols-12 gap-3 mb-4">
          <div className="col-span-8 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide mb-1">Статус протокола</div>
            <div className="flex items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 text-[13px]"
                style={{ color: protocolStatusColor(protocol.status) }}
              >
                {protocol.status === 'VERIFYING'
                  ? <Clock size={14} aria-hidden />
                  : <CheckCircle2 size={14} aria-hidden />}
                {protocolStatusLabels[protocol.status] ?? protocol.status}
              </span>
              <span className="text-[12px] text-[#475569]">
                Создан: <span className="mono text-[#0F172A]">{protocol.createdAt}</span>
              </span>
              <span className="text-[12px] text-[#475569]">
                Версия: <span className="mono text-[#0F172A]">{protocol.version}</span>
              </span>
              {protocol.finalizedAt && (
                <span className="text-[12px] text-[#475569]">
                  Финализирован: <span className="mono text-[#0F172A]">{protocol.finalizedAt}</span>
                </span>
              )}
              <SyncStatusChip
                protocolId={protocolId}
                syncStatus={protocol.syncStatus}
                onRequeued={() => void loadProtocol(false)}
              />
            </div>
          </div>
          <div className="col-span-4 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide mb-1">Тип проверки</div>
            <div className="text-[13px] text-[#0F172A] font-medium">{checkTypeLabel}</div>
            <div className="flex items-center gap-2 mt-1.5">
              <StageBadge stage="PD" active={stagesInPlay.has('PD')} />
              <StageBadge stage="RD" active={stagesInPlay.has('RD')} />
              <StageBadge stage="ID" active={stagesInPlay.has('ID')} />
            </div>
          </div>
        </div>

        {/* Полоса сводки */}
        <div className="bg-[#EDF1F7] border border-[#E2E8F0] rounded-lg px-4 py-2.5 mb-4 text-[12px] text-[#475569] flex items-center gap-3 flex-wrap">
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.checked}</span> параметров проверено</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.candidates}</span> кандидатов</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.confirmed}</span> подтверждено</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.negative}</span> расхождений не выявлено</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.noEvidence}</span> без доказательств</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.notApplicable}</span> неприменимо</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.notComparable}</span> нельзя сопоставить</span>
          <span className="text-[#CBD5E1]">·</span>
          <span><span className="num text-[#0F172A] font-medium">{protocol.summary.clarificationRequired}</span> требует уточнения</span>
        </div>

        {/* Вкладки */}
        <div className="border-b border-[#E2E8F0] flex items-center gap-1 mb-3">
          {TAB_ORDER.map((key) => {
            const isActive = key === activeTab;
            return (
              <button
                key={key}
                type="button"
                onClick={() => { setActiveTab(key); setPriorityFilter('ALL'); }}
                className={[
                  'px-3 h-9 text-[13px] rounded-t-md transition-colors flex items-center gap-2',
                  isActive
                    ? 'text-[#1B4E9B] border-b-2 border-[#1B4E9B] bg-white'
                    : 'text-[#475569] hover:text-[#0F172A]'
                ].join(' ')}
              >
                <span>{TAB_LABELS[key]}</span>
                <span className={[
                  'num text-[11px] px-1.5 rounded-[4px]',
                  isActive ? 'bg-[#E8F0FB] text-[#1B4E9B]' : 'bg-[#EDF1F7] text-[#475569]'
                ].join(' ')}>
                  {counts[key]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Фильтры над таблицей находок (комплектность своих приоритетов не несёт) */}
        {activeTab !== 'completeness' && (
          <div className="flex items-center gap-3 mb-3">
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as 'ALL' | ReviewPriority)}
              className="h-9 px-3 border border-[#CBD5E1] rounded-md bg-white text-[13px] text-[#475569] outline-none focus:border-[#1B4E9B]"
            >
              <option value="ALL">Приоритет: все</option>
              <option value="HIGH">HIGH</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="LOW">LOW</option>
            </select>
            {priorityFilter !== 'ALL' && (
              <button
                type="button"
                onClick={() => setPriorityFilter('ALL')}
                className="text-[12px] text-[#1B4E9B] hover:underline"
              >
                Сбросить фильтр
              </button>
            )}
          </div>
        )}

        {/* Плашка вкладки гипотез */}
        {activeTab === 'hypotheses' && counts.hypotheses > 0 && !isArchived && (
          <div className="mb-3 flex items-center justify-between bg-[#EDF1F7] border border-[#E2E8F0] rounded-lg px-4 py-2.5">
            <span className="text-[13px] text-[#475569]">
              Гипотезы не входят в число нарушений и не используются для обучения модели.
            </span>
            <Button variant="primary" onClick={() => onOpenHypotheses(protocolId)}>
              Открыть полный список
            </Button>
          </div>
        )}

        {/* Комплектность и сопоставимость — отдельная таблица: у строки нет
            ни ожидаемого/фактического значения, ни доказательств (раздел
            9.2 ТЗ требует, чтобы этот раздел не смешивался с находками). */}
        {activeTab === 'completeness' ? (
          completenessRows.length === 0 ? (
            <div className="bg-white border border-[#E2E8F0] rounded-lg">
              <EmptyState kind="no-candidates" title="Нет записей" description="В этом протоколе нет параметров с проблемами комплектности или сопоставимости." />
            </div>
          ) : (
            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="bg-[#EDF1F7] text-[#475569] text-[12px]">
                    <th className="text-left font-medium px-3 h-10 w-[100px]">Код</th>
                    <th className="text-left font-medium px-3 h-10">Наименование параметра</th>
                    <th className="text-left font-medium px-3 h-10 w-[180px]">Статус</th>
                    <th className="text-left font-medium px-3 h-10">Обоснование</th>
                  </tr>
                </thead>
                <tbody>
                  {completenessRows.map((row) => (
                    <tr key={row.paramCode} className="h-10 border-t border-[#E2E8F0]">
                      <td className="px-3 mono text-[#0F172A]">{row.paramCode}</td>
                      <td className="px-3 text-[#0F172A]">{row.parameterName}</td>
                      <td className="px-3"><StatusBadge status={row.status} /></td>
                      <td className="px-3 text-[#475569]">{row.rationale || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : loading ? (
          <SkeletonTable rows={8} />
        ) : findingRows.length === 0 ? (
          <div className="bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind={priorityFilter !== 'ALL' ? 'no-filter-results' : 'no-candidates'}
              action={
                priorityFilter !== 'ALL' ? (
                  <Button variant="secondary" onClick={() => setPriorityFilter('ALL')}>
                    Сбросить фильтр
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="bg-[#EDF1F7] text-[#475569] text-[12px]">
                  <th className="text-left font-medium px-3 h-10 w-[80px]">Код</th>
                  <th className="text-left font-medium px-3 h-10 w-[60px]">Раздел</th>
                  <th className="text-left font-medium px-3 h-10">Наименование параметра</th>
                  <th className="text-right font-medium px-3 h-10 w-[120px]">Ожидается</th>
                  <th className="text-right font-medium px-3 h-10 w-[120px]">Фактически</th>
                  <th className="text-right font-medium px-3 h-10 w-[100px]">Δ</th>
                  <th className="text-left font-medium px-3 h-10 w-[110px]">Источники</th>
                  <th className="text-left font-medium px-3 h-10 w-[110px]">Приоритет</th>
                  <th className="text-left font-medium px-3 h-10 w-[180px]">Статус</th>
                  <th className="text-right font-medium px-3 h-10 w-[110px]" />
                </tr>
              </thead>
              <tbody>
                {findingRows.map((f) => (
                  <tr key={f.id} className="h-10 border-t border-[#E2E8F0] hover:bg-[#E8F0FB]">
                    <td className="px-3 mono text-[#0F172A]">{f.code}</td>
                    <td className="px-3 text-[#475569]">{f.section}</td>
                    <td className="px-3 text-[#0F172A] truncate">{f.title}</td>
                    <td className="px-3 text-right num text-[#0F172A]">{f.expected}</td>
                    <td className="px-3 text-right num text-[#0F172A]">{f.actual}</td>
                    <td className="px-3 text-right num text-[#475569]">{f.delta}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-1">
                        <StageBadge stage="PD" active={f.sources.includes('PD')} />
                        <StageBadge stage="RD" active={f.sources.includes('RD')} />
                        <StageBadge stage="ID" active={f.sources.includes('ID')} />
                      </div>
                    </td>
                    <td className="px-3"><PriorityIndicator priority={f.priority} /></td>
                    <td className="px-3"><StatusBadge status={f.status} /></td>
                    <td className="px-3 text-right">
                      {isArchived ? null : f.status === 'CANDIDATE' ? (
                        <Button variant="primary" onClick={() => onOpenVerification(protocolId)}>
                          Проверить
                        </Button>
                      ) : f.status === 'SUSPICION' ? (
                        <Button variant="secondary" onClick={() => onOpenHypotheses(protocolId)}>
                          Привязать
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
