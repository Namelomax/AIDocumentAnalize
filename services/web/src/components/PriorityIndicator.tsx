import type { ReviewPriority } from '../types';

const bars: Record<ReviewPriority, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const labels: Record<ReviewPriority, string> = { HIGH:'▮▮▮', MEDIUM:'▮▮▯', LOW:'▮▯▯' };

export default function PriorityIndicator({ priority }: { priority: ReviewPriority }) {
  const n = bars[priority];
  return (
    <span
      className="inline-flex items-center gap-2 text-[#475569] text-[12px]"
      title={`Приоритет проверки: ${labels[priority]}`}
    >
      <span className="inline-flex gap-[2px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-[3px] h-3 rounded-[1px]"
            style={{ background: i < n ? '#475569' : '#CBD5E1' }}
          />
        ))}
      </span>
      <span className="mono uppercase tracking-wide text-[11px]">{priority}</span>
    </span>
  );
}
