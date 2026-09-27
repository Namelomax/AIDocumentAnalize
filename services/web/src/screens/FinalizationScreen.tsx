import { useState } from 'react';
import { ArrowLeft, FileText, FileType, FileCode, RefreshCw, AlertCircle } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import { protocol, inspector } from '../mocks/data';

interface Props {
  protocolId: string;
  onBack: () => void;
}

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
  const [showModal, setShowModal] = useState(false);
  const [finalized, setFinalized] = useState(false);

  const candidates  = protocol.summary.candidates;
  const confirmed   = protocol.summary.confirmed;
  const rejected    = 9;
  const clarification = 2;
  const noEvidence  = protocol.summary.noEvidence;

  const canFinalize = !finalized;

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', 'Торговое здание, Алтуфьевское ш., 79Б', `Протокол № ${protocol.number}`, 'Финализация']}
        title="Финализация протокола"
        actions={
          <>
            <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
              Назад к верификации
            </Button>
            <Button
              variant="primary"
              disabled={!canFinalize}
              onClick={() => setShowModal(true)}
            >
              Финализировать протокол
            </Button>
          </>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        {finalized && (
          <div className="mb-5 bg-[#ECFDF3] border border-[#A6F4C5] rounded-lg px-4 py-3 text-[13px] text-[#027A48]">
            Протокол финализирован. Дозагрузка документов и изменение решений недоступны.
            Отмена финализации — только администратором.
          </div>
        )}

        {/* Сводка */}
        <div className="flex gap-4 mb-5">
          <StatTile label="Обработано кандидатов" value={candidates} total={candidates} accent="ok" />
          <StatTile label="Подтверждено нарушений" value={confirmed} accent="danger" />
          <StatTile label="Отклонено" value={rejected} />
          <StatTile label="Требует уточнения" value={clarification} accent="warn" />
        </div>

        {/* Свёрнутый блок MISSING_EVIDENCE */}
        <details className="bg-white border border-[#E2E8F0] rounded-lg mb-5">
          <summary className="px-4 py-3 cursor-pointer text-[13px] text-[#0F172A] flex items-center gap-2 select-none">
            <AlertCircle size={14} className="text-[#475569]" aria-hidden />
            Без доказательств — <span className="num">{noEvidence}</span> записей
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
            <Button variant="secondary" icon={<FileText size={14} />}>PDF</Button>
            <Button variant="secondary" icon={<FileType size={14} />}>DOCX</Button>
            <Button variant="secondary" icon={<FileCode size={14} />}>XML</Button>
          </div>
        </div>

        {/* ИАИС */}
        <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 mb-5">
          <div className="flex items-start gap-3">
            <AlertCircle size={18} className="text-[#B54708] shrink-0 mt-0.5" aria-hidden />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-[#0F172A]">
                Передача в ИАИС «Разрешения и нарушения»
              </div>
              <div className="text-[12px] text-[#B54708] mt-1">
                Ожидает повтора — внешняя система недоступна. Повторная отправка через 5 минут
                (попытка 2 из 3). Финализированное решение инспектора сохранено и не отменяется.
              </div>
            </div>
            <Button variant="secondary" icon={<RefreshCw size={14} />}>Повторить сейчас</Button>
          </div>
        </div>

        {/* Финальная кнопка */}
        <div className="flex justify-end">
          <Button
            variant="primary"
            size="lg"
            disabled={!canFinalize}
            onClick={() => setShowModal(true)}
          >
            Финализировать протокол
          </Button>
        </div>

        <div className="mt-6 text-[12px] text-[#94A3B8] mono">
          Финализацию выполнит: {inspector.name} · {inspector.role}
        </div>
      </div>

      {/* Единственное модальное окно сценария */}
      {showModal && (
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
              Отмена финализации доступна только администратору.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setShowModal(false)}>Отмена</Button>
              <Button
                variant="primary"
                onClick={() => { setShowModal(false); setFinalized(true); }}
              >
                Финализировать
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}