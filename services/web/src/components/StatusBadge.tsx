import type { FindingStatus } from '../types';
import { statusLabels } from '../mocks/data';

const styles: Record<FindingStatus, { text: string; bg: string; dot: string; dashed?: boolean }> = {
  CANDIDATE:              { text:'#B54708', bg:'#FFFAEB', dot:'#B54708' },
  CONFIRMED_VIOLATION:    { text:'#B42318', bg:'#FEF3F2', dot:'#B42318' },
  NEGATIVE_VERIFIED:      { text:'#027A48', bg:'#ECFDF3', dot:'#027A48' },
  CLARIFICATION_REQUIRED: { text:'#5925DC', bg:'#F4F3FF', dot:'#5925DC' },
  MISSING_EVIDENCE:       { text:'#475569', bg:'#F1F5F9', dot:'#475569', dashed:true },
  NOT_APPLICABLE:         { text:'#64748B', bg:'#F8FAFC', dot:'#64748B' },
  NOT_COMPARABLE:         { text:'#475569', bg:'#F1F5F9', dot:'#475569' },
  SUSPICION:              { text:'#026AA2', bg:'#F0F9FF', dot:'#026AA2' }
};

export default function StatusBadge({ status }: { status: FindingStatus }) {
  const s = styles[status];
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 px-2 h-6 rounded-[4px] text-[12px] font-medium whitespace-nowrap',
        s.dashed ? 'border border-dashed border-[#CBD5E1]' : ''
      ].join(' ')}
      style={{ background: s.bg, color: s.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.dot }} aria-hidden />
      {statusLabels[status]}
    </span>
  );
}