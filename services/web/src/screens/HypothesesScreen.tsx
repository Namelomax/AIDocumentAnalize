import { ArrowLeft } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import Button from '../components/Button';
import EmptyState from '../components/EmptyState';

interface Props {
  onBack: () => void;
  onPromote: (findingId: string) => void;
}

// The free-search hypothesis module (section 9.4/9.5 territory) is not wired
// up yet — no endpoint exists to list hypotheses, and none of this screen's
// former mock cards were ever real findings. Showing them as if they were
// would misrepresent what the system actually found (Plan 7, Task 5, Global
// Constraints: "гипотезы появятся после его запуска", not before).
export default function HypothesesScreen({ onBack, onPromote: _onPromote }: Props) {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-[#F5F7FA]">
      <PageHeader
        crumbs={['Объекты', 'Гипотезы']}
        title="Гипотезы свободного поиска"
        actions={
          <Button variant="ghost" icon={<ArrowLeft size={14} />} onClick={onBack}>
            Назад к протоколу
          </Button>
        }
      />

      <div className="flex-1 overflow-auto px-8 py-5">
        <div className="bg-white border border-[#E2E8F0] rounded-lg">
          <EmptyState
            kind="custom"
            title="Модуль свободного поиска гипотез ещё не подключён"
            description="Гипотезы появятся после его запуска. Раздел «Гипотезы свободного поиска» протокола пуст, пока модуль не работает — это не значит, что расхождений нет."
            action={<Button variant="secondary" onClick={onBack}>Вернуться к протоколу</Button>}
          />
        </div>
      </div>
    </div>
  );
}
