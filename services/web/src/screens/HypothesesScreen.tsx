import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, Building2, Link2 } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import EvidencePanel from '../components/EvidencePanel';
import StatusBadge from '../components/StatusBadge';
import { SkeletonQueue, SkeletonEvidencePanel } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { detectionLabels } from '../labels';
import { api, ApiError } from '../api/client';
import {
  toSuspicionListItem,
  type ApiFinding,
  type ApiSuspicionListItem,
  type SuspicionListItem,
} from '../api/adapters';

interface Props {
  // Opened from a protocol's "Гипотезы свободного поиска" tab, this scopes
  // the list to that protocol (GET /api/v1/suspicions?protocol_id=...).
  // Opened from the sidebar's own "Гипотезы" section (no protocol in
  // context), it lists across every object instead — the same endpoint
  // without filters (services/api/src/routes/suspicions.ts).
  protocolId?: string;
  onBack: () => void;
}

// Section 9.5: the model's own self-assessment for a hypothesis, never a
// probability that a violation actually happened — every place this bar
// appears carries that caption, not just a number.
function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? '#027A48' : value >= 0.6 ? '#B54708' : '#94A3B8';
  return (
    <div
      className="flex items-center gap-2 min-w-[140px]"
      title="Уверенность модели — самооценка модели, не вероятность нарушения"
    >
      <BarChart3 size={12} className="text-[#94A3B8] shrink-0" aria-hidden />
      <div className="flex-1 h-1.5 bg-[#EDF1F7] rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[11px] mono num text-[#475569] shrink-0 w-9 text-right">{value.toFixed(2)}</span>
    </div>
  );
}

export default function HypothesesScreen({ protocolId, onBack }: Props) {
  const { push } = useToast();

  const [items, setItems] = useState<SuspicionListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const query = protocolId ? `?protocol_id=${encodeURIComponent(protocolId)}` : '';
        const response = await api<{ items: ApiSuspicionListItem[] }>(`/api/v1/suspicions${query}`);
        if (cancelled) return;
        const mapped = response.items.map(toSuspicionListItem);
        setItems(mapped);
        setSelectedId(mapped[0]?.id ?? null);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить гипотезы');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [protocolId]);

  const selected = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  // The only action left once a hypothesis's evidence is already attached
  // (section 9.5) — a hypothesis is never confirmed as a violation directly;
  // it becomes an ordinary candidate and goes through verification like any
  // other.
  const handlePromote = async () => {
    if (!selected || promoting) return;
    setPromoting(true);
    try {
      await api<ApiFinding>(`/api/v1/findings/${selected.id}/promote`, { method: 'POST' });
      const promotedTitle = selected.title;
      setItems((prev) => {
        const next = prev.filter((item) => item.id !== selected.id);
        setSelectedId(next[0]?.id ?? null);
        return next;
      });
      push({ kind: 'success', message: 'Гипотеза переведена в кандидаты', detail: promotedTitle });
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось перевести гипотезу в кандидаты',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', 'Гипотезы']}
        title="Гипотезы свободного поиска"
        actions={
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
            {protocolId ? 'Назад к протоколу' : 'Назад'}
          </Button>
        }
      />

      <div className="px-8 pt-4">
        <div className="bg-[#EDF1F7] border border-[#E2E8F0] rounded-lg px-4 py-3 text-[13px] text-[#475569] leading-5">
          Гипотезы не входят в число нарушений и не используются для обучения модели. Доказательства уже привязаны —
          единственное доступное действие: перевести гипотезу в кандидаты, решение по ней принимается при верификации.
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex min-h-0 px-8 py-4 gap-4">
          <aside className="w-[300px] shrink-0 bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <SkeletonQueue rows={6} />
          </aside>
          <section className="flex-1 min-w-0 flex gap-3">
            <SkeletonEvidencePanel />
            <SkeletonEvidencePanel />
          </section>
        </div>
      ) : loadError ? (
        <div className="flex-1 flex items-center justify-center px-8">
          <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            {loadError}
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 overflow-auto px-8 py-5">
          <div className="bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="custom"
              title="Гипотез пока нет"
              description="Свободный поиск не оставил гипотез, которые ещё нужно рассмотреть."
              action={
                <Button variant="secondary" onClick={onBack}>
                  {protocolId ? 'Вернуться к протоколу' : 'На главную'}
                </Button>
              }
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 flex min-h-0 px-8 py-4 gap-4">
          {/* Список гипотез */}
          <aside className="w-[300px] shrink-0 bg-white border border-[#E2E8F0] rounded-lg overflow-y-auto">
            {items.map((item) => {
              const isActive = item.id === selectedId;
              const method = item.detectionMethod ?? 'logical';
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={[
                    'w-full text-left px-3 py-3 border-b border-[#E2E8F0] flex flex-col gap-1.5',
                    isActive ? 'bg-[#E8F0FB]' : 'hover:bg-[#F5F7FA]',
                  ].join(' ')}
                >
                  <span className="inline-flex items-center gap-1.5 px-2 h-5 rounded-[4px] bg-[#F0F9FF] text-[#026AA2] text-[11px] font-medium border border-[#B9E6FE] w-fit">
                    {detectionLabels[method]}
                  </span>
                  <span className="text-[13px] text-[#0F172A] truncate">{item.title}</span>
                  <span className="flex items-center gap-1 text-[11px] text-[#475569] truncate">
                    <Building2 size={11} className="shrink-0" aria-hidden /> {item.objectName}
                  </span>
                  <ConfidenceBar value={item.confidence ?? 0} />
                </button>
              );
            })}
          </aside>

          {/* Детальная панель выбранной гипотезы */}
          {selected && (
            <section className="flex-1 min-w-0 flex flex-col gap-4 overflow-y-auto pb-2">
              <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                <div className="flex items-start gap-3 flex-wrap mb-3">
                  <span className="inline-flex items-center gap-1.5 px-2 h-6 rounded-[4px] bg-[#F0F9FF] text-[#026AA2] text-[12px] font-medium border border-[#B9E6FE]">
                    {detectionLabels[selected.detectionMethod ?? 'logical']}
                  </span>
                  <ConfidenceBar value={selected.confidence ?? 0} />
                  <span className="ml-auto">
                    <StatusBadge status="SUSPICION" />
                  </span>
                </div>
                <h2 className="text-[16px] font-semibold text-[#0F172A] mb-1">{selected.title}</h2>
                <div className="text-[12px] text-[#475569] flex items-center gap-1 mb-3">
                  <Building2 size={12} aria-hidden /> {selected.objectName}
                </div>
                <div className="grid grid-cols-2 gap-6">
                  <div>
                    <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Ожидается (ПД)</div>
                    <div className="text-[18px] leading-7 font-semibold text-[#0F172A]">{selected.expected}</div>
                  </div>
                  <div>
                    <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Фактически (РД)</div>
                    <div className="text-[18px] leading-7 font-semibold text-[#0F172A]">{selected.actual}</div>
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-[#E2E8F0] text-[13px] text-[#0F172A] leading-5">
                  {selected.aiRationale}
                </div>
              </div>

              <div className="flex gap-3 flex-1 min-h-[260px]">
                <EvidencePanel fragment={selected.expectedEvidence} accent="expected" />
                <EvidencePanel fragment={selected.actualEvidence} accent="actual" />
              </div>

              <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="text-[12px] text-[#475569] leading-5 max-w-[520px]">
                  Уверенность модели — это самооценка модели, а не вероятность нарушения. Подтвердить нарушение прямо
                  из гипотезы нельзя — переведите её в кандидаты, решение принимается при верификации.
                </div>
                <Button
                  variant="primary"
                  size="lg"
                  icon={<Link2 size={14} />}
                  disabled={promoting}
                  onClick={() => void handlePromote()}
                >
                  {promoting ? 'Перевод…' : 'Перевести в кандидаты'}
                </Button>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
