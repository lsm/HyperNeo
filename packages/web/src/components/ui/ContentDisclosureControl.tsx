import type { JSX } from 'preact';
import { t } from '../../lib/i18n/index.ts';

type Props = {
  expanded: boolean;
  iconOnly?: boolean;
  onToggle: () => void;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'class' | 'style'>;

export function ContentDisclosureControl({
  expanded,
  iconOnly = false,
  onToggle,
  ...attributes
}: Props) {
  const word = t(expanded ? 'chat.foldLess' : 'chat.foldMore');
  const supplied = attributes['aria-label'];
  const context = typeof supplied === 'string' ? supplied : supplied?.value;
  const name =
    context && !context.toLocaleLowerCase().includes(word.toLocaleLowerCase())
      ? `${word} — ${context}`
      : context;
  return (
    <button
      {...attributes}
      type="button"
      aria-label={name}
      aria-expanded={expanded}
      onClick={onToggle}
      style={
        iconOnly
          ? undefined
          : { float: 'right', marginInlineStart: '0.75rem', whiteSpace: 'nowrap' }
      }
      class={
        iconOnly
          ? 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-xs text-fg-faint hover:text-fg-muted focus-visible:outline-accent'
          : 'inline-flex items-baseline gap-1 text-xs text-accent hover:underline focus-visible:outline-accent'
      }
    >
      <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      <span class={iconOnly ? 'sr-only' : undefined}>{word}</span>
    </button>
  );
}
