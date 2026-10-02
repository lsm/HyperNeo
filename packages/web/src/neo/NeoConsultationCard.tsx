import MarkdownRenderer from '../components/chat/MarkdownRenderer.tsx';
import { Button } from '../components/ui/Button.tsx';
import { CopyButton } from '../components/ui/CopyButton.tsx';
import { NeoIcon } from './NeoIcon.tsx';
import { classifyNeoScene, type NeoScene } from './neo-scenes.ts';

type Consultation = Extract<NeoScene['receipt'], { kind: 'consultation' }>;

export function NeoConsultationCard({
  consultation,
  label,
  holderName,
  presentation = 'detail',
  onOpen,
  onOpenHolder,
  onStopWaiting,
  busy = false,
  disabled = false,
}: {
  consultation: Consultation;
  label: string;
  holderName: string;
  presentation?: 'detail' | 'summary';
  onOpen?: (id: string) => void;
  onOpenHolder?: (concernId: string) => void;
  onStopWaiting?: (id: string) => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  const truth = classifyNeoScene(consultation);
  if (presentation === 'summary' && onOpen)
    return (
      <button
        type="button"
        data-consultation-open={consultation.id}
        aria-label={`View details for ${label}`}
        onClick={() => onOpen(consultation.id)}
        class="flex min-h-11 w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 text-left hover:border-accent/40 focus-visible:outline-accent"
      >
        <span aria-hidden="true" class="shrink-0 text-fg-muted">
          <NeoIcon name="context" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block break-words text-sm font-medium">{label}</span>
          <span class="mt-1 block break-words text-xs text-fg-muted">
            {holderName} · {truth.label}
          </span>
        </span>
        <span aria-hidden="true" class="shrink-0 text-fg-faint">
          <NeoIcon name="arrow" />
        </span>
      </button>
    );
  const waiting = consultation.status === 'pending' || consultation.status === 'queued';
  return (
    <article
      aria-label={label}
      class="neo-arrive rounded-2xl border border-line bg-surface p-5 shadow-sm"
    >
      <div class="mb-3 flex items-center gap-3 text-xs text-fg-muted">
        <NeoIcon name="context" />
        <span>{truth.label}</span>
      </div>
      <h3 class="break-words text-base font-medium">
        {onOpen ? (
          <button
            type="button"
            data-consultation-open={consultation.id}
            class="text-left hover:text-accent focus-visible:outline-accent"
            onClick={() => onOpen(consultation.id)}
          >
            {label}
          </button>
        ) : (
          label
        )}
      </h3>
      <p class="mt-2 text-xs text-fg-muted">
        Context held by{' '}
        {onOpenHolder ? (
          <button
            type="button"
            class="text-accent hover:underline"
            onClick={() => onOpenHolder(consultation.concernId)}
          >
            {holderName}
          </button>
        ) : (
          holderName
        )}
      </p>
      <details class="mt-3 text-sm text-fg-muted">
        <summary class="cursor-pointer">What was asked</summary>
        <p class="mt-3 whitespace-pre-wrap break-words leading-relaxed">{consultation.question}</p>
      </details>
      {consultation.answer && (
        <details class="mt-3 text-sm">
          <summary class="cursor-pointer text-fg-muted">Read the context response</summary>
          <div class="mt-3 min-w-0 break-words">
            <MarkdownRenderer content={consultation.answer} />
            <CopyButton text={consultation.answer} label="Copy context response" />
          </div>
        </details>
      )}
      {waiting && onStopWaiting && (
        <Button
          variant="ghost"
          disabled={disabled || busy}
          class="mt-4"
          onClick={() => onStopWaiting(consultation.id)}
          title="Close this request without interrupting the holder or undoing saved context."
        >
          {busy ? 'Closing…' : 'Stop waiting'}
        </Button>
      )}
      <p class="mt-3 text-xs leading-relaxed text-fg-muted">
        {waiting
          ? 'This is a context check, not an execution worker. Stopping the wait does not interrupt the holder or undo saved context.'
          : 'A recorded response is not verified completion. The context holder does not execute work.'}
      </p>
    </article>
  );
}
