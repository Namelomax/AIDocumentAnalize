import { useEffect, useState } from 'react';
import { ZoomIn, ZoomOut, ExternalLink } from 'lucide-react';
import StageBadge from './StageBadge';
import { approvalLabels } from '../labels';
import { apiBlob, ApiError } from '../api/client';
import type { EvidenceFragment } from '../types';

interface Props {
  fragment: EvidenceFragment;
  accent: 'expected' | 'actual';
}

const ACCENT: Record<'expected' | 'actual', string> = {
  expected: '#2E90FA',
  actual:   '#F04438'
};

export default function EvidencePanel({ fragment, accent }: Props) {
  const color = ACCENT[accent];
  const [x1, y1, x2, y2] = fragment.bbox;
  const left   = `${x1 * 100}%`;
  const top    = `${y1 * 100}%`;
  const width  = `${(x2 - x1) * 100}%`;
  const height = `${(y2 - y1) * 100}%`;

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);

  useEffect(() => {
    // A plain <img src> cannot carry the bearer token the page image route
    // requires, so the bytes come through apiBlob() and get handed to the
    // <img> as an object URL instead (Plan 7, Task 5).
    setImageSrc(null);
    setImageError(null);
    if (!fragment.imageUrl) return;

    let cancelled = false;
    let objectUrl: string | null = null;

    (async () => {
      try {
        const blob = await apiBlob(fragment.imageUrl);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageSrc(objectUrl);
      } catch (err) {
        if (!cancelled) {
          setImageError(err instanceof ApiError ? err.message : 'Не удалось загрузить изображение страницы');
        }
      }
    })();

    return () => {
      cancelled = true;
      // Sheet pages run several megabytes each at drawing resolution
      // (~4000px) — releasing the object URL on every fragment change or
      // unmount keeps an open evidence card from growing without bound.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fragment.imageUrl]);

  return (
    <div className="flex flex-col bg-white border border-[#E2E8F0] rounded-lg overflow-hidden flex-1 min-w-0">
      {/* Шапка панели */}
      <div className="px-3 py-2 border-b border-[#E2E8F0] flex items-center gap-2 text-[12px]">
        <StageBadge stage={fragment.stage} />
        <span className="mono text-[#0F172A] truncate">{fragment.documentCode}</span>
        <span className="text-[#94A3B8]">·</span>
        <span className="text-[#475569]">{fragment.revision}</span>
        <span className="text-[#94A3B8]">·</span>
        <span className="text-[#475569]">{approvalLabels[fragment.approvalStatus]}</span>
        <span className="ml-auto text-[#475569] num">Лист {fragment.sheetPage}</span>
      </div>

      {/* Область просмотра */}
      <div className="relative flex-1 bg-[#F8FAFC] min-h-[180px]">
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={`Страница ${fragment.sheetPage} документа ${fragment.documentCode}`}
            className="absolute inset-0 w-full h-full object-contain"
          />
        ) : (
          <>
            {/* Сетка-подложка, пока изображение грузится или недоступно */}
            <svg className="absolute inset-0 w-full h-full" aria-hidden>
              <defs>
                <pattern id={`grid-${fragment.stage}-${accent}`} width="24" height="24" patternUnits="userSpaceOnUse">
                  <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#E2E8F0" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill={`url(#grid-${fragment.stage}-${accent})`} />
            </svg>
            <div className="absolute top-2 left-2 text-[10px] mono text-[#94A3B8] bg-white/80 px-1.5 py-0.5 rounded">
              {imageError ? imageError : fragment.imageUrl ? 'Загрузка страницы…' : 'Нет изображения страницы'}
            </div>
          </>
        )}

        {/* Оверлей bbox в процентах */}
        <div
          className="absolute border-2 rounded-[2px] pointer-events-none"
          style={{
            left, top, width, height,
            borderColor: color,
            background: color,
            opacity: 1,
            // заливка 8% — отдельным слоем, чтобы рамка осталась 100%
            backgroundColor: 'transparent',
            boxShadow: `inset 0 0 0 1000px ${color}14`
          }}
          aria-label={`Область подсветки: ${fragment.extractedValue}`}
        />

        {/* Значение внутри оверлея — подпись */}
        <div
          className="absolute pointer-events-none text-[11px] mono px-1.5 py-0.5 rounded"
          style={{
            left, top: `calc(${top} - 20px)`,
            color: '#FFFFFF',
            background: color
          }}
        >
          {fragment.extractedValue}
        </div>

        {/* Зум-контролы */}
        <div className="absolute bottom-2 right-2 flex items-center bg-white border border-[#E2E8F0] rounded-md overflow-hidden shadow-sm">
          <button type="button" aria-label="Уменьшить"
                  className="w-7 h-7 flex items-center justify-center text-[#475569] hover:bg-[#F5F7FA]">
            <ZoomOut size={13} />
          </button>
          <span className="px-2 text-[11px] text-[#475569] num border-x border-[#E2E8F0]">100%</span>
          <button type="button" aria-label="Увеличить"
                  className="w-7 h-7 flex items-center justify-center text-[#475569] hover:bg-[#F5F7FA]">
            <ZoomIn size={13} />
          </button>
        </div>
      </div>

      {/* Подвал: SHA-256 + открыть */}
      <div className="px-3 py-2 border-t border-[#E2E8F0] flex items-center gap-3 text-[11px]">
        <span className="mono text-[#94A3B8] truncate">
          SHA-256: {fragment.sha256.slice(0, 16)}…
        </span>
        <button
          type="button"
          className="ml-auto text-[#1B4E9B] hover:underline flex items-center gap-1"
        >
          Открыть исходный файл <ExternalLink size={11} aria-hidden />
        </button>
      </div>
    </div>
  );
}
