import type { DocStage } from '../types';

const active: Record<DocStage, { bg: string; text: string; border: string }> = {
  PD: { bg:'#EFF4FF', text:'#1849A9', border:'#D1E0FF' },
  RD: { bg:'#F3F4F6', text:'#344054', border:'#E5E7EB' },
  ID: { bg:'#F9FAFB', text:'#475569', border:'#E5E7EB' }
};

export default function StageBadge({
  stage,
  active: isActive = true
}: {
  stage: DocStage;
  active?: boolean;
}) {
  const s = active[stage];
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 h-5 rounded-[4px] text-[11px] font-medium border"
      style={
        isActive
          ? { background: s.bg, color: s.text, borderColor: s.border }
          : { background:'#F8FAFC', color:'#94A3B8', borderColor:'#E2E8F0' }
      }
    >
      {stage}
    </span>
  );
}