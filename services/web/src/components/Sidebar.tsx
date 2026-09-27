import { Building2, FileText, Lightbulb, ScrollText } from 'lucide-react';
import type { ScreenId } from '../App';

interface Props {
  activeSection: ScreenId;
  onNavigate: (screen: ScreenId) => void;
}

const items: { id: ScreenId; icon: typeof Building2; label: string }[] = [
  { id:'dashboard',  icon: Building2,  label:'Объекты' },
  { id:'protocol',   icon: FileText,   label:'Протоколы' },
  { id:'hypotheses', icon: Lightbulb,  label:'Гипотезы' },
  { id:'finalization', icon: ScrollText, label:'Журнал аудита' }
];

export default function Sidebar({ activeSection, onNavigate }: Props) {
  return (
    <aside className="w-14 shrink-0 h-screen border-r border-[#E2E8F0] bg-white flex flex-col items-center py-3 gap-1">
      <button
        type="button"
        onClick={() => onNavigate('dashboard')}
        aria-label="На главную"
        className="w-9 h-9 rounded-md bg-[#1B4E9B] text-white flex items-center justify-center font-semibold text-[13px] hover:bg-[#16407F]"
      >
        ИИ
      </button>

      <nav className="mt-4 flex flex-col gap-1" aria-label="Основная навигация">
        {items.map(({ id, icon: Icon, label }) => {
          const active = activeSection === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className={[
                'w-10 h-10 rounded-md flex items-center justify-center transition-colors',
                active
                  ? 'bg-[#E8F0FB] text-[#1B4E9B]'
                  : 'text-[#475569] hover:bg-[#E8F0FB] hover:text-[#1B4E9B]'
              ].join(' ')}
            >
              <Icon size={18} strokeWidth={1.75} />
            </button>
          );
        })}
      </nav>
    </aside>
  );
}