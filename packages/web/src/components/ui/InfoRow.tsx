import { CopyButton } from './CopyButton.tsx';
import { borderColors } from '../../lib/design-tokens.ts';

interface InfoRowProps {
  label: string;
  value: string | undefined;
  copyLabel?: string;
}

/**
 * Key/value row with an optional copy affordance. Returns `null` when there is
 * no value, so callers can declare rows unconditionally and let them drop out.
 * Shared between the merged session info panel and any future metadata surface.
 */
export function InfoRow({ label, value, copyLabel }: InfoRowProps) {
  if (!value) return null;

  return (
    <div class={`flex items-start gap-3 py-2 border-b ${borderColors.ui.default} last:border-b-0`}>
      <span class="text-gray-400 text-sm w-32 flex-shrink-0">{label}</span>
      <span class="flex-1 font-mono text-sm text-gray-200 break-all">{value}</span>
      <CopyButton text={value} label={copyLabel || `Copy ${label.toLowerCase()}`} />
    </div>
  );
}

interface InfoSectionProps {
  title: string;
  children: preact.ComponentChildren;
}

/**
 * Titled metadata section (uppercase header). Pairs with {@link InfoRow}.
 */
export function InfoSection({ title, children }: InfoSectionProps) {
  return (
    <div class="mb-4">
      <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h3>
      <div class="space-y-1">{children}</div>
    </div>
  );
}
