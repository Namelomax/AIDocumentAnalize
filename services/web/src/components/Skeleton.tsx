import type { CSSProperties } from 'react';

interface BlockProps {
  className?: string;
  style?: CSSProperties;
}

export function SkeletonBlock({ className = '', style }: BlockProps) {
  return (
    <div
      aria-hidden
      className={[
        'animate-pulse bg-[#EDF1F7] rounded-[4px]',
        className
      ].join(' ')}
      style={style}
    />
  );
}

export function SkeletonText({
  lines = 1,
  width = '100%',
  height = 12
}: {
  lines?: number;
  width?: string | number;
  height?: number;
}) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonBlock
          key={i}
          style={{
            width: typeof width === 'number' ? `${width}px` : width,
            height
          }}
        />
      ))}
    </div>
  );
}

/**
 * Скелетон строки таблицы: невысокая полоса под одну строку высотой 40px.
 */
export function SkeletonRow() {
  return (
    <div className="h-10 border-t border-[#E2E8F0] flex items-center gap-3 px-3">
      <SkeletonBlock style={{ width: 6, height: 24 }} />
      <SkeletonBlock style={{ width: 160, height: 12 }} />
      <SkeletonBlock style={{ width: 120, height: 12 }} />
      <SkeletonBlock style={{ width: 90,  height: 12 }} />
      <SkeletonBlock style={{ width: 140, height: 12 }} />
      <SkeletonBlock style={{ width: 60,  height: 12, marginLeft: 'auto' }} />
      <SkeletonBlock style={{ width: 80,  height: 12 }} />
    </div>
  );
}

/**
 * Скелетон списка строк таблицы — используется в Dashboard и Protocol.
 */
export function SkeletonTable({ rows = 6 }: { rows?: number }) {
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
      <div className="h-10 bg-[#EDF1F7] flex items-center gap-3 px-3">
        <SkeletonBlock style={{ width: 160, height: 12 }} />
        <SkeletonBlock style={{ width: 120, height: 12 }} />
        <SkeletonBlock style={{ width: 90,  height: 12 }} />
        <SkeletonBlock style={{ width: 140, height: 12 }} />
        <SkeletonBlock style={{ width: 60,  height: 12, marginLeft: 'auto' }} />
        <SkeletonBlock style={{ width: 80,  height: 12 }} />
      </div>
      {Array.from({ length: rows }).map((_, i) => <SkeletonRow key={i} />)}
    </div>
  );
}

/**
 * Скелетон панели просмотра чертежа (EvidencePanel).
 */
export function SkeletonEvidencePanel() {
  return (
    <div className="flex flex-col bg-white border border-[#E2E8F0] rounded-lg overflow-hidden flex-1 min-w-0">
      <div className="px-3 py-2 border-b border-[#E2E8F0] flex items-center gap-2">
        <SkeletonBlock style={{ width: 30, height: 20 }} />
        <SkeletonBlock style={{ width: 180, height: 12 }} />
        <SkeletonBlock style={{ width: 60, height: 12, marginLeft: 'auto' }} />
      </div>
      <div className="relative flex-1 bg-[#F8FAFC] min-h-[180px] p-4">
        <SkeletonBlock style={{ width: '70%', height: 12, marginBottom: 12 }} />
        <SkeletonBlock style={{ width: '90%', height: 12, marginBottom: 12 }} />
        <SkeletonBlock style={{ width: '55%', height: 12, marginBottom: 12 }} />
        <SkeletonBlock style={{ width: '80%', height: 12, marginBottom: 12 }} />
        <SkeletonBlock style={{ width: '65%', height: 12, marginBottom: 12 }} />
      </div>
      <div className="px-3 py-2 border-t border-[#E2E8F0] flex items-center gap-2">
        <SkeletonBlock style={{ width: 220, height: 12 }} />
        <SkeletonBlock style={{ width: 120, height: 12, marginLeft: 'auto' }} />
      </div>
    </div>
  );
}

/**
 * Скелетон очереди кандидатов (левая панель верификации).
 */
export function SkeletonQueue({ rows = 10 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-0">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="px-3 py-2 border-b border-[#E2E8F0] flex items-center gap-2">
          <SkeletonBlock style={{ width: 16, height: 16, borderRadius: 999 }} />
          <SkeletonBlock style={{ width: 40, height: 12 }} />
          <SkeletonBlock style={{ width: 140, height: 12 }} />
          <SkeletonBlock style={{ width: 50, height: 12, marginLeft: 'auto' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Универсальный скелетон карточки — например, для гипотез.
 */
export function SkeletonCard() {
  return (
    <div className="bg-white border border-[#E2E8F0] rounded-lg p-5 flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <SkeletonBlock style={{ width: 130, height: 24 }} />
        <SkeletonBlock style={{ width: 140, height: 12 }} />
        <SkeletonBlock style={{ width: 80,  height: 12, marginLeft: 'auto' }} />
      </div>
      <SkeletonBlock style={{ width: '60%', height: 16 }} />
      <SkeletonText lines={2} height={12} />
      <div className="flex items-center gap-3 pt-2 border-t border-[#E2E8F0]">
        <SkeletonBlock style={{ width: 180, height: 36 }} />
        <SkeletonBlock style={{ width: 160, height: 36 }} />
      </div>
    </div>
  );
}