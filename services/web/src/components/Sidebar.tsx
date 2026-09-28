import { Building2, FileText, Lightbulb, LogOut, ScrollText, BarChart3 } from 'lucide-react';
import type { ScreenId } from '../App';
import type { SessionUser } from '../api/client';
import type { AppNotification } from '../types';
import NotificationBell from './NotificationBell';

interface Props {
  activeSection: ScreenId;
  onNavigate: (screen: ScreenId) => void;
  user: SessionUser;
  onLogout: () => void;
  onOpenNotification: (notification: AppNotification) => void;
}

// "СА" from "Смирнов А.В.", "И" from a bare login with no full name — the
// avatar has room for two characters, not a whole name.
function initials(user: SessionUser): string {
  const source = user.fullName.trim() || user.login;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const items: { id: ScreenId; icon: typeof Building2; label: string }[] = [
  { id:'dashboard',  icon: Building2,  label:'Объекты' },
  { id:'protocols',  icon: FileText,   label:'Протоколы' },
  { id:'hypotheses', icon: Lightbulb,  label:'Гипотезы' },
  { id:'finalization', icon: ScrollText, label:'Журнал аудита' }
];

// Section 9.4/14: the "Качество" screen (dataset_version releases,
// acceptance metrics, weekly reports) is for whoever curates data or
// oversees the retraining loop - not every inspector's daily tool, the same
// reasoning routes/quality.ts's own requireRole list follows.
const QUALITY_ROLES = new Set(['ADMIN', 'ML_ENGINEER', 'SUPERVISOR']);

export default function Sidebar({ activeSection, onNavigate, user, onLogout, onOpenNotification }: Props) {
  const visibleItems = QUALITY_ROLES.has(user.role)
    ? [...items, { id: 'quality' as ScreenId, icon: BarChart3, label: 'Качество' }]
    : items;
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
        {visibleItems.map(({ id, icon: Icon, label }) => {
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

      <div className="mt-auto flex flex-col items-center gap-1">
        <NotificationBell onOpen={onOpenNotification} />

        {/* User + logout — the interface had no way to sign out before this;
            an icon-sized avatar matches the rest of this sidebar rather than
            adding a name/role panel the icon-only layout has no room for. */}
        <button
          type="button"
          onClick={onLogout}
          title={`${user.fullName || user.login} · ${user.role} · Выйти`}
          aria-label={`Выйти (${user.fullName || user.login})`}
          className="w-9 h-9 rounded-full bg-[#EDF1F7] text-[#475569] flex items-center justify-center font-semibold text-[12px] hover:bg-[#FEF3F2] hover:text-[#B42318] group relative"
        >
          <span className="group-hover:hidden">{initials(user)}</span>
          <LogOut size={16} className="hidden group-hover:block" aria-hidden />
        </button>
      </div>
    </aside>
  );
}