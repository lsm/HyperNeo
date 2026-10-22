import type { JSX } from 'preact';
import { t } from '../../lib/i18n/index.ts';

type Props = {
  expanded: boolean;
  onToggle: () => void;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'class' | 'style'>;

export function ContentDisclosureControl({ expanded, onToggle, ...attributes }: Props) {
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
      style={{ float: 'right', marginInlineStart: '0.75rem', whiteSpace: 'nowrap' }}
      class="inline-flex items-baseline gap-1 text-xs text-accent hover:underline focus-visible:outline-accent"
    >
      <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      {word}
    </button>
  );
}
