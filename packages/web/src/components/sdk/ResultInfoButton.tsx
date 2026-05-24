/**
 * ResultInfoButton Component
 *
 * Icon button that triggers the result-info dropdown shown beneath an agent's
 * end-of-turn reply. Surfaces the SDK `result` envelope (usage tokens, cost,
 * duration, num_turns, errors) — the symmetric counterpart to
 * `MessageInfoButton` for `system:init`.
 *
 * Glyph: a check-badge — a checkmark inside a small badge — to read as
 * "exec completed" rather than "info circle" (which is the init affordance).
 * For error subtypes the button is colored amber via the `isError` prop so
 * the affordance also signals failure at a glance.
 */
import { IconButton } from '../ui/IconButton.tsx';

interface Props {
  onClick?: () => void;
  title?: string;
  isError?: boolean;
}

export function ResultInfoButton({ onClick, title = 'Run result', isError = false }: Props) {
  return (
    <IconButton size="md" onClick={onClick} title={title} class={isError ? 'text-amber-400' : ''}>
      <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    </IconButton>
  );
}
