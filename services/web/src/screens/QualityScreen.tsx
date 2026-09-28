// Section 9.4/14 of the customer's ТЗ: the "Качество" screen ADMIN,
// ML_ENGINEER and SUPERVISOR see (Sidebar.tsx gates it to those three
// roles) - acceptance metrics with section 14.3's own thresholds
// highlighted, the dataset_version release history, and the weekly quality
// report (feature table item 10, "Еженедельный отчёт по дообучению").
import { useEffect, useState } from 'react';
import { RefreshCw, Database, FileBarChart, Download, PlusCircle } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import { useToast } from '../components/Toast';
import { api, apiBlob, saveBlob, ApiError, getSession } from '../api/client';
import { reasonLabels } from '../labels';

interface Wilson {
  point: number | null;
  ci_95: [number, number] | null;
  n: number;
}

interface QualityGroup {
  key: string;
  param_code: string | null;
  modality: string | null;
  detection_method: string | null;
  counts: { tp: number; fp: number; fn: number; tn: number };
  precision: Wilson;
  recall: Wilson;
  f1: number | null;
  false_positive_rate: Wilson;
  thresholds: { precisionMin: number; recallMin: number; f1Min: number; fprMax: number };
  pass: { precision: boolean | null; recall: boolean | null; f1: boolean | null; false_positive_rate: boolean | null; overall: boolean | null };
}

interface QualityMetrics {
  overall: QualityGroup;
  by_modality: QualityGroup[];
  by_param: QualityGroup[];
  rejection_reasons: Array<{ reason_code: string; count: number }>;
  sample_size: number;
}

interface DatasetVersion {
  id: string;
  version_tag: string;
  notes: string | null;
  manifest_hash: string;
  label_count: number;
  released_by: string;
  released_at: string;
}

interface QualityReport {
  id: string;
  period_start: string;
  period_end: string;
  generated_by: string | null;
  created_at: string;
  payload: { trend: { precision: number | null; recall: number | null; f1: number | null; false_positive_rate: number | null } };
}

const MODALITY_LABELS: Record<string, string> = {
  scalar_text: 'Текстовые значения',
  doc_presence: 'Наличие документа',
  drawing_entity: 'Объекты на чертеже',
  drawing_measure: 'Измерения на чертеже',
  UNKNOWN: 'Без модальности',
};

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

function trendText(v: number | null): string {
  if (v === null) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)} п.п.`;
}

function PassChip({ pass }: { pass: boolean | null }) {
  if (pass === null) return <span className="text-[12px] text-[#94A3B8]">нет данных</span>;
  return (
    <span
      className={[
        'inline-flex items-center px-2 py-0.5 rounded text-[12px] font-medium',
        pass ? 'bg-[#ECFDF3] text-[#027A48]' : 'bg-[#FEF3F2] text-[#B42318]',
      ].join(' ')}
    >
      {pass ? 'выполнен' : 'не выполнен'}
    </span>
  );
}

function MetricTile({ label, value, threshold, pass }: { label: string; value: string; threshold: string; pass: boolean | null }) {
  return (
    <div className="flex-1 bg-white border border-[#E2E8F0] rounded-lg px-4 py-3">
      <div className="text-[12px] text-[#475569] mb-1">{label}</div>
      <div className="text-[24px] leading-8 font-semibold num text-[#0F172A]">{value}</div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[11px] text-[#94A3B8]">порог {threshold}</span>
        <PassChip pass={pass} />
      </div>
    </div>
  );
}

export default function QualityScreen() {
  const { push } = useToast();
  const session = getSession();
  const canManage = session?.user.role === 'ADMIN' || session?.user.role === 'ML_ENGINEER';

  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [reports, setReports] = useState<QualityReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [releasing, setReleasing] = useState(false);
  const [showReleaseModal, setShowReleaseModal] = useState(false);
  const [releaseTag, setReleaseTag] = useState('');
  const [releaseNotes, setReleaseNotes] = useState('');

  const [generating, setGenerating] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [metricsRes, versionsRes, reportsRes] = await Promise.all([
        api<QualityMetrics>('/api/v1/quality/metrics'),
        api<{ versions: DatasetVersion[] }>('/api/v1/quality/datasets'),
        api<{ reports: QualityReport[] }>('/api/v1/quality/reports'),
      ]);
      setMetrics(metricsRes);
      setVersions(versionsRes.versions);
      setReports(reportsRes.reports);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные о качестве');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleRelease = async () => {
    setReleasing(true);
    try {
      await api('/api/v1/quality/datasets', {
        method: 'POST',
        body: JSON.stringify({
          version_tag: releaseTag.trim() || undefined,
          notes: releaseNotes.trim() || undefined,
        }),
      });
      setShowReleaseModal(false);
      setReleaseTag('');
      setReleaseNotes('');
      push({ kind: 'success', message: 'Версия набора данных выпущена' });
      await load();
    } catch (err) {
      push({ kind: 'error', message: 'Не удалось выпустить версию', detail: err instanceof ApiError ? err.message : undefined });
    } finally {
      setReleasing(false);
    }
  };

  const handleGenerateReport = async () => {
    setGenerating(true);
    try {
      await api('/api/v1/quality/reports', { method: 'POST' });
      push({ kind: 'success', message: 'Отчёт сформирован' });
      await load();
    } catch (err) {
      push({ kind: 'error', message: 'Не удалось сформировать отчёт', detail: err instanceof ApiError ? err.message : undefined });
    } finally {
      setGenerating(false);
    }
  };

  const handleDownloadReport = async (reportId: string, format: 'pdf' | 'docx') => {
    setDownloadingId(reportId);
    try {
      const blob = await apiBlob(`/api/v1/quality/reports/${reportId}/download?format=${format}`);
      saveBlob(blob, `quality-report-${reportId}.${format}`);
    } catch (err) {
      push({ kind: 'error', message: 'Не удалось скачать отчёт', detail: err instanceof ApiError ? err.message : undefined });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Качество']}
        title="Качество и дообучение"
        actions={
          <Button variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()}>
            Обновить
          </Button>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {loading && <div className="text-[13px] text-[#94A3B8]">Загрузка…</div>}
        {loadError && (
          <div className="mb-5 bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            {loadError}
          </div>
        )}

        {metrics && (
          <section className="mb-8">
            <h2 className="text-[14px] font-semibold text-[#0F172A] mb-3">
              Приёмочные метрики (раздел 14.3) · выборка {metrics.sample_size} GOLD-меток
            </h2>
            <div className="flex gap-4 mb-4">
              <MetricTile
                label="Precision" value={pct(metrics.overall.precision.point)}
                threshold={`≥ ${metrics.overall.thresholds.precisionMin * 100}%`} pass={metrics.overall.pass.precision}
              />
              <MetricTile
                label="Recall" value={pct(metrics.overall.recall.point)}
                threshold={`≥ ${metrics.overall.thresholds.recallMin * 100}%`} pass={metrics.overall.pass.recall}
              />
              <MetricTile
                label="F1" value={metrics.overall.f1 === null ? '—' : metrics.overall.f1.toFixed(2)}
                threshold={`≥ ${metrics.overall.thresholds.f1Min}`} pass={metrics.overall.pass.f1}
              />
              <MetricTile
                label="False Positive Rate" value={pct(metrics.overall.false_positive_rate.point)}
                threshold={`≤ ${metrics.overall.thresholds.fprMax * 100}%`} pass={metrics.overall.pass.false_positive_rate}
              />
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-[#F8FAFC] text-[#475569] text-left">
                    <th className="px-3 py-2 font-medium">Модальность</th>
                    <th className="px-3 py-2 font-medium">TP/FP/FN/TN</th>
                    <th className="px-3 py-2 font-medium">Precision</th>
                    <th className="px-3 py-2 font-medium">Recall</th>
                    <th className="px-3 py-2 font-medium">F1</th>
                    <th className="px-3 py-2 font-medium">FPR</th>
                    <th className="px-3 py-2 font-medium">Итог</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.by_modality.map((g) => (
                    <tr key={g.key} className="border-t border-[#E2E8F0]">
                      <td className="px-3 py-2 text-[#0F172A]">{MODALITY_LABELS[g.modality ?? 'UNKNOWN'] ?? g.modality}</td>
                      <td className="px-3 py-2 num text-[#475569]">{g.counts.tp}/{g.counts.fp}/{g.counts.fn}/{g.counts.tn}</td>
                      <td className="px-3 py-2 num">{pct(g.precision.point)}</td>
                      <td className="px-3 py-2 num">{pct(g.recall.point)}</td>
                      <td className="px-3 py-2 num">{g.f1 === null ? '—' : g.f1.toFixed(2)}</td>
                      <td className="px-3 py-2 num">{pct(g.false_positive_rate.point)}</td>
                      <td className="px-3 py-2"><PassChip pass={g.pass.overall} /></td>
                    </tr>
                  ))}
                  {metrics.by_modality.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-4 text-center text-[#94A3B8]">Нет данных за выбранный период</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {metrics.rejection_reasons.length > 0 && (
              <div className="mt-4">
                <h3 className="text-[12px] font-medium text-[#475569] mb-2">Причины отклонений инспекторами</h3>
                <div className="flex flex-wrap gap-2">
                  {metrics.rejection_reasons.map((r) => (
                    <span key={r.reason_code} className="px-2.5 py-1 rounded-md bg-white border border-[#E2E8F0] text-[12px] text-[#0F172A]">
                      {reasonLabels[r.reason_code as keyof typeof reasonLabels] ?? r.reason_code}: <span className="num font-medium">{r.count}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        <section className="mb-8">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-semibold text-[#0F172A] flex items-center gap-2">
              <Database size={16} /> Версии набора данных (dataset_version)
            </h2>
            {canManage && (
              <Button variant="secondary" icon={<PlusCircle size={14} />} onClick={() => setShowReleaseModal(true)}>
                Выпустить версию
              </Button>
            )}
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-[#F8FAFC] text-[#475569] text-left">
                  <th className="px-3 py-2 font-medium">Версия</th>
                  <th className="px-3 py-2 font-medium">Меток</th>
                  <th className="px-3 py-2 font-medium">Manifest SHA-256</th>
                  <th className="px-3 py-2 font-medium">Выпущена</th>
                  <th className="px-3 py-2 font-medium">Примечание</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} className="border-t border-[#E2E8F0]">
                    <td className="px-3 py-2 font-medium text-[#0F172A]">{v.version_tag}</td>
                    <td className="px-3 py-2 num">{v.label_count}</td>
                    <td className="px-3 py-2 mono text-[#64748B]">{v.manifest_hash.slice(0, 12)}…</td>
                    <td className="px-3 py-2 text-[#475569]">{new Date(v.released_at).toLocaleString('ru-RU')}</td>
                    <td className="px-3 py-2 text-[#475569]">{v.notes ?? '—'}</td>
                  </tr>
                ))}
                {versions.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-4 text-center text-[#94A3B8]">Версии ещё не выпускались</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-semibold text-[#0F172A] flex items-center gap-2">
              <FileBarChart size={16} /> Еженедельные отчёты по дообучению
            </h2>
            {canManage && (
              <Button variant="secondary" disabled={generating} onClick={() => void handleGenerateReport()}>
                {generating ? 'Формирование…' : 'Сформировать отчёт сейчас'}
              </Button>
            )}
          </div>
          <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="bg-[#F8FAFC] text-[#475569] text-left">
                  <th className="px-3 py-2 font-medium">Период</th>
                  <th className="px-3 py-2 font-medium">Тренд Precision</th>
                  <th className="px-3 py-2 font-medium">Тренд Recall</th>
                  <th className="px-3 py-2 font-medium">Тренд FPR</th>
                  <th className="px-3 py-2 font-medium">Создан</th>
                  <th className="px-3 py-2 font-medium">Скачать</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className="border-t border-[#E2E8F0]">
                    <td className="px-3 py-2 text-[#0F172A]">
                      {new Date(r.period_start).toLocaleDateString('ru-RU')} — {new Date(r.period_end).toLocaleDateString('ru-RU')}
                    </td>
                    <td className="px-3 py-2 num">{trendText(r.payload.trend.precision)}</td>
                    <td className="px-3 py-2 num">{trendText(r.payload.trend.recall)}</td>
                    <td className="px-3 py-2 num">{trendText(r.payload.trend.false_positive_rate)}</td>
                    <td className="px-3 py-2 text-[#475569]">{new Date(r.created_at).toLocaleString('ru-RU')}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={downloadingId === r.id}
                          onClick={() => void handleDownloadReport(r.id, 'pdf')}
                          className="text-[#1B4E9B] hover:underline inline-flex items-center gap-1"
                        >
                          <Download size={12} /> PDF
                        </button>
                        <button
                          type="button"
                          disabled={downloadingId === r.id}
                          onClick={() => void handleDownloadReport(r.id, 'docx')}
                          className="text-[#1B4E9B] hover:underline inline-flex items-center gap-1"
                        >
                          <Download size={12} /> DOCX
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {reports.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-4 text-center text-[#94A3B8]">Отчётов ещё не было</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {showReleaseModal && (
        <div className="fixed inset-0 z-50 bg-[#0F172A]/40 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="release-title">
          <div className="w-[480px] bg-white rounded-xl shadow-lg p-6">
            <h3 id="release-title" className="text-[16px] font-semibold text-[#0F172A] mb-3">Выпустить версию набора данных?</h3>
            <p className="text-[13px] text-[#475569] leading-5 mb-4">
              Будут заморожены все текущие GOLD-метки (раздел 9.4). Это действие соответствует проверке куратора данных.
            </p>
            <label className="block text-[12px] text-[#475569] mb-1">Тег версии (необязательно)</label>
            <input
              value={releaseTag}
              onChange={(e) => setReleaseTag(e.target.value)}
              placeholder="например, gold-2026.09.29"
              className="w-full mb-3 px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] outline-none focus:border-[#1B4E9B]"
            />
            <label className="block text-[12px] text-[#475569] mb-1">Примечание (необязательно)</label>
            <textarea
              value={releaseNotes}
              onChange={(e) => setReleaseNotes(e.target.value)}
              rows={3}
              className="w-full mb-5 px-2.5 py-2 border border-[#CBD5E1] rounded-md text-[13px] resize-none outline-none focus:border-[#1B4E9B]"
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowReleaseModal(false)} disabled={releasing}>Отмена</Button>
              <Button variant="primary" onClick={() => void handleRelease()} disabled={releasing}>
                {releasing ? 'Выпуск…' : 'Выпустить версию'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
