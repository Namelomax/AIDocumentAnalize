import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from '../api/client';
import { formatRelativeTime, toNotification } from '../api/adapters';
import type { AppNotification } from '../types';

const POLL_INTERVAL_MS = 30_000;

interface Props {
  // Undefined ids read the same as "nothing to navigate to" - the caller
  // (App.tsx) decides what "открыть объект/протокол" means for each screen.
  onOpen: (notification: AppNotification) => void;
}

export default function NotificationBell({ onOpen }: Props) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchNotifications();
      setItems(response.items.map(toNotification));
      setUnreadCount(response.unread_count);
    } catch {
      // A failed poll is not worth interrupting the interface over - the
      // next tick (or the next manual open) tries again.
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const handleSelect = useCallback((notification: AppNotification) => {
    setOpen(false);
    if (!notification.read) {
      // Optimistic: the click already carries the inspector's intent, and a
      // failed request here just leaves the badge stale until the next poll.
      setItems((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
      setUnreadCount((count) => Math.max(0, count - 1));
      void markNotificationRead(notification.id).catch(() => {});
    }
    onOpen(notification);
  }, [onOpen]);

  const handleReadAll = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
    void markAllNotificationsRead().catch(() => {});
  }, []);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Уведомления"
        aria-label="Уведомления"
        className="relative w-9 h-9 rounded-md flex items-center justify-center text-[#475569] hover:bg-[#E8F0FB] hover:text-[#1B4E9B]"
      >
        <Bell size={18} strokeWidth={1.75} aria-hidden />
        {unreadCount > 0 && (
          <span
            className="absolute top-0.5 right-0.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-[#B42318] text-white text-[9px] leading-[15px] text-center font-medium"
            aria-label={`Непрочитанных уведомлений: ${unreadCount}`}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-12 bottom-0 w-80 max-h-[420px] overflow-y-auto bg-white border border-[#E2E8F0] rounded-lg shadow-lg z-50">
          <div className="sticky top-0 bg-white flex items-center justify-between px-3 h-9 border-b border-[#E2E8F0]">
            <span className="text-[12px] font-medium text-[#0F172A]">Уведомления</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleReadAll}
                className="text-[11px] text-[#1B4E9B] hover:underline"
              >
                Прочитать все
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[#94A3B8]">Уведомлений нет</div>
          ) : (
            <ul>
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(n)}
                    className={[
                      'w-full text-left px-3 py-2.5 border-b border-[#F1F5F9] hover:bg-[#F8FAFC] flex gap-2',
                      n.read ? '' : 'bg-[#F0F9FF]',
                    ].join(' ')}
                  >
                    <span
                      className="w-1.5 h-1.5 mt-1.5 rounded-full shrink-0"
                      style={{ background: n.read ? 'transparent' : '#1B4E9B' }}
                      aria-hidden
                    />
                    <span className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-[12px] font-medium text-[#0F172A] truncate">{n.title}</span>
                      <span className="text-[11px] text-[#475569] line-clamp-2">{n.body}</span>
                      <span className="text-[10px] text-[#94A3B8]">{formatRelativeTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
