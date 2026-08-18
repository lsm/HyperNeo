import { CopyButton } from './CopyButton.tsx';
import { borderColors } from '../../lib/design-tokens.ts';

interface InfoRowProps {
  label: string;
  value: string | undefined;
  copyLabel?: string;
}

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

export function InfoSection({ title, children }: InfoSectionProps) {
  return (
    <div class="mb-4">
      <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">{title}</h3>
      <div class="space-y-1">{children}</div>
    </div>
  );
}
