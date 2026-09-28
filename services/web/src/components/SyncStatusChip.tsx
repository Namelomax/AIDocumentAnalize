// Section 9.6: the transfer-to-ИАИС-«РиН» state, shown wherever a finalized
// protocol appears (ProtocolScreen, FinalizationScreen). A FAILED transfer
// gets a "Повторить" button for a supervisor/administrator
// (POST /api/v1/protocols/:id/sync, same authority section 9.3 requires to
// unfinalize) - everyone else only ever sees the chip.
import { useState } from 'react';
import { RotateCw } from 'lucide-react';
import Button from './Button';
import { useToast } from './Toast';
import { api, ApiError, getSession } from '../api/client';
import { syncStatusColor, syncStatusLabels } from '../labels';
import type { SyncStatus } from '../types';

interface Props {
  protocolId: string;
  syncStatus: SyncStatus | null;
  // Called once a resync was accepted, so the caller re-fetches the
  // protocol and shows PENDING_SYNC instead of the FAILED this button just
  // acted on.
  onRequeued?: () => void;
}

export default function SyncStatusChip({ protocolId, syncStatus, onRequeued }: Props) {
  const { push } = useToast();
  const session = getSession();
  const [retrying, setRetrying] = useState(false);

  // Never attempted (protocol not yet finalized, or finalized before this
  // feature existed) - nothing to show.
  if (!syncStatus) return null;

  const canRetry = syncStatus === 'FAILED'
    && (session?.user.role === 'SUPERVISOR' || session?.user.role === 'ADMIN');

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await api(`/api/v1/protocols/${protocolId}/sync`, { method: 'POST' });
      push({ kind: 'success', message: 'Повторная передача поставлена в очередь' });
      onRequeued?.();
    } catch (err) {
      push({
        kind: 'error',
        message: 'Не удалось поставить повторную передачу в очередь',
        detail: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setRetrying(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="inline-flex items-center gap-1.5 text-[12px] px-2 h-6 rounded-full border"
        style={{ color: syncStatusColor(syncStatus), borderColor: syncStatusColor(syncStatus) }}
      >
        {syncStatusLabels[syncStatus] ?? syncStatus}
      </span>
      {canRetry && (
        <Button variant="secondary" icon={<RotateCw size={12} />} disabled={retrying} onClick={() => void handleRetry()}>
          {retrying ? 'Отправка…' : 'Повторить'}
        </Button>
      )}
    </span>
  );
}
