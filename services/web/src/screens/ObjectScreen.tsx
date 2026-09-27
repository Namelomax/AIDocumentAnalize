import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, UploadCloud } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';
import { SkeletonText } from '../components/Skeleton';
import { completenessLabels, processStatusLabels } from '../labels';
import { api, ApiError } from '../api/client';
import { toObjectProcess, toProjectObject, type ApiObjectDetail } from '../api/adapters';
import type { DocStage, ObjectProcess, ProjectObject } from '../types';

interface Props {
  objectId: string;
  onBack: () => void;
  onOpenUpload: (objectId: string) => void;
  onOpenProtocol: (objectId: string, protocolId: string) => void;
}

const STAGE_LABELS: Record<DocStage, string> = {
  PD: 'Проектная (ПД)', RD: 'Рабочая (РД)', ID: 'Исполнительная (ИД)'
};

type TabKey = 'docs' | 'protocols' | 'history';

export default function ObjectScreen({ objectId, onBack, onOpenUpload, onOpenProtocol }: Props) {
  const [object, setObject] = useState<ProjectObject | null>(null);
  const [processes, setProcesses] = useState<ObjectProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('docs');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setActiveTab('docs');
    (async () => {
      try {
        const detail = await api<ApiObjectDetail>(`/api/v1/objects/${objectId}`);
        if (cancelled) return;
        setObject(toProjectObject(detail));
        setProcesses(detail.processes.map(toObjectProcess));
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить объект');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [objectId]);

  if (loading) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
          <SkeletonText lines={2} height={16} />
        </div>
        <div className="flex-1 overflow-auto px-8 py-5">
          <SkeletonText lines={6} height={40} />
        </div>
      </div>
    );
  }

  if (loadError || !object) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <PageHeader
          crumbs={['Объекты']}
          title="Объект"
          actions={
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              К списку объектов
            </Button>
          }
        />
        <div className="flex-1 flex items-center justify-center">
          <div className="bg-[#FEF3F2] border border-[#FECDCA] rounded-lg px-4 py-3 text-[13px] text-[#B42318]">
            {loadError ?? 'Объект не найден'}
          </div>
        </div>
      </div>
    );
  }

  const latestProcess = processes[0] ?? null;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', object.name]}
        title={object.name}
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              К списку объектов
            </Button>
            <Button variant="primary" icon={<UploadCloud size={14} />} onClick={() => onOpenUpload(objectId)}>
              Документы и загрузка
            </Button>
          </>
        }
      />

      <div className="px-8 pt-4 pb-0 bg-white border-b border-[#E2E8F0]">
        <div className="grid grid-cols-4 gap-6 text-[13px] pb-4">
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Адрес</div>
            <div className="text-[#0F172A]">{object.address || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Застройщик</div>
            <div className="text-[#0F172A]">{object.developer || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Подрядчик</div>
            <div className="text-[#0F172A]">{object.contractor || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Разрешение на строительство</div>
            <div className="mono text-[#0F172A]">{object.permit || '—'}</div>
          </div>
        </div>

        <div className="flex items-center gap-5">
          {(['docs', 'protocols', 'history'] as const).map((tab) => {
            const labels: Record<TabKey, string> = { docs: 'Документы', protocols: 'Протоколы', history: 'История' };
            const active = activeTab === tab;
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={[
                  'pb-3 border-b-2 text-[13px]',
                  active ? 'border-[#1B4E9B] text-[#1B4E9B] font-medium' : 'border-transparent text-[#475569] hover:text-[#0F172A]'
                ].join(' ')}
              >
                {labels[tab]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-5">
        {activeTab === 'docs' && (
          <div className="grid grid-cols-12 gap-6">
            <div className="col-span-8 bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[13px] font-medium text-[#0F172A] mb-3">Комплектность</div>
              <div className="flex flex-col gap-3">
                {(['PD', 'RD', 'ID'] as const).map((stage) => (
                  <div key={stage} className="flex items-center justify-between text-[13px]">
                    <div className="flex items-center gap-2">
                      <StageBadge
                        stage={stage}
                        active={object.completeness[stage] === 'full' || object.completeness[stage] === 'partial'}
                      />
                      <span className="text-[#475569]">{STAGE_LABELS[stage]}</span>
                    </div>
                    <span className="text-[12px]" style={{
                      color: object.completeness[stage] === 'full' ? '#027A48'
                        : object.completeness[stage] === 'partial' ? '#B54708' : '#94A3B8'
                    }}>
                      {completenessLabels[object.completeness[stage]]}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 pt-3 border-t border-[#E2E8F0]">
                <Button variant="secondary" icon={<UploadCloud size={14} />} onClick={() => onOpenUpload(objectId)}>
                  Перейти к загрузке документов
                </Button>
              </div>
            </div>

            <div className="col-span-4 bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide mb-1">Статус процесса</div>
              <div className="text-[13px] text-[#0F172A] font-medium">{processStatusLabels[object.processStatus]}</div>
              <div className="mt-3 text-[12px] text-[#475569] flex flex-col gap-1">
                <span>Кандидатов: <span className="num text-[#0F172A]">{object.candidates}</span></span>
                <span>Подтверждено: <span className="num text-[#0F172A]">{object.confirmed}</span></span>
                <span>Обновлён: <span className="mono text-[#0F172A]">{object.updatedAt}</span></span>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'protocols' && (
          processes.filter((p) => p.protocolId).length === 0 ? (
            <div className="bg-white border border-[#E2E8F0] rounded-lg">
              <EmptyState
                kind="custom"
                icon={<FileText size={22} aria-hidden />}
                title="Протоколов пока нет"
                description="Протокол появится после первого запуска проверки."
              />
            </div>
          ) : (
            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
              <table className="w-full text-[13px] border-collapse">
                <thead>
                  <tr className="bg-[#EDF1F7] text-[#475569] text-[12px]">
                    <th className="text-left font-medium px-3 h-10">Версия</th>
                    <th className="text-left font-medium px-3 h-10">Процесс</th>
                    <th className="text-left font-medium px-3 h-10">Статус</th>
                    <th className="text-left font-medium px-3 h-10">Создан</th>
                  </tr>
                </thead>
                <tbody>
                  {processes.filter((p) => p.protocolId).map((p) => (
                    <tr
                      key={p.processId}
                      className="h-10 border-t border-[#E2E8F0] hover:bg-[#E8F0FB] cursor-pointer"
                      onClick={() => p.protocolId && onOpenProtocol(objectId, p.protocolId)}
                    >
                      <td className="px-3 num text-[#0F172A]">{p.protocolVersion ?? '—'}</td>
                      <td className="px-3 mono text-[11px] text-[#475569]">{p.processId.slice(0, 8)}</td>
                      <td className="px-3 text-[#475569]">{processStatusLabels[p.status]}</td>
                      <td className="px-3 mono text-[12px] text-[#475569]">{p.createdAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeTab === 'history' && (
          processes.length === 0 ? (
            <div className="bg-white border border-[#E2E8F0] rounded-lg py-16 text-center text-[13px] text-[#94A3B8]">
              У объекта ещё не было ни одного процесса
            </div>
          ) : (
            <div className="bg-white border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0]">
              {processes.map((p) => (
                <div key={p.processId} className="px-4 py-3 flex items-center gap-3 text-[13px]">
                  <span className="mono text-[11px] text-[#94A3B8] w-[90px] shrink-0">{p.createdAt}</span>
                  <span className="text-[#0F172A]">{processStatusLabels[p.status]}</span>
                  {p.scenario && <span className="text-[#94A3B8]">· {p.scenario}</span>}
                  {p === latestProcess && (
                    <span className="ml-auto text-[11px] text-[#1B4E9B]">текущий</span>
                  )}
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
