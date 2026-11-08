import { formControlClass } from '../ui/FormField.tsx';

export const lastGroupOf = (value: string | undefined): string | null => {
  const group = value?.trim().toLowerCase() ?? '';
  return /^[0-9a-f]{4}$/.test(group) ? group : null;
};

export function FingerprintCheck({
  label,
  groups,
  value,
  onInput,
  onSubmit,
}: {
  label: string;
  groups: string[];
  value: string;
  onInput: (value: string) => void;
  onSubmit: (lastGroup: string) => void;
}) {
  return (
    <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
      <span class="font-mono">{groups.join(' ')}</span>
      <span class="w-20 shrink-0">
        <input
          class={`${formControlClass()} font-mono`}
          aria-label={`Last group for ${label}`}
          placeholder="????"
          maxLength={6}
          autocomplete="off"
          spellcheck={false}
          value={value}
          onInput={(event) => onInput(event.currentTarget.value)}
          onKeyDown={(event) => {
            const lastGroup = lastGroupOf(event.currentTarget.value);
            if (event.key === 'Enter' && lastGroup) onSubmit(lastGroup);
          }}
        />
      </span>
      <span>A wrong group denies the code.</span>
    </div>
  );
}
