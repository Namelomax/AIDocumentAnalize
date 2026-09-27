import { useMemo, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  ArrowLeft, UploadCloud, FileText, Trash2, Info, CheckCircle2,
  AlertTriangle, Bug
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import { useToast } from '../components/Toast';
import { approvalLabels, objects, uploadedFiles } from '../mocks/data';
import type { DocStage, UploadedFile } from '../types';

interface Props {
  objectId: string;
  onBack: () => void;
  onRunCheck: (objectId: string) => void;
}

const stageMeta: Record<DocStage, {
  title: string;
  hint: string;
  totalExpected?: number;
}> = {
  PD: { title: 'Проектная документация (ПД)', hint: 'PDF, DOCX, XML. До 50 МБ на файл' },
  RD: { title: 'Рабочая документация (РД)',   hint: 'PDF, DOCX, XML. До 50 МБ на файл', totalExpected: 15 },
  ID: { title: 'Исполнительная документация (ИД)', hint: 'PDF, DOCX, XML. До 50 МБ на файл' }
};

const ALLOWED_EXT = ['pdf', 'docx', 'xml', 'csv', 'xlsx', 'json'];
const MAX_FILE_MB = 50;
const MAX_PACK_MB = 200;

function completenessText(v: 'full' | 'partial' | 'missing') {
  if (v === 'full')    return { label: 'Загружено полностью', color: '#027A48' };
  if (v === 'partial') return { label: 'Загружено частично',  color: '#B54708' };
  return { label: 'Отсутствует', color: '#94A3B8' };
}

/* ─────────── Dropzone с валидацией ─────────── */

function Dropzone({
  stage,
  onFileAccepted,
  onError
}: {
  stage: DocStage;
  onFileAccepted: (stage: DocStage, file: File) => void;
  onError: (kind: 'format' | 'corrupt' | 'size-file' | 'size-pack' | 'timeout', filename?: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const m = stageMeta[stage];
  const inputId = `file-input-${stage}`;

  const validateAndAccept = (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ALLOWED_EXT.includes(ext)) {
      onError('format', file.name);
      return;
    }
    if (file.name.toLowerCase().includes('corrupt') || file.size === 0) {
      onError('corrupt', file.name);
      return;
    }
    const sizeMb = file.size / (1024 * 1024);
    if (sizeMb > MAX_FILE_MB) {
      onError('size-file', file.name);
      return;
    }
    if (file.name.toLowerCase().includes('timeout')) {
      onError('timeout', file.name);
      return;
    }
    onFileAccepted(stage, file);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    for (const f of files) validateAndAccept(f);
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const f of files) validateAndAccept(f);
    e.target.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={handleDrop}
      className={[
        'rounded-lg border-2 border-dashed px-4 py-5 flex flex-col items-center gap-1.5 transition-colors',
        hover
          ? 'border-[#1B4E9B] bg-[#E8F0FB]'
          : 'border-[#CBD5E1] bg-[#F8FAFC]'
      ].join(' ')}
    >
      <UploadCloud size={22} className="text-[#94A3B8]" aria-hidden />
      <div className="text-[13px] text-[#475569] text-center">
        Перетащите файлы или{' '}
        <label
          htmlFor={inputId}
          className="text-[#1B4E9B] underline-offset-2 hover:underline cursor-pointer"
        >
          выберите
        </label>
      </div>
      <div className="text-[11px] text-[#94A3B8]">{m.hint}</div>
      <input
        id={inputId}
        type="file"
        multiple
        accept=".pdf,.docx,.xml,.csv,.xlsx,.json"
        className="hidden"
        onChange={handleInput}
      />
    </div>
  );
}

function FileRow({ file, onDelete }: { file: UploadedFile; onDelete: (id: string) => void }) {
  return (
    <div className="flex items-start gap-3 py-2 px-2 border-t border-[#E2E8F0] hover:bg-[#F5F7FA]">
      <FileText size={16} className="mt-0.5 text-[#475569] shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-[13px] text-[#0F172A] font-medium truncate">{file.name}</span>
          <StageBadge stage={file.stage} />
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[#94A3B8]">
          <span className="mono text-[#475569]">{file.code}</span>
          <span>·</span>
          <span>{file.revision}</span>
          <span>·</span>
          <span>{approvalLabels[file.approvalStatus]}</span>
          <span>·</span>
          <span>{file.sheets} л.</span>
          <span>·</span>
          <span>{file.size}</span>
        </div>
        <div className="text-[11px] text-[#94A3B8] mono truncate">
          SHA-256: {file.sha256.slice(0, 16)}…
        </div>
      </div>
      <button
        type="button"
        onClick={() => onDelete(file.id)}
        aria-label={`Удалить ${file.name}`}
        className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-[#94A3B8] hover:bg-[#FEF3F2] hover:text-[#B42318]"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function newSha(): string {
  const alphabet = 'abcdef0123456789';
  let out = '';
  for (let i = 0; i < 64; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export default function UploadScreen({ objectId, onBack, onRunCheck }: Props) {
  const obj = useMemo(
    () => objects.find((o) => o.id === objectId) ?? objects[0],
    [objectId]
  );

  const { push } = useToast();
  const [files, setFiles] = useState<UploadedFile[]>(uploadedFiles);
  const [registryLoaded, setRegistryLoaded] = useState(false);

  const pd = files.filter((f) => f.stage === 'PD');
  const rd = files.filter((f) => f.stage === 'RD');
  const id = files.filter((f) => f.stage === 'ID');

  const currentPackMb = useMemo(() => {
    const base = 148;
    const extra = files.length > uploadedFiles.length
      ? (files.length - uploadedFiles.length) * 1.8
      : 0;
    return Math.min(MAX_PACK_MB, Math.round(base + extra));
  }, [files.length]);

  const checkType = (() => {
    const hasPD = pd.length > 0;
    const hasRD = rd.length > 0;
    const hasID = id.length > 0;
    if (hasPD && hasRD && hasID) return { ru: 'Полная проверка (ПД + РД + ИД)', code: 'FULL' };
    if (hasPD && hasRD)          return { ru: 'ПД + РД (Частичная загрузка)',  code: 'PD_RD_PARTIAL' };
    if (hasPD && hasID)          return { ru: 'ПД + ИД',                        code: 'PD_ID' };
    if (hasRD && hasID)          return { ru: 'РД + ИД',                        code: 'RD_ID' };
    if (hasPD || hasRD || hasID) return { ru: 'Одна стадия',                    code: 'SINGLE_STAGE' };
    return { ru: 'Нет документов', code: 'EMPTY' };
  })();

  const canRun = files.length > 0;

  const removeFile = (fileId: string) =>
    setFiles((prev) => prev.filter((f) => f.id !== fileId));

  /* ─────────── Пять ошибок ТЗ ─────────── */

  const showError = (
    kind: 'format' | 'corrupt' | 'size-file' | 'size-pack' | 'timeout',
    filename?: string
  ) => {
    const suffix = filename ? ` · ${filename}` : '';
    switch (kind) {
      case 'format':
        push({ kind: 'error', message: 'Неподдерживаемый формат файла', detail: `Допустимы PDF, DOCX, XML${suffix}` });
        break;
      case 'corrupt':
        push({ kind: 'error', message: 'Файл повреждён или защищён паролем', detail: `Удалите файл и загрузите его заново${suffix}` });
        break;
      case 'size-file':
        push({ kind: 'warning', message: 'Файл превышает 50 МБ', detail: `Разделите документ на части или загрузите в сжатом виде${suffix}` });
        break;
      case 'size-pack':
        push({ kind: 'error', message: 'Превышен общий лимит пакета — 200 МБ', detail: 'Удалите часть файлов из пакета, чтобы продолжить загрузку' });
        break;
      case 'timeout':
        push({ kind: 'warning', message: 'Таймаут обработки', detail: `Сервер не ответил вовремя. Повторите попытку${suffix}` });
        break;
    }
  };

  const handleFileAccepted = (stage: DocStage, file: File) => {
    const sizeMb = file.size / (1024 * 1024);
    if (currentPackMb + sizeMb > MAX_PACK_MB) {
      showError('size-pack');
      return;
    }
    const newFile: UploadedFile = {
      id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: file.name,
      stage,
      mark: stage === 'PD' ? 'П' : stage === 'RD' ? 'РД' : 'ИД',
      code: `АНО/150321/1-${stage === 'PD' ? 'П' : stage === 'RD' ? 'РД' : 'ИД'}-НОВ`,
      revision: 'Ред. 1',
      approvalStatus: 'DRAFT',
      sheets: 1,
      size: `${sizeMb.toFixed(1)} МБ`,
      sha256: newSha()
    };
    setFiles((prev) => [...prev, newFile]);
    push({
      kind: 'success',
      message: 'Файл загружен',
      detail: `${file.name} · добавлен в раздел ${stage}`
    });
  };

  const demoAllErrors = () => {
    showError('format', 'passport.jpg');
    window.setTimeout(() => showError('corrupt', 'КР-04.pdf'), 400);
    window.setTimeout(() => showError('size-file', 'ОВ-архив.pdf'), 800);
    window.setTimeout(() => showError('size-pack'), 1200);
    window.setTimeout(() => showError('timeout', 'ВК-сети.pdf'), 1600);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', obj.name]}
        title={obj.name}
        actions={
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
            К списку объектов
          </Button>
        }
      />

      {/* Шапка объекта */}
      <div className="px-8 pt-4 pb-4 bg-white border-b border-[#E2E8F0]">
        <div className="grid grid-cols-3 gap-6 text-[13px]">
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Адрес</div>
            <div className="text-[#0F172A]">{obj.address}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Застройщик</div>
            <div className="text-[#0F172A]">{obj.developer}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Разрешение на строительство</div>
            <div className="mono text-[#0F172A]">{obj.permit}</div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-5 border-b border-[#E2E8F0] -mb-4">
          <button className="pb-3 border-b-2 border-[#1B4E9B] text-[#1B4E9B] text-[13px] font-medium">
            Документы
          </button>
          <button className="pb-3 border-b-2 border-transparent text-[#475569] hover:text-[#0F172A] text-[13px]">
            Протоколы
          </button>
          <button className="pb-3 border-b-2 border-transparent text-[#475569] hover:text-[#0F172A] text-[13px]">
            История
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-5">
        <div className="grid grid-cols-12 gap-6">
          {/* Три колонки */}
          <div className="col-span-9 grid grid-cols-3 gap-4">
            {(['PD', 'RD', 'ID'] as const).map((stage) => {
              const meta = stageMeta[stage];
              const list = stage === 'PD' ? pd : stage === 'RD' ? rd : id;
              const total = stage === 'RD' ? 15 : undefined;
              return (
                <div key={stage} className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StageBadge stage={stage} />
                      <span className="text-[13px] font-medium text-[#0F172A]">{meta.title}</span>
                    </div>
                    <span className="text-[11px] text-[#94A3B8] num">
                      {list.length}
                      {total ? ` из ${total}` : ''}
                    </span>
                  </div>
                  <div className="p-3">
                    <Dropzone
                      stage={stage}
                      onFileAccepted={handleFileAccepted}
                      onError={showError}
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {list.length === 0 && (
                      <div className="px-4 py-6 text-center text-[12px] text-[#94A3B8]">
                        Файлы не загружены
                      </div>
                    )}
                    {list.map((f) => (
                      <FileRow key={f.id} file={f} onDelete={removeFile} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Правая панель */}
          <div className="col-span-3 flex flex-col gap-4">
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[13px] font-medium text-[#0F172A] mb-3">Комплектность</div>
              <div className="flex flex-col gap-3">
                {(['PD', 'RD', 'ID'] as const).map((stage) => {
                  const c = completenessText(obj.completeness[stage]);
                  return (
                    <div key={stage} className="flex items-center justify-between text-[13px]">
                      <div className="flex items-center gap-2">
                        <StageBadge stage={stage} />
                        <span className="text-[#475569]">
                          {stage === 'PD' ? `${pd.length} файлов`
                            : stage === 'RD' ? `${rd.length} из 15`
                            : 'не загружено'}
                        </span>
                      </div>
                      <span className="text-[12px]" style={{ color: c.color }}>{c.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Тип проверки</div>
              <div className="text-[13px] text-[#0F172A] font-medium">{checkType.ru}</div>
              <div className="text-[11px] text-[#94A3B8] mono mt-1">{checkType.code}</div>
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[13px] font-medium text-[#0F172A] mb-2">Реестр файлов</div>
              <div className="text-[12px] text-[#475569] mb-3">
                Загрузите сопроводительный CSV/XLSX/JSON. Без реестра пакет получает статус «Требует уточнения».
              </div>
              {registryLoaded ? (
                <div className="flex items-center gap-2 text-[12px] text-[#027A48]">
                  <CheckCircle2 size={14} /> Реестр загружен
                  <button
                    type="button"
                    className="ml-auto text-[#1B4E9B] hover:underline text-[12px]"
                    onClick={() => setRegistryLoaded(false)}
                  >
                    Заменить
                  </button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  icon={<UploadCloud size={14} />}
                  onClick={() => {
                    setRegistryLoaded(true);
                    push({ kind: 'success', message: 'Реестр файлов загружен', detail: 'Пакет принят с полным комплектом' });
                  }}
                >
                  Загрузить реестр
                </Button>
              )}
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="flex items-center justify-between text-[12px] mb-2">
                <span className="text-[#475569] flex items-center gap-1.5">
                  <Info size={12} aria-hidden /> Объём пакета
                </span>
                <span className="num text-[#0F172A]">
                  {currentPackMb} МБ из {MAX_PACK_MB} МБ
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#1B4E9B]"
                  style={{ width: `${Math.min(100, (currentPackMb / MAX_PACK_MB) * 100)}%` }}
                />
              </div>
            </div>

            {/* Демонстрация ошибок загрузки (ТЗ 7.3) */}
            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Bug size={14} className="text-[#5925DC]" aria-hidden />
                <div className="text-[13px] font-medium text-[#0F172A]">
                  Проверка ошибок загрузки
                </div>
              </div>
              <div className="text-[11px] text-[#94A3B8] mb-3">
                Пять сценариев из ТЗ. Нажмите, чтобы протестировать уведомления.
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                <button
                  type="button"
                  onClick={() => showError('format', 'смета.jpg')}
                  className="text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] text-[#0F172A]"
                >
                  Формат не поддерживается
                </button>
                <button
                  type="button"
                  onClick={() => showError('corrupt', 'КР-04.pdf')}
                  className="text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] text-[#0F172A]"
                >
                  Файл повреждён
                </button>
                <button
                  type="button"
                  onClick={() => showError('size-file', 'ОВ-архив.pdf')}
                  className="text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] text-[#0F172A]"
                >
                  Превышен размер файла 50 МБ
                </button>
                <button
                  type="button"
                  onClick={() => showError('size-pack')}
                  className="text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] text-[#0F172A]"
                >
                  Превышен лимит пакета 200 МБ
                </button>
                <button
                  type="button"
                  onClick={() => showError('timeout', 'ВК-сети.pdf')}
                  className="text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#E2E8F0] hover:bg-[#F5F7FA] text-[#0F172A]"
                >
                  Таймаут обработки
                </button>
                <button
                  type="button"
                  onClick={demoAllErrors}
                  className="mt-1 text-left text-[12px] px-2.5 py-1.5 rounded-md border border-[#B2CCF5] bg-[#E8F0FB] text-[#1B4E9B] hover:bg-[#DCE8FA]"
                >
                  Показать все пять ошибок
                </button>
              </div>
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 flex flex-col gap-3">
              <div className="flex items-start gap-2 text-[11px] text-[#475569]">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[#B54708]" aria-hidden />
                <span>Файлы можно дозагрузить до финализации протокола.</span>
              </div>
              <Button
                variant="primary"
                size="lg"
                disabled={!canRun}
                onClick={() => onRunCheck(objectId)}
              >
                Запустить проверку
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}