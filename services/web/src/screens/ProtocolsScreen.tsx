import { useEffect, useState } from 'react';
import { FileCode, FileText, FileType, Search } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonTable } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { protocolStatusColor, protocolStatusLabels } from '../labels';
import { api, apiBlob, saveBlob, ApiError } from '../api/client';
import { toProtocolListItem, type ApiProtocolsListResponse } from '../api/adapters';
import type { ProtocolListItem, ProtocolStatus } from '../types';

interface Props {
  onOpenProtocol: (protocolId: string, objectId: string) => void;
}

// GET /api/v1/protocols page size (task spec: "limit ≤ 100, default 50") -
// also how many more rows a "Показать ещё" click asks for.
const PAGE_SIZE = 50;

// SUPERSEDED included: customer's ТЗ "Предыдущая версия протокола
// сохраняется в истории" - the inspector must be able to filter down to
// exactly the archived versions a дозагрузка replaced, not just find them
// mixed into an unfiltered list.
const STATUS_OPTIONS: ProtocolStatus[] = [
  'READY', 'VERIFYING', 'VERIFICATION_COMPLETED', 'PROTOCOL_FINALIZED', 'SUPERSEDED',
];

type ExportFormat = 'pdf' | 'docx' | 'xml';

function StatusChip({ status }: { status: ProtocolStatus }) {
  const color = protocolStatusColor(status);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 h-6 rounded-[4px] bg-[#F5F7FA] text-[12px] font-medium whitespace-nowrap"
      style={{ color }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {protocolStatusLabels[status] ?? status}
    </span>
  );
}

export default function ProtocolsScreen({ onOpenProtocol }: Props) {
  const { push } = useToast();

  const [items, setItems] = useState<ProtocolListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  // Debounced separately from `query` so every keystroke doesn't fire its
  // own request - only the status filter (an immediate select, not typing)
  // reloads without this delay.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ProtocolStatus>('ALL');

  const [exporting, setExporting] = useState<string | null>(null);
  // Bumped by the "Повторить" button below to force the load effect to run
  // again with the same filters - statusFilter/debouncedQuery alone would
  // not change, and React skips an effect whose dependencies didn't.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (statusFilter !== 'ALL') params.set('status', statusFilter);
        if (debouncedQuery) params.set('q', debouncedQuery);
        params.set('limit', String(PAGE_SIZE));
        params.set('offset', '0');
        const response = await api<ApiProtocolsListResponse>(`/api/v1/protocols?${params.toString()}`);
        if (cancelled) return;
        setItems(response.items.map(toProtocolListItem));
        setTotal(response.total);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить протоколы');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [statusFilter, debouncedQuery, retryTick]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'ALL') params.set('status', statusFilter);
      if (debouncedQuery) params.set('q', debouncedQuery);
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(items.length));
      const response = await api<ApiProtocolsListResponse>(`/api/v1/protocols?${params.toString()}`);
      setItems((prev) => [...prev, ...response.items.map(toProtocolListItem)]);
      setTotal(response.total);
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось загрузить ещё протоколы',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setLoadingMore(false);
    }
  };

  // GET /api/v1/protocols/:id/export?format=… (routes/export.ts), the same
  // endpoint ProtocolScreen's own export buttons use - `key` scopes the
  // in-flight indicator to this one row+format so exporting one protocol
  // never disables another row's buttons.
  const handleExport = async (item: ProtocolListItem, format: ExportFormat) => {
    const key = `${item.id}:${format}`;
    setExporting(key);
    try {
      const blob = await apiBlob(`/api/v1/protocols/${item.id}/export?format=${format}`);
      saveBlob(blob, `protocol-${item.id.slice(0, 8)}-v${item.version}.${format}`);
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось выгрузить протокол',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setExporting((current) => (current === key ? null : current));
    }
  };

  const noProtocolsAtAll = !loading && !loadError && items.length === 0 && !debouncedQuery && statusFilter === 'ALL';
  const noFilterResults = !loading && !loadError && items.length === 0 && !noProtocolsAtAll;
  const hasMore = !loading && !loadError && items.length < total;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Главная', 'Протоколы']}
        title="Протоколы"
        actions={
          <>
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]"
                aria-hidden
              />
              <input
                aria-label="Поиск по объектам"
                placeholder="Поиск по объекту"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-9 w-72 pl-8 pr-3 border border-[#CBD5E1] rounded-md bg-white text-[13px] outline-none focus:border-[#1B4E9B]"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'ALL' | ProtocolStatus)}
              className="h-9 px-3 border border-[#CBD5E1] rounded-md bg-white text-[13px] text-[#475569] outline-none focus:border-[#1B4E9B]"
            >
              <option value="ALL">Статус: все</option>
              {STATUS_OPTIONS.map((status) => (
                <option key={status} value={status}>{protocolStatusLabels[status]}</option>
              ))}
            </select>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {loadError && (
          <div className="mb-4 bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 flex items-center justify-between text-[13px] text-[#B42318]">
            <span>{loadError}</span>
            <Button variant="secondary" size="md" onClick={() => setRetryTick((t) => t + 1)}>Повторить</Button>
          </div>
        )}

        {loading ? (
          <SkeletonTable rows={6} />
        ) : noProtocolsAtAll ? (
          <div className="bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="custom"
              title="Протоколов пока нет"
              description="Протокол появится здесь после первой проверки документов по любому объекту."
            />
          </div>
        ) : noFilterResults ? (
          <div className="bg-white border border-[#E2E8F0] rounded-lg">
            <EmptyState
              kind="no-filter-results"
              action={
                <Button
                  variant="secondary"
                  onClick={() => { setQuery(''); setStatusFilter('ALL'); }}
                >
                  Сбросить фильтры
                </Button>
              }
            />
          </div>
        ) : (
          <>
            {/* This table carries more columns than Dashboard's own (four
                counters plus export actions) - table-fixed plus an explicit
                width on every column but "Объект" keeps them all on screen
                at the task's own 1440px viewport, with "Объект" (the only
                unbounded one) truncating instead of pushing the rest out;
                overflow-x-auto is the fallback for anything narrower. */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-[13px] border-collapse min-w-[1100px]">
                  <thead>
                    <tr className="bg-[#EDF1F7] text-[#475569] text-[12px]">
                      <th className="text-left font-medium px-3 h-10">Объект</th>
                      <th className="text-left font-medium px-3 h-10 w-[70px]">Версия</th>
                      <th className="text-left font-medium px-3 h-10 w-[150px]">Статус</th>
                      <th className="text-left font-medium px-3 h-10 w-[130px]">Создан</th>
                      <th className="text-right font-medium px-3 h-10 w-[80px]">Кандидатов</th>
                      <th className="text-right font-medium px-3 h-10 w-[90px]">Подтверждено</th>
                      <th className="text-right font-medium px-3 h-10 w-[80px]">Отклонено</th>
                      <th className="text-right font-medium px-3 h-10 w-[70px]">Гипотез</th>
                      <th className="text-left font-medium px-3 h-10 w-[130px]">Финализировал</th>
                      <th className="text-right font-medium px-3 h-10 w-[100px]" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr
                        key={item.id}
                        className="h-10 border-t border-[#E2E8F0] hover:bg-[#E8F0FB] cursor-pointer"
                        onClick={() => onOpenProtocol(item.id, item.objectId)}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenProtocol(item.id, item.objectId);
                          }
                        }}
                      >
                        <td className="px-3 text-[#0F172A] font-medium truncate">{item.objectName}</td>
                        <td className="px-3 mono text-[#475569]">№{item.version}</td>
                        <td className="px-3"><StatusChip status={item.status} /></td>
                        <td className="px-3 text-[#475569] mono text-[12px]">{item.createdAt}</td>
                        <td className="px-3 text-right num text-[#0F172A]">{item.awaitingDecision}</td>
                        <td className="px-3 text-right num text-[#0F172A]">{item.confirmed}</td>
                        <td className="px-3 text-right num text-[#0F172A]">{item.rejected}</td>
                        <td className="px-3 text-right num text-[#0F172A]">{item.suspicions}</td>
                        <td className="px-3 text-[#475569] truncate">{item.finalizedBy ?? '—'}</td>
                        <td className="px-3 text-right">
                          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              title="Выгрузить в PDF"
                              aria-label="Выгрузить в PDF"
                              disabled={exporting !== null}
                              onClick={() => void handleExport(item, 'pdf')}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-[#475569] hover:bg-[#E8F0FB] hover:text-[#1B4E9B] disabled:opacity-50"
                            >
                              <FileText size={14} />
                            </button>
                            <button
                              type="button"
                              title="Выгрузить в DOCX"
                              aria-label="Выгрузить в DOCX"
                              disabled={exporting !== null}
                              onClick={() => void handleExport(item, 'docx')}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-[#475569] hover:bg-[#E8F0FB] hover:text-[#1B4E9B] disabled:opacity-50"
                            >
                              <FileType size={14} />
                            </button>
                            <button
                              type="button"
                              title="Выгрузить в XML"
                              aria-label="Выгрузить в XML"
                              disabled={exporting !== null}
                              onClick={() => void handleExport(item, 'xml')}
                              className="w-7 h-7 rounded-md flex items-center justify-center text-[#475569] hover:bg-[#E8F0FB] hover:text-[#1B4E9B] disabled:opacity-50"
                            >
                              <FileCode size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {hasMore && (
              <div className="flex justify-center mt-4">
                <Button variant="secondary" disabled={loadingMore} onClick={() => void handleLoadMore()}>
                  {loadingMore ? 'Загрузка…' : `Показать ещё (${total - items.length})`}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
