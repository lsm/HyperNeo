import type { Ref } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function TaskRunComposer({
  taskId,
  label,
  busy,
  errorMessage,
  onComposerRef,
  onRun,
}: {
  taskId: string;
  label: string;
  busy: boolean;
  errorMessage?: string | null;
  onComposerRef?: Ref<HTMLDivElement>;
  onRun: (note: string | null) => Promise<boolean>;
}) {
  const [note, setNote] = useState('');

  useEffect(() => setNote(''), [taskId]);

  const run = async () => {
    if (busy) return;
    if (await onRun(note.trim() || null)) setNote('');
  };

  return (
    <div
      ref={onComposerRef}
      class="relative z-10 flex-shrink-0 border-t border-line bg-surface px-4 py-3"
      data-testid="task-run-composer"
    >
      {errorMessage && (
        <p class="mb-2 text-xs text-danger-soft" role="alert">
          {errorMessage}
        </p>
      )}
      <div class="flex items-end gap-2 rounded-xl border border-line-strong bg-surface-overlay px-3 py-2">
        <textarea
          value={note}
          rows={2}
          maxLength={4000}
          placeholder="Add a note for the agent (optional)"
          class="min-h-[2.5rem] flex-1 resize-none bg-transparent text-sm text-fg placeholder:text-fg-muted focus:outline-none"
          onInput={(event) => setNote((event.target as HTMLTextAreaElement).value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void run();
            }
          }}
          data-testid="task-run-note"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void run()}
          class="h-8 rounded-lg bg-accent px-3.5 text-sm font-semibold text-accent-fg disabled:opacity-50"
          data-testid="task-run-composer-button"
        >
          {label}
        </button>
      </div>
    </div>
  );
}
