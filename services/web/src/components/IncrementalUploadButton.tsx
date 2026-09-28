// Customer's ТЗ "Дозагрузка файлов": a file picker that uploads into an
// existing process (services/api's routes/processDocuments.ts) instead of
// creating a new one, shows the same accepted/rejected result the upload
// screen shows for a fresh package, then waits for the worker's incremental
// update to finish and tells the caller to reload. Shared by
// VerificationScreen (the "Дозагрузить документ" link next to a candidate)
// and ProtocolScreen/ObjectScreen (a "Дозагрузить документы" action).
import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import Button from './Button';
import { useToast } from './Toast';
import { api, ApiError, uploadToProcess } from '../api/client';

interface Props {
  processId: string;
  disabled?: boolean;
  // Shown as the button's title when disabled, so the inspector reads why
  // rather than just seeing a greyed-out control (Task spec: "Hide/disable
  // the buttons when the protocol is finalized or the process is PARSING").
  disabledReason?: string;
  label?: string;
  variant?: 'button' | 'link';
  // Called once the worker's incremental update has actually finished (the
  // process left PARSING) - the caller reloads whatever it shows.
  onUpdated?: () => void;
}

const POLL_INTERVAL_MS = 2000;
// Customer's ТЗ: "не более 1 минуты" for the update itself: polled for a few
// minutes past that before giving up on refreshing automatically - a slow
// stand still finishes, this only stops the screen from polling forever.
const MAX_POLLS = 90;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

export default function IncrementalUploadButton({
  processId, disabled, disabledReason, label = 'Дозагрузить документы', variant = 'button', onUpdated,
}: Props) {
  const { push } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pollUntilProcessed = async (): Promise<void> => {
    for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
      await wait(POLL_INTERVAL_MS);
      try {
        const process = await api<{ status: string }>(`/api/v1/processes/${processId}`);
        if (process.status !== 'PARSING') return;
      } catch {
        // A transient failure to poll must not stop the inspector from
        // reloading manually later - just stop polling quietly.
        return;
      }
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    setBusy(true);
    try {
      const result = await uploadToProcess(processId, files);
      if (result.accepted.length > 0) {
        push({ kind: 'success', message: `Дозагружено файлов: ${result.accepted.length}` });
      }
      for (const rejected of result.rejected) {
        push({ kind: 'error', message: rejected.file_name, detail: rejected.message });
      }
      if (result.accepted.length > 0) {
        await pollUntilProcessed();
        onUpdated?.();
      }
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось дозагрузить файлы',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const isDisabled = disabled || busy;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {variant === 'link' ? (
        <button
          type="button"
          disabled={isDisabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => inputRef.current?.click()}
          className="text-[#1B4E9B] hover:underline inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline"
        >
          <UploadCloud size={11} /> {busy ? 'Дозагрузка…' : label}
        </button>
      ) : (
        <Button
          variant="secondary"
          icon={<UploadCloud size={14} />}
          disabled={isDisabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? 'Дозагрузка…' : label}
        </Button>
      )}
    </>
  );
}
