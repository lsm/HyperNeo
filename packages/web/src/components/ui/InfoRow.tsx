import { CopyButton } from './CopyButton.tsx';

interface InfoRowProps {
  label: string;
  value: string | undefined;
  copyLabel?: string;
}

export function InfoRow({ label, value, copyLabel }: InfoRowProps) {
  if (!value) return null;

  return (
    <div class="flex items-start gap-3 py-2 border-b border-line last:border-b-0">
      <span class="text-fg-muted text-sm w-32 flex-shrink-0">{label}</span>
      <span class="flex-1 font-mono text-sm text-fg-soft break-all">{value}</span>
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
      <h3 class="text-xs font-semibold text-fg-faint uppercase tracking-wide mb-2">{title}</h3>
      <div class="space-y-1">{children}</div>
    </div>
  );
}
