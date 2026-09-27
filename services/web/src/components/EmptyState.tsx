import type { ReactNode } from 'react';
import { Inbox, SearchX, ListChecks, FolderOpen, FileWarning, PartyPopper } from 'lucide-react';

export type EmptyKind =
  | 'no-objects'
  | 'no-filter-results'
  | 'no-candidates'
  | 'no-evidence'
  | 'all-processed'
  | 'custom';

interface Props {
  kind?: EmptyKind;
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}

const PRESETS: Record<EmptyKind, {
  icon: ReactNode;
  title: string;
  description: string;
}> = {
  'no-objects': {
    icon: <FolderOpen size={22} aria-hidden />,
    title: 'Ещё нет ни одного объекта',
    description: 'Загрузите комплект проектной, рабочей или исполнительной документации, чтобы начать проверку.'
  },
  'no-filter-results': {
    icon: <SearchX size={22} aria-hidden />,
    title: 'Ничего не найдено',
    description: 'По выбранным фильтрам нет результатов. Измените условия поиска или сбросьте фильтры.'
  },
  'no-candidates': {
    icon: <ListChecks size={22} aria-hidden />,
    title: 'Нет кандидатов в этой категории',
    description: 'В этой вкладке протокола нет записей. Возможно, проверка ещё не завершена или категория пуста.'
  },
  'no-evidence': {
    icon: <FileWarning size={22} aria-hidden />,
    title: 'Доказательства отсутствуют',
    description: 'Источник по одной из стадий документации не загружен. Дозагрузите документ для продолжения проверки.'
  },
  'all-processed': {
    icon: <PartyPopper size={22} aria-hidden />,
    title: 'Все кандидаты обработаны',
    description: 'Решения по всем кандидатам приняты. Переходите к финализации протокола.'
  },
  'custom': {
    icon: <Inbox size={22} aria-hidden />,
    title: 'Пусто',
    description: ''
  }
};

export default function EmptyState({
  kind = 'custom',
  title,
  description,
  icon,
  action,
  compact = false
}: Props) {
  const preset = PRESETS[kind];
  const finalIcon = icon ?? preset.icon;
  const finalTitle = title ?? preset.title;
  const finalDescription = description ?? preset.description;

  return (
    <div
      className={[
        'flex flex-col items-center justify-center text-center',
        compact ? 'py-8 px-6' : 'py-16 px-8'
      ].join(' ')}
    >
      <div className={[
        'rounded-full bg-[#EDF1F7] text-[#475569] flex items-center justify-center mb-4',
        compact ? 'w-12 h-12' : 'w-14 h-14'
      ].join(' ')}>
        {finalIcon}
      </div>
      <h3 className={[
        'font-semibold text-[#0F172A] mb-1.5',
        compact ? 'text-[14px]' : 'text-[16px]'
      ].join(' ')}>
        {finalTitle}
      </h3>
      {finalDescription && (
        <p className="text-[13px] text-[#475569] leading-5 max-w-[420px] mb-4">
          {finalDescription}
        </p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}