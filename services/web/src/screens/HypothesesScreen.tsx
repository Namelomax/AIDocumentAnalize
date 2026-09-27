import { useEffect, useState } from 'react';
import { ArrowLeft, Info, Link2, X, BarChart3 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import PriorityIndicator from '../components/PriorityIndicator';
import StageBadge from '../components/StageBadge';
import { findings, detectionLabels } from '../mocks/data';
import type { DetectionMethod, Finding } from '../types';
import EmptyState from '../components/EmptyState';
import { SkeletonCard } from '../components/Skeleton';

interface Props {
  onBack: () => void;
  onPromote: (findingId: string) => void;
}

const SUSPICIONS = findings.filter((f) => f.status === 'SUSPICION');

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? '#027A48' : value >= 0.6 ? '#B54708' : '#94A3B8';
  return (
    <div className="flex items-center gap-2 min-w-[140px]">
      <BarChart3 size={12} className="text-[#94A3B8] shrink-0" aria-hidden />
      <div className="flex-1 h-1.5 bg-[#EDF1F7] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[11px] mono num text-[#475569] shrink-0 w-9 text-right">
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function HypothesisCard({
  finding,
  onPromote,
  onReject
}: {
  finding: Finding;
  onPromote: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const method = (finding.detectionMethod ?? 'logical') as DetectionMethod;
  const confidence = finding.confidence ?? 0.5;

  return (
    <article className="bg-white border border-[#E2E8F0] rounded-lg p-5 flex flex-col gap-3">
      {/* Верхняя строка: метод + шкала уверенности + приоритет */}
      <header className="flex items-center gap-3 flex-wrap">
        <span className="inline-flex items-center gap-1.5 px-2 h-6 rounded-[4px] bg-[#F0F9FF] text-[#026AA2] text-[12px] font-medium border border-[#B9E6FE]">
          {detectionLabels[method]}
        </span>
        <ConfidenceBar value={confidence} />
        <span className="ml-auto">
          <PriorityIndicator priority={finding.priority} />
        </span>
      </header>

      {/* Заголовок */}
      <h3 className="text-[15px] leading-6 font-semibold text-[#0F172A]">
        {finding.title}
      </h3>

      {/* Обоснование */}
      <p className="text-[13px] text-[#475569] leading-5">{finding.aiRationale}</p>

      {/* Источники */}
      <div className="grid grid-cols-2 gap-3 text-[12px]">
        <div className="flex items-start gap-2">
          <StageBadge stage={finding.expectedEvidence.stage} />
          <div className="min-w-0">
            <div className="mono text-[#0F172A] truncate">
              {finding.expectedEvidence.documentCode}
            </div>
            <div className="text-[#94A3B8] text-[11px]">
              {finding.expectedEvidence.revision} · лист {finding.expectedEvidence.sheetPage}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2">
          <StageBadge stage={finding.actualEvidence.stage} />
          <div className="min-w-0">
            <div className="mono text-[#0F172A] truncate">
              {finding.actualEvidence.documentCode}
            </div>
            <div className="text-[#94A3B8] text-[11px]">
              {finding.actualEvidence.revision} · лист {finding.actualEvidence.sheetPage}
            </div>
          </div>
        </div>
      </div>

      {/* Нормативное основание */}
      {finding.normReference && (
        <div className="text-[12px] text-[#1B4E9B]">{finding.normReference}</div>
      )}

      {/* Кнопки */}
      <footer className="flex items-center gap-2 pt-2 border-t border-[#E2E8F0]">
        <Button
          variant="primary"
          icon={<Link2 size={14} />}
          onClick={() => onPromote(finding.id)}
        >
          Привязать доказательства
        </Button>
        <Button
          variant="secondary"
          icon={<X size={14} />}
          onClick={() => onReject(finding.id)}
        >
          Отклонить гипотезу
        </Button>
      </footer>
    </article>
  );
}

export default function HypothesesScreen({ onBack, onPromote }: Props) {
  const [rejected, setRejected] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 500);
    return () => window.clearTimeout(t);
  }, []);
  const visible = SUSPICIONS.filter((f) => !rejected[f.id]);

  const handleReject = (id: string) =>
    setRejected((prev) => ({ ...prev, [id]: true }));

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', 'Торговое здание, Алтуфьевское ш., 79Б', 'Гипотезы']}
        title="Гипотезы свободного поиска"
        actions={
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
            Назад к протоколу
          </Button>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {/* Плашка-предупреждение */}
        <div className="bg-[#EDF1F7] border border-[#E2E8F0] rounded-lg px-4 py-3 mb-5 flex items-start gap-3">
          <Info size={16} className="text-[#475569] shrink-0 mt-0.5" aria-hidden />
          <div className="text-[13px] text-[#475569] leading-5">
            Гипотезы не входят в число нарушений и не используются для обучения модели.
            Чтобы передать гипотезу в проверку, привяжите доказательства.
          </div>
        </div>

                {loading ? (
          <div className="grid grid-cols-2 gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="no-candidates"
              title="Все гипотезы обработаны"
              description="Свободный поиск не оставил нерешённых гипотез по этому протоколу. Можно вернуться к протоколу."
              action={
                <Button variant="secondary" onClick={onBack}>Вернуться к протоколу</Button>
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {visible.map((f) => (
              <HypothesisCard
                key={f.id}
                finding={f}
                onPromote={onPromote}
                onReject={handleReject}
              />
            ))}
          </div>
        )}

        {visible.length === 0 && (
          <div className="bg-white border border-[#E2E8F0] rounded-lg py-16 text-center text-[13px] text-[#94A3B8]">
            Все гипотезы обработаны
          </div>
        )}
      </div>
    </div>
  );
}