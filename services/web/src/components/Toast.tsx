import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode
} from 'react';
import { Info, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  detail?: string;
  duration?: number;
}

interface ToastContextValue {
  push: (t: Omit<ToastItem, 'id'>) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLE: Record<ToastKind, {
  bg: string;
  border: string;
  text: string;
  icon: ReactNode;
}> = {
  info: {
    bg: '#EFF8FF', border: '#B2DDFF', text: '#1849A9',
    icon: <Info size={16} aria-hidden />
  },
  success: {
    bg: '#ECFDF3', border: '#A6F4C5', text: '#027A48',
    icon: <CheckCircle2 size={16} aria-hidden />
  },
  warning: {
    bg: '#FFFAEB', border: '#FEDF89', text: '#B54708',
    icon: <AlertTriangle size={16} aria-hidden />
  },
  error: {
    bg: '#FEF3F2', border: '#FECDCA', text: '#B42318',
    icon: <XCircle size={16} aria-hidden />
  }
};

function ToastCard({ item, onClose }: { item: ToastItem; onClose: (id: string) => void }) {
  const style = KIND_STYLE[item.kind];

  useEffect(() => {
    const dur = item.duration ?? 5200;
    if (dur <= 0) return;
    const t = window.setTimeout(() => onClose(item.id), dur);
    return () => window.clearTimeout(t);
  }, [item.id, item.duration, onClose]);

  return (
    <div
      role={item.kind === 'error' ? 'alert' : 'status'}
      className="w-[380px] rounded-lg border shadow-md px-4 py-3 flex items-start gap-3"
      style={{ background: style.bg, borderColor: style.border }}
    >
      <span className="shrink-0 mt-0.5" style={{ color: style.text }}>
        {style.icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium leading-5" style={{ color: style.text }}>
          {item.message}
        </div>
        {item.detail && (
          <div className="text-[12px] text-[#475569] leading-5 mt-0.5 break-words">
            {item.detail}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onClose(item.id)}
        aria-label="Закрыть уведомление"
        className="shrink-0 w-6 h-6 flex items-center justify-center rounded-md hover:bg-black/5"
        style={{ color: style.text }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setItems((prev) => [...prev, { ...t, id }]);
  }, []);

  const close = useCallback((id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
      >
        {items.map((item) => (
          <div key={item.id} className="pointer-events-auto">
            <ToastCard item={item} onClose={close} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast должен вызываться внутри <ToastProvider>');
  }
  return ctx;
}