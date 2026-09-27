import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Download, CheckCircle2 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StatusBadge from '../components/StatusBadge';
import PriorityIndicator from '../components/PriorityIndicator';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTable } from '../components/Skeleton';
import { protocol, processStatusLabels } from '../mocks/data';
import type { FindingStatus, ReviewPriority } from '../types';

interface Props {
  protocolId: string;
  onBack: () => void;
  onOpenVerification: (protocolId: string) => void;
  onOpenHypotheses: (protocolId: string) => void;
}

type TabKey = 'completeness' | 'candidates' | 'confirmed' | 'verified' | 'hypotheses';

interface TabDef {
  key: TabKey;
  label: string;
  statuses: FindingStatus[];
}

const TABS: TabDef[] = [
  { key: 'completeness', label: 'Комплектность и сопоставимость',
    statuses: ['MISSING_EVIDENCE', 'NOT_APPLICABLE', 'NOT_COMPARABLE', 'CLARIFICATION_REQUIRED'] },
  { key: 'candidates',  label: 'Кандидаты',
    statuses: ['CANDIDATE'] },
  { key: 'confirmed',   label: 'Подтверждённые нарушения',
    statuses: ['CONFIRMED_VIOLATION'] },
  { key: 'verified',    label: 'Проверено, расхождений нет',
    statuses: ['NEGATIVE_VERIFIED'] },
  { key: 'hypotheses',  label: 'Гипотезы свободного поиска',
    statuses: ['SUSPICION'] }
];

export default function ProtocolScreen({
  protocolId, onBack, onOpenVerification, onOpenHypotheses
}: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('candidates');
  const [loading, setLoading] = useState(true);
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | ReviewPriority>('ALL');

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 500);
    return () => window.clearTimeout(t);
  }, []);

  const counts = useMemo<Record<TabKey, number>>(() => ({
    completeness: 19, candidates: 14, confirmed: 3, verified: 96, hypotheses: 5
  }), []);

  const rows = useMemo(() => {
    const tab = TABS.find((t) => t.key === activeTab)!;
    let list = protocol.findings.filter((f) => tab.statuses.includes(f.status));
    if (priorityFilter !== 'ALL') {
      list = list.filter((f) => f.priority === priorityFilter);
    }
    return list;
  }, [activeTab, priorityFilter]);

  const candidatesCount = protocol.findings.filter((f) => f.status === 'CANDIDATE').length;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', 'Торговое здание, Алтуфьевское ш., 79Б', `Протокол № ${protocol.number}`]}
        title={`Протокол проверки № ${protocol.number}`}
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Назад
            </Button>
            <Button variant="secondary" icon={<Download size={14} />}>Экспорт</Button>
            <Button
              variant="primary"
              disabled={candidatesCount > 0}
              title={candidatesCount > 0
                ? `Остались необработанные кандидаты: ${candidatesCount}`
                : 'Завершить верификацию'}
              onClick={() => onOpenVerification(protocolId)}
            >
              Завершить верификацию
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {/* Технические версии */}
        <div className="mono text-[11px] text-[#94A3B8] mb-3">
          matrix_version {protocol.matrixVersion} · model_version {protocol.modelVersion} ·
          dataset_version {protocol.datasetVersion} · hash {protocol.hash.slice(0, 12)}…
        </div>

        {/* Шапка протокола */}
        <div className="grid grid-cols-12 gap-3 mb-4">
          <div className="col-span-8 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide mb-1">Статус процесса</div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-[13px] text-[#027A48]">
                <CheckCircle2 size={14} aria-hidden />
                {processStatusLabels[protocol.processStatus]}
              </span>
              <span className="text-[12px] text-[#475569]">
                Создан: <span className="mono text-[#0F172A]">{protocol.createdAt}</span>
              </span>
              <span className="text-[12px] text-[#475569]">
                Версия: <span className="mono text-[#0F172A]">{protocol.version}</span>
              </span>
            </div>
          </div>
          <div className="col-span-4 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide mb-1">Тип проверки</div>
            <div className="text-[13px] text-[#0F172A] font-medium">ПД + РД</div>
            <div className="flex items-center gap-2 mt-1.5">
              <StageBadge stage="PD" /><StageBadge stage="RD" /><StageBadge stage="ID" active={false} />
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
        </div>

        {/* Вкладки */}
        <div className="border-b border-[#E2E8F0] flex items-center gap-1 mb-3">
          {TABS.map((t) => {
            const isActive = t.key === activeTab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => { setActiveTab(t.key); setPriorityFilter('ALL'); }}
                className={[
                  'px-3 h-9 text-[13px] rounded-t-md transition-colors flex items-center gap-2',
                  isActive
                    ? 'text-[#1B4E9B] border-b-2 border-[#1B4E9B] bg-white'
                    : 'text-[#475569] hover:text-[#0F172A]'
                ].join(' ')}
              >
                <span>{t.label}</span>
                <span className={[
                  'num text-[11px] px-1.5 rounded-[4px]',
                  isActive ? 'bg-[#E8F0FB] text-[#1B4E9B]' : 'bg-[#EDF1F7] text-[#475569]'
                ].join(' ')}>
                  {counts[t.key]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Фильтры над таблицей */}
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

        {/* Плашка вкладки гипотез */}
        {activeTab === 'hypotheses' && !loading && rows.length > 0 && (
          <div className="mb-3 flex items-center justify-between bg-[#EDF1F7] border border-[#E2E8F0] rounded-lg px-4 py-2.5">
            <span className="text-[13px] text-[#475569]">
              Гипотезы не входят в число нарушений и не используются для обучения модели.
            </span>
            <Button variant="primary" onClick={() => onOpenHypotheses(protocolId)}>
              Открыть полный список
            </Button>
          </div>
        )}

        {/* Таблица / скелетон / пустое состояние */}
        {loading ? (
          <SkeletonTable rows={8} />
        ) : rows.length === 0 ? (
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
                {rows.map((f) => (
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
                      {f.status === 'CANDIDATE' ? (
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