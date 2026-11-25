import { NeoIcon } from './NeoIcon.tsx';

export function NeoWorkEmpty({
  icon,
  title,
  hint,
}: {
  icon: 'clock' | 'spark' | 'work';
  title: string;
  hint: string;
}) {
  return (
    <div class="flex flex-col items-center px-6 py-14 text-center">
      <span class="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-fill-strong text-fg-muted">
        <NeoIcon name={icon} />
      </span>
      <p class="text-sm font-medium text-fg">{title}</p>
      <p class="mt-1 max-w-sm text-xs leading-relaxed text-fg-muted">{hint}</p>
    </div>
  );
}
