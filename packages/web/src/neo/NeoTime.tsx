import { useEffect, useRef } from 'preact/hooks';
import { locale, t, type MessageKey } from '../lib/i18n/index.ts';
import { neoNow, neoRelativeTime } from './neo-time.ts';

export function NeoTime({
  at,
  label = 'time.created',
  settledAt,
}: {
  at?: number | null;
  label?: MessageKey;
  settledAt?: number | null;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const value = neoRelativeTime(at, neoNow.value, locale.value);
  const settled = neoRelativeTime(settledAt, neoNow.value, locale.value);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && ref.current?.open) {
        ref.current.open = false;
        ref.current.querySelector('summary')?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  if (!value) return null;
  return (
    <details ref={ref} class="neo-time">
      <summary aria-label={`${t(label)} · ${value.full}`}>
        <time dateTime={value.iso}>{value.label}</time>
      </summary>
      <span class="neo-time-popover">
        <span>
          {t(label)} · {value.full}
        </span>
        {settled && (
          <span>
            {t('time.settled')} · {settled.full}
          </span>
        )}
      </span>
    </details>
  );
}
