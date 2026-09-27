import type { ReactNode } from 'react';

export default function PageHeader({
  crumbs, title, actions
}: {
  crumbs: string[];
  title: string;
  actions?: ReactNode;
}) {
  return (
    <div className="px-8 pt-6 pb-4 border-b border-[#E2E8F0] bg-white">
      <nav className="text-[12px] text-[#94A3B8] mb-2 flex items-center gap-1.5" aria-label="Хлебные крошки">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>/</span>}
            <span className={i === crumbs.length - 1 ? 'text-[#475569]' : ''}>{c}</span>
          </span>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[20px] leading-7 font-semibold text-[#0F172A]">{title}</h1>
        <div className="flex items-center gap-2">{actions}</div>
      </div>
    </div>
  );
}