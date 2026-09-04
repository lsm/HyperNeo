export interface LineNumberedTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

const MAX_GUTTER_LINES = 1000;

export function LineNumberedTextarea({
  value,
  onChange,
  placeholder,
  rows = 10,
}: LineNumberedTextareaProps) {
  const lineCount = value ? value.split('\n').length : 1;
  const displayLines = Math.min(Math.max(lineCount, rows), MAX_GUTTER_LINES);

  return (
    <div class="relative flex border border-line-strong rounded-lg overflow-hidden bg-surface-raised focus-within:border-accent transition-colors">
      <div
        aria-hidden="true"
        class="flex flex-col items-end px-2 py-2 select-none text-fg-muted text-xs font-mono bg-surface-overlay border-r border-line flex-shrink-0"
        style="min-width: 2.5rem; line-height: 1.375rem;"
      >
        {Array.from({ length: displayLines }, (_, i) => (
          <span key={i} style="height: 1.375rem; line-height: 1.375rem;">
            {i + 1}
          </span>
        ))}
      </div>
      <textarea
        value={value}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        placeholder={placeholder}
        rows={rows}
        spellcheck={false}
        wrap="off"
        class="flex-1 bg-transparent py-2 px-3 text-fg font-mono text-xs resize-none focus:outline-none overflow-x-auto"
        style="line-height: 1.375rem;"
      />
    </div>
  );
}
