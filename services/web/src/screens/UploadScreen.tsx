import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type DragEvent } from 'react';
import {
  ArrowLeft, UploadCloud, FileText, Trash2, Info, CheckCircle2, AlertTriangle
} from 'lucide-react';
import PageHeader from '../components/PageHeader';
import StageBadge from '../components/StageBadge';
import Button from '../components/Button';
import { SkeletonBlock, SkeletonText } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { approvalLabels, completenessLabels } from '../labels';
import { api, ApiError, uploadPackage } from '../api/client';
import {
  toProjectObject, toUploadedFile, toUploadLimits,
  type ApiFileItem, type ApiObjectDetail, type ApiUploadLimits, type UploadLimits
} from '../api/adapters';
import type { DocStage, ProjectObject, UploadedFile } from '../types';

interface Props {
  objectId: string;
  onBack: () => void;
  onRunCheck: (objectId: string, processId: string) => void;
}

const stageMeta: Record<DocStage, { title: string; hint: string }> = {
  PD: { title: 'Проектная документация (ПД)', hint: 'PDF, DOCX, XML' },
  RD: { title: 'Рабочая документация (РД)',   hint: 'PDF, DOCX, XML' },
  ID: { title: 'Исполнительная документация (ИД)', hint: 'PDF, DOCX, XML' }
};

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} МБ`;
}

/* ─────────── Dropzone ─────────── */

function Dropzone({
  stage, hint, disabled, onFiles
}: {
  stage: DocStage;
  hint: string;
  disabled: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [hover, setHover] = useState(false);
  const inputId = `file-input-${stage}`;

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setHover(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onFiles(files);
  };

  const handleInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) onFiles(files);
    e.target.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={disabled ? undefined : handleDrop}
      className={[
        'rounded-lg border-2 border-dashed px-4 py-5 flex flex-col items-center gap-1.5 transition-colors',
        disabled ? 'opacity-50 pointer-events-none border-[#CBD5E1] bg-[#F8FAFC]'
          : hover ? 'border-[#1B4E9B] bg-[#E8F0FB]' : 'border-[#CBD5E1] bg-[#F8FAFC]'
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
      <div className="text-[11px] text-[#94A3B8]">{hint}</div>
      <input
        id={inputId}
        type="file"
        multiple
        accept=".pdf,.docx,.xml"
        className="hidden"
        disabled={disabled}
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
          <span className="mono text-[#475569]">{file.code || '—'}</span>
          <span>·</span>
          <span>{file.revision}</span>
          <span>·</span>
          <span>{approvalLabels[file.approvalStatus] ?? file.approvalStatus}</span>
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

export default function UploadScreen({ objectId, onBack, onRunCheck }: Props) {
  const { push } = useToast();

  const [object, setObject] = useState<ProjectObject | null>(null);
  const [apiFiles, setApiFiles] = useState<ApiFileItem[]>([]);
  const [limits, setLimits] = useState<UploadLimits | null>(null);
  const [processId, setProcessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);

  const loadFiles = useCallback(async () => {
    const response = await api<{ items: ApiFileItem[] }>(`/api/v1/objects/${objectId}/files`);
    setApiFiles(response.items);
  }, [objectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const [detail, filesResponse, limitsResponse] = await Promise.all([
          api<ApiObjectDetail>(`/api/v1/objects/${objectId}`),
          api<{ items: ApiFileItem[] }>(`/api/v1/objects/${objectId}/files`),
          api<ApiUploadLimits>('/api/v1/upload/limits'),
        ]);
        if (cancelled) return;
        const projectObject = toProjectObject(detail);
        setObject(projectObject);
        setApiFiles(filesResponse.items);
        setLimits(toUploadLimits(limitsResponse));
        // A PENDING latest process already holds whatever was uploaded and
        // never started — pick it up so "Запустить проверку" targets it
        // instead of demanding a fresh upload just to get a process id.
        if (projectObject.processStatus === 'PENDING' && projectObject.latestProcessId) {
          setProcessId(projectObject.latestProcessId);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить объект');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [objectId]);

  const files = useMemo(
    () => apiFiles.filter((f) => f.doc_stage !== null).map(toUploadedFile),
    [apiFiles],
  );
  // doc_stage = null means two different things: the registry row (it never
  // gets a stage) and a document the worker has not classified yet - stages
  // are assigned during processing. Telling them apart by doc_stage alone hid
  // every freshly uploaded PDF, so the registry is recognised by its format.
  const isRegistry = (f: ApiFileItem) => /\.(csv|xlsx|xls|json)$/i.test(f.file_name);
  const registryLoaded = useMemo(() => apiFiles.some(isRegistry), [apiFiles]);
  const unstaged = useMemo(
    () => apiFiles.filter((f) => f.doc_stage === null && !isRegistry(f)),
    [apiFiles],
  );

  const pd = files.filter((f) => f.stage === 'PD');
  const rd = files.filter((f) => f.stage === 'RD');
  const id = files.filter((f) => f.stage === 'ID');

  const totalBytes = useMemo(() => apiFiles.reduce((sum, f) => sum + f.size_bytes, 0), [apiFiles]);
  const maxPackageBytes = limits?.maxPackageBytes ?? 1;

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

  const canRun = processId !== null && !uploading && !starting;

  // Documents.ts has no field for the drop column a file landed in — the
  // worker derives doc_stage itself once the package is parsed. All three
  // dropzones therefore call the same upload, and the file reappears under
  // whichever stage the server assigns it once the file list is refetched.
  const handleUpload = async (fileList: File[]) => {
    setUploading(true);
    try {
      const result = await uploadPackage(objectId, fileList);
      setProcessId(result.process_id);
      if (result.accepted.length > 0) {
        push({
          kind: 'success',
          message: `Загружено файлов: ${result.accepted.length}`,
          detail: result.rejected.length > 0 ? `Отклонено: ${result.rejected.length}` : undefined,
        });
      }
      for (const rejection of result.rejected) {
        push({ kind: 'error', message: rejection.file_name, detail: rejection.message });
      }
      await loadFiles();
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось загрузить пакет',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setUploading(false);
    }
  };

  const handleRegistryInput = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) void handleUpload(files);
  };

  const handleRunCheck = async () => {
    if (!processId) return;
    setStarting(true);
    try {
      await api(`/api/v1/processes/${processId}/start`, { method: 'POST' });
      onRunCheck(objectId, processId);
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось запустить проверку',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setStarting(false);
    }
  };

  // No DELETE endpoint exists yet (services/api/src/routes/documents.ts has
  // none) — the trash icon stays, since removing it would be a layout
  // change this task does not call for, but it is honest about not working.
  const handleDeleteFile = () => {
    push({ kind: 'info', message: 'Удаление загруженных файлов пока недоступно' });
  };

  if (loading) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
        <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
          <SkeletonBlock style={{ width: 240, height: 24 }} />
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

  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', object.name]}
        title={object.name}
        actions={
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
            К объекту
          </Button>
        }
      />

      {/* Шапка объекта */}
      <div className="px-8 pt-4 pb-4 bg-white border-b border-[#E2E8F0]">
        <div className="grid grid-cols-3 gap-6 text-[13px]">
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Адрес</div>
            <div className="text-[#0F172A]">{object.address || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Застройщик</div>
            <div className="text-[#0F172A]">{object.developer || '—'}</div>
          </div>
          <div>
            <div className="text-[11px] text-[#94A3B8] uppercase tracking-wide">Разрешение на строительство</div>
            <div className="mono text-[#0F172A]">{object.permit || '—'}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-5">
        <div className="grid grid-cols-12 gap-6">
          {/* Три колонки */}
          <div className="col-span-9 grid grid-cols-3 gap-4">
            {(['PD', 'RD', 'ID'] as const).map((stage) => {
              const meta = stageMeta[stage];
              const list = stage === 'PD' ? pd : stage === 'RD' ? rd : id;
              return (
                <div key={stage} className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden flex flex-col">
                  <div className="px-4 py-3 border-b border-[#E2E8F0] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <StageBadge stage={stage} />
                      <span className="text-[13px] font-medium text-[#0F172A]">{meta.title}</span>
                    </div>
                    <span className="text-[11px] text-[#94A3B8] num">{list.length}</span>
                  </div>
                  <div className="p-3">
                    <Dropzone
                      stage={stage}
                      hint={limits ? `${meta.hint}. До ${megabytes(limits.maxFileBytes)} на файл` : meta.hint}
                      disabled={uploading}
                      onFiles={(f) => void handleUpload(f)}
                    />
                  </div>
                  <div className="flex-1 overflow-y-auto">
                    {list.length === 0 && (
                      <div className="px-4 py-6 text-center text-[12px] text-[#94A3B8]">
                        Файлы не загружены
                      </div>
                    )}
                    {list.map((f) => (
                      <FileRow key={f.id} file={f} onDelete={handleDeleteFile} />
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
                {(['PD', 'RD', 'ID'] as const).map((stage) => (
                  <div key={stage} className="flex items-center justify-between text-[13px]">
                    <div className="flex items-center gap-2">
                      <StageBadge stage={stage} />
                      <span className="text-[#475569]">
                        {stage === 'PD' ? `${pd.length} файлов` : stage === 'RD' ? `${rd.length} файлов` : `${id.length} файлов`}
                      </span>
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
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[12px] text-[#94A3B8] uppercase tracking-wide mb-1">Тип проверки</div>
              <div className="text-[13px] text-[#0F172A] font-medium">{checkType.ru}</div>
              <div className="text-[11px] text-[#94A3B8] mono mt-1">{checkType.code}</div>
            </div>

            {unstaged.length > 0 && (
              <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
                <div className="text-[13px] font-medium text-[#0F172A] mb-2">
                  Загружено, стадия определится при обработке: {unstaged.length}
                </div>
                <ul className="text-[12px] text-[#475569] space-y-1">
                  {unstaged.map((f) => (
                    <li key={f.id} className="truncate">{f.file_name}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="text-[13px] font-medium text-[#0F172A] mb-2">Реестр файлов</div>
              <div className="text-[12px] text-[#475569] mb-3">
                Загрузите сопроводительный CSV/XLSX/JSON. Без реестра пакет получает статус «Требует уточнения».
              </div>
              {registryLoaded ? (
                <div className="flex items-center gap-2 text-[12px] text-[#027A48]">
                  <CheckCircle2 size={14} /> Реестр загружен
                </div>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    icon={<UploadCloud size={14} />}
                    disabled={uploading}
                    onClick={() => document.getElementById('registry-input')?.click()}
                  >
                    Загрузить реестр
                  </Button>
                  <input
                    id="registry-input"
                    type="file"
                    accept=".csv,.xlsx,.json"
                    className="hidden"
                    disabled={uploading}
                    onChange={handleRegistryInput}
                  />
                </>
              )}
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg p-4">
              <div className="flex items-center justify-between text-[12px] mb-2">
                <span className="text-[#475569] flex items-center gap-1.5">
                  <Info size={12} aria-hidden /> Объём пакета
                </span>
                <span className="num text-[#0F172A]">
                  {megabytes(totalBytes)} из {limits ? megabytes(limits.maxPackageBytes) : '—'}
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#EDF1F7] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#1B4E9B]"
                  style={{ width: `${Math.min(100, (totalBytes / maxPackageBytes) * 100)}%` }}
                />
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
                onClick={() => void handleRunCheck()}
              >
                {starting ? 'Запуск…' : 'Запустить проверку'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
