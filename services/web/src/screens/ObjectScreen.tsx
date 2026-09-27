import { useState } from 'react';
import {
  ChevronRight, Upload, File, Trash2, AlertTriangle,
  CheckCircle, Clock, X,
} from 'lucide-react';
import type { DocStage, CompletenessStatus } from '../types';
import { MOCK_OBJECTS, MOCK_PD_FILES, MOCK_RD_FILES, MOCK_PROTOCOL } from '../mocks/data';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import type { NavState } from '../App';

interface Props {
  objectId: string;
  onNavigate: (screen: NavState['screen'], objectId?: string, protocolId?: string) => void;
}

const SECTION_COLORS: Record<string, string> = {
  ПЗ: '#6366F1', АР: '#0891B2', КР: '#059669', ОВ: '#D97706',
  ВК: '#7C3AED', ЭО: '#DC2626', ПБ: '#EA580C', ООС: '#16A34A',
  ГП: '#0369A1', ТМ: '#9333EA', СМ: '#475569', ПОС: '#0F172A',
};

function CompletenessIcon({ status }: { status: CompletenessStatus }) {
  if (status === 'full') return <CheckCircle size={14} color="#027A48" />;
  if (status === 'partial') return <Clock size={14} color="#B54708" />;
  return <AlertTriangle size={14} color="#94A3B8" />;
}

export default function ObjectScreen({ objectId, onNavigate }: Props) {
  const obj = MOCK_OBJECTS.find(o => o.id === objectId) ?? MOCK_OBJECTS[0];
  const [activeTab, setActiveTab] = useState<'docs' | 'protocols' | 'history'>('docs');
  const [toast, setToast] = useState<{ text: string; type: 'error' | 'info' } | null>(null);

  const totalSizeMb = [...MOCK_PD_FILES, ...MOCK_RD_FILES].reduce((s, f) => s + f.sizeMb, 0);
  const maxMb = 200;

  const compl: Record<DocStage, { status: CompletenessStatus; label: string }> = {
    PD: { status: obj.pdComplete, label: obj.pdComplete === 'full' ? `Загружено полностью (${obj.pdFileCount} файлов)` : obj.pdComplete === 'partial' ? `Загружено частично (${obj.pdFileCount} из ${obj.pdTotalExpected ?? '?'})` : 'Отсутствует' },
    RD: { status: obj.rdComplete, label: obj.rdComplete === 'full' ? `Загружено полностью (${obj.rdFileCount} файлов)` : obj.rdComplete === 'partial' ? `Загружено частично (${obj.rdFileCount} из ${obj.rdTotalExpected ?? '?'})` : 'Отсутствует' },
    ID: { status: obj.idComplete, label: obj.idComplete === 'full' ? `Загружено полностью (${obj.idFileCount} файлов)` : obj.idComplete === 'partial' ? `Загружено частично (${obj.idFileCount} из 10)` : 'Отсутствует' },
  };

  const checkType = obj.idComplete === 'missing'
    ? (obj.rdComplete === 'missing' ? 'ПД' : 'ПД + РД (Частичная загрузка)')
    : 'FULL (ПД + РД + ИД)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Topbar */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 24px', height: 48,
          backgroundColor: '#FFFFFF', borderBottom: '1px solid #E2E8F0', flexShrink: 0,
        }}
      >
        <button
          onClick={() => onNavigate('dashboard')}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#1B4E9B', fontSize: 13, fontFamily: 'inherit', padding: 0 }}
        >
          Объекты
        </button>
        <ChevronRight size={14} color="#94A3B8" />
        <span style={{ fontSize: 13, color: '#0F172A', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {obj.name}
        </span>
      </div>

      {/* Object header */}
      <div
        style={{
          backgroundColor: '#FFFFFF', borderBottom: '1px solid #E2E8F0',
          padding: '12px 24px', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: '#0F172A', lineHeight: '24px' }}>
              {obj.name}. {obj.address}
            </h1>
            <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
              <span style={{ fontSize: 12, color: '#475569' }}>Застройщик: <strong>{obj.developer}</strong></span>
              <span style={{ fontSize: 12, color: '#475569' }}>Разрешение: <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>{obj.permitNumber}</span></span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <StageBadge stage="PD" completeness={obj.pdComplete} size="md" />
            <StageBadge stage="RD" completeness={obj.rdComplete} size="md" />
            <StageBadge stage="ID" completeness={obj.idComplete} size="md" />
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, marginTop: 12, borderBottom: '2px solid #E2E8F0' }}>
          {(['docs', 'protocols', 'history'] as const).map(tab => {
            const labels = { docs: 'Документы', protocols: 'Протоколы', history: 'История' };
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '6px 16px', border: 'none', background: 'none', cursor: 'pointer',
                  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                  color: activeTab === tab ? '#1B4E9B' : '#475569',
                  borderBottom: `2px solid ${activeTab === tab ? '#1B4E9B' : 'transparent'}`,
                  marginBottom: -2,
                }}
              >
                {labels[tab]}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {activeTab === 'docs' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 280px', gap: 16 }}>
            {/* PD column */}
            <DocZoneColumn
              stage="PD"
              files={MOCK_PD_FILES}
              onDropError={msg => setToast({ text: msg, type: 'error' })}
            />

            {/* RD column */}
            <DocZoneColumn
              stage="RD"
              files={MOCK_RD_FILES}
              totalExpected={obj.rdTotalExpected}
              onDropError={msg => setToast({ text: msg, type: 'error' })}
            />

            {/* ID column */}
            <DocZoneColumn
              stage="ID"
              files={[]}
              onDropError={msg => setToast({ text: msg, type: 'error' })}
            />

            {/* Right sidebar */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Completeness panel */}
              <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, padding: 16 }}>
                <h3 style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Комплектность</h3>
                {(['PD', 'RD', 'ID'] as DocStage[]).map(stage => {
                  const c = compl[stage];
                  const labels: Record<DocStage, string> = { PD: 'Проектная (ПД)', RD: 'Рабочая (РД)', ID: 'Исполнительная (ИД)' };
                  return (
                    <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <CompletenessIcon status={c.status} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 500, color: '#0F172A' }}>{labels[stage]}</div>
                        <div style={{ fontSize: 11, color: '#94A3B8' }}>{c.label}</div>
                      </div>
                    </div>
                  );
                })}
                <div
                  style={{
                    marginTop: 12, padding: '6px 10px',
                    backgroundColor: '#EDF1F7', borderRadius: 6,
                    fontSize: 12, color: '#475569',
                  }}
                >
                  <span style={{ fontWeight: 600, color: '#0F172A' }}>Тип проверки: </span>
                  {checkType}
                  <span style={{ display: 'block', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                    {obj.idComplete === 'missing' ? 'PD+RD · PARTIAL' : 'FULL'}
                  </span>
                </div>
              </div>

              {/* File registry */}
              <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, padding: 16 }}>
                <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, color: '#0F172A' }}>Реестр файлов</h3>
                <p style={{ margin: '0 0 8px', fontSize: 11, color: '#94A3B8' }}>
                  CSV/XLSX/JSON — без реестра пакет принимается со статусом «Требует уточнения»
                </p>
                <Dropzone label="Загрузить реестр" accept="CSV, XLSX, JSON" onDrop={() => {}} compact />
              </div>

              {/* Storage indicator + launch */}
              <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: '#475569' }}>Объём пакета</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A', fontVariantNumeric: 'tabular-nums' }}>
                    {totalSizeMb.toFixed(0)} МБ из {maxMb} МБ
                  </span>
                </div>
                <div style={{ height: 6, backgroundColor: '#EDF1F7', borderRadius: 4, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, (totalSizeMb / maxMb) * 100)}%`,
                      backgroundColor: totalSizeMb > maxMb * 0.9 ? '#D97706' : '#1B4E9B',
                      borderRadius: 4,
                      transition: 'width 300ms ease',
                    }}
                  />
                </div>
                <p style={{ fontSize: 11, color: '#94A3B8', margin: '8px 0 12px' }}>
                  Файлы можно дозагрузить до финализации протокола.
                </p>
                <Button
                  variant="primary"
                  size="lg"
                  fullWidth
                  onClick={() => onNavigate('protocol', objectId, MOCK_PROTOCOL.id)}
                >
                  Запустить проверку
                </Button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'protocols' && (
          <div
            style={{
              backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0',
              borderRadius: 8, padding: 24, textAlign: 'center',
            }}
          >
            <div style={{ marginBottom: 12 }}>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 13, color: '#1B4E9B', cursor: 'pointer', fontWeight: 500,
                }}
                onClick={() => onNavigate('protocol', objectId, MOCK_PROTOCOL.id)}
              >
                Протокол № {MOCK_PROTOCOL.number} — {new Date().toLocaleDateString('ru-RU')}
              </span>
            </div>
          </div>
        )}

        {activeTab === 'history' && (
          <div style={{ backgroundColor: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 8, padding: 24, color: '#94A3B8', textAlign: 'center', fontSize: 13 }}>
            История изменений объекта
          </div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 24, right: 24,
            backgroundColor: toast.type === 'error' ? '#FEF3F2' : '#F0F9FF',
            border: `1px solid ${toast.type === 'error' ? '#FECACA' : '#BAE6FD'}`,
            color: toast.type === 'error' ? '#B42318' : '#026AA2',
            borderRadius: 8, padding: '10px 16px',
            display: 'flex', alignItems: 'center', gap: 8,
            fontSize: 13, zIndex: 100,
            boxShadow: '0 4px 12px rgba(15,23,42,0.12)',
          }}
        >
          <AlertTriangle size={14} />
          {toast.text}
          <button
            onClick={() => setToast(null)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', marginLeft: 8, color: 'inherit' }}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function DocZoneColumn({
  stage, files, totalExpected, onDropError,
}: {
  stage: DocStage;
  files: { id: string; name: string; format: string; size: string; section: string; documentCode: string; revision: string; sheets: number; sha256: string }[];
  totalExpected?: number;
  onDropError: (msg: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const labels: Record<DocStage, string> = {
    PD: 'Проектная документация (ПД)',
    RD: 'Рабочая документация (РД)',
    ID: 'Исполнительная документация (ИД)',
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) {
      onDropError('Файл превышает 50 МБ');
      return;
    }
    const ext = f.name.split('.').pop()?.toUpperCase();
    if (!['PDF', 'DOCX', 'XML'].includes(ext ?? '')) {
      onDropError('Формат не поддерживается. Допустимы PDF, DOCX, XML');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StageBadge stage={stage} size="md" />
        <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>{labels[stage]}</span>
        {files.length > 0 && totalExpected && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>
            {files.length} из {totalExpected}
          </span>
        )}
      </div>

      <Dropzone
        label={`Перетащите файлы ПД или нажмите`}
        accept="PDF, DOCX, XML · макс. 50 МБ"
        dragging={dragging}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDrop2={() => {}}
      />

      {files.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
          Нет загруженных файлов
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {files.map(f => (
            <div
              key={f.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 8px', borderRadius: 6,
                backgroundColor: '#F8FAFC', border: '1px solid #E2E8F0',
                fontSize: 12,
              }}
            >
              <div
                style={{
                  width: 28, height: 28, borderRadius: 4, flexShrink: 0,
                  backgroundColor: '#EDF1F7', display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <File size={14} color="#475569" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: '#0F172A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.section} · {f.name}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 1 }}>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#475569' }}>{f.documentCode}</span>
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#94A3B8' }}>Ред. {f.revision}</span>
                  <span style={{ fontSize: 10, color: '#94A3B8' }}>{f.sheets} л.</span>
                </div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#CBD5E1', marginTop: 1 }}>
                  {f.sha256.slice(0, 16)}...
                </div>
              </div>
              <span style={{ fontSize: 11, color: '#94A3B8', flexShrink: 0 }}>{f.size}</span>
              <button
                aria-label="Удалить файл"
                style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#94A3B8', display: 'flex', flexShrink: 0 }}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Dropzone({
  label, accept, dragging = false, compact = false, onDragOver, onDragLeave, onDrop, onDrop2,
}: {
  label?: string;
  accept?: string;
  dragging?: boolean;
  compact?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: () => void;
  onDrop?: (e: React.DragEvent) => void;
  onDrop2?: () => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 4,
        border: `1.5px dashed ${dragging ? '#1B4E9B' : '#CBD5E1'}`,
        borderRadius: 8,
        padding: compact ? '12px' : '20px',
        backgroundColor: dragging ? '#E8F0FB' : '#FAFBFC',
        cursor: 'pointer',
        transition: 'all 100ms ease',
        textAlign: 'center',
      }}
    >
      <Upload size={compact ? 14 : 18} color={dragging ? '#1B4E9B' : '#94A3B8'} />
      {!compact && <p style={{ margin: 0, fontSize: 12, color: '#475569', fontWeight: 500 }}>{label ?? 'Загрузить файлы'}</p>}
      {accept && <p style={{ margin: 0, fontSize: 11, color: '#94A3B8' }}>{accept}</p>}
    </div>
  );
}
