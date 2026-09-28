import { useEffect, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, ExternalLink } from 'lucide-react';
import StageBadge from './StageBadge';
import { approvalLabels } from '../labels';
import { apiBlob, ApiError } from '../api/client';
import type { EvidenceFragment } from '../types';
import { bboxToRect, fitContain } from './evidenceGeometry';

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
  const { left, top, width, height } = bboxToRect(fragment.bbox);

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  // The rendered image's own pixel size, learned from onLoad.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  // The viewing area's own pixel size. A wrapper sized purely in CSS
  // (aspect-ratio + max-width/max-height, no explicit width/height)
  // collapses to 0x0 the moment none of its children contribute an
  // intrinsic size — every child here (the image is absolutely positioned,
  // as are the bbox overlay and the value label) does exactly that. Tracking
  // the panel's pixel size and computing the wrapper's size with it
  // (fitContain) keeps the wrapper — and the image inside it — non-zero.
  const [panelSize, setPanelSize] = useState<{ width: number; height: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = panelRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setPanelSize({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const wrapperSize = naturalSize && panelSize ? fitContain(panelSize, naturalSize) : null;

  useEffect(() => {
    // A plain <img src> cannot carry the bearer token the page image route
    // requires, so the bytes come through apiBlob() and get handed to the
    // <img> as an object URL instead (Plan 7, Task 5).
    setImageSrc(null);
    setImageError(null);
    setNaturalSize(null);
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
      <div
        ref={panelRef}
        className="relative flex-1 bg-[#F8FAFC] min-h-[180px] flex items-center justify-center overflow-hidden"
      >
        {imageSrc ? (
          // The wrapper gets the exact pixel box `object-fit: contain` would
          // give the image (fitContain, from the panel's and the image's own
          // pixel sizes) — a real element the bbox overlay and the value
          // label can share, positioned by the flex parent's centering.
          // Until both sizes are known (onLoad hasn't fired yet, or the
          // ResizeObserver hasn't reported the panel's size yet), it falls
          // back to filling the panel outright, same as the placeholder grid
          // shown below in that same instant.
          <div
            className="relative"
            style={
              wrapperSize
                ? { width: `${wrapperSize.width}px`, height: `${wrapperSize.height}px` }
                : { position: 'absolute' as const, inset: 0 }
            }
          >
            <img
              src={imageSrc}
              alt={`Страница ${fragment.sheetPage} документа ${fragment.documentCode}`}
              className="absolute inset-0 w-full h-full object-contain"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                setNaturalSize({ width: naturalWidth, height: naturalHeight });
              }}
            />

            {/* Оверлей bbox в процентах — относительно изображения, не панели */}
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
          </div>
        ) : (
          <div className="absolute inset-0">
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
          </div>
        )}

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
