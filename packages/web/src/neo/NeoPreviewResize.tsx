import { useRef } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';

export function NeoPreviewResize({
  value,
  min,
  max,
  controls,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  controls: string;
  onChange: (value: number) => void;
}) {
  const drag = useRef<{ id: number; start: number; x: number; shell: HTMLElement } | null>(null);
  const change = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  const finish = (handle: HTMLElement) => {
    const current = drag.current;
    drag.current = null;
    if (current && handle.hasPointerCapture(current.id)) handle.releasePointerCapture(current.id);
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={t('artifact.resize')}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={t('artifact.width', { width: Math.round(value) })}
      class="neo-preview-resizer"
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return;
        const handle = event.currentTarget;
        const shell = handle.closest<HTMLElement>('.neo-shell');
        if (!shell) return;
        event.preventDefault();
        handle.focus({ preventScroll: true });
        handle.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, start: value, x: event.clientX, shell };
      }}
      onPointerMove={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        const rect = drag.current.shell.getBoundingClientRect();
        if (rect.width > 0)
          change(drag.current.start + ((drag.current.x - event.clientX) / rect.width) * 100);
      }}
      onPointerUp={(event) => {
        if (drag.current?.id === event.pointerId) finish(event.currentTarget);
      }}
      onPointerCancel={(event) => {
        if (drag.current?.id !== event.pointerId) return;
        change(drag.current.start);
        finish(event.currentTarget);
      }}
      onLostPointerCapture={(event) => {
        if (drag.current?.id === event.pointerId) drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Escape' && drag.current) {
          event.preventDefault();
          change(drag.current.start);
          finish(event.currentTarget);
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          change(
            event.key === 'Home'
              ? min
              : event.key === 'End'
                ? max
                : value + (event.key === 'ArrowLeft' ? 2 : -2)
          );
        }
      }}
    />
  );
}
