import type { VoiceRecordEntry } from '../../lib/voice/voice-audio-store.ts';
import { VOICE_SUBMIT_SILENCE_PEAK_LEVEL } from '../../lib/voice/voice-submit-pipeline.ts';

interface PendingVoiceAudioTrayProps {
  records: VoiceRecordEntry[];
  resendingId?: string | null;
  isBusy?: (id: string) => boolean;
  onResend: (entry: VoiceRecordEntry) => void;
  onDelete: (entry: VoiceRecordEntry) => void;
  className?: string;
}

function formatRecordedAt(createdAt: number): string {
  return new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function PendingVoiceAudioTray({
  records,
  resendingId = null,
  isBusy,
  onResend,
  onDelete,
  className = '',
}: PendingVoiceAudioTrayProps) {
  if (records.length === 0) return null;

  return (
    <div class={className} data-testid="pending-voice-audio-tray" aria-live="polite">
      <div class="overflow-hidden rounded-xl border border-dark-700/80 bg-dark-900/90 shadow-lg shadow-black/20 backdrop-blur-md">
        {records.map((entry) => {
          const resending = resendingId === entry.id;
          const busy = resendingId !== null || (isBusy?.(entry.id) ?? false);
          const silent = entry.peakLevel < VOICE_SUBMIT_SILENCE_PEAK_LEVEL;
          return (
            <div
              key={entry.id}
              class="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/[0.035]"
            >
              <span class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 text-[10px] font-medium uppercase tracking-wide text-violet-200">
                <span class="h-1.5 w-1.5 rounded-full bg-violet-300" />
                Voice
              </span>
              <p class="min-w-0 flex-1 truncate text-xs leading-5 text-gray-200">
                Unsent recording from {formatRecordedAt(entry.createdAt)}
                {silent ? ' — no signal detected' : ''}
              </p>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="flex h-8 items-center rounded-full px-2.5 text-xs text-gray-300 transition-colors hover:bg-violet-500/15 hover:text-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy}
                  title={resending ? 'Resending…' : 'Transcribe and insert this recording'}
                  aria-label="Resend voice recording"
                  data-testid="resend-voice-audio"
                  onClick={() => onResend(entry)}
                >
                  {resending ? 'Resending…' : 'Resend'}
                </button>
                <button
                  type="button"
                  class="flex h-8 items-center rounded-full px-2.5 text-xs text-gray-500 transition-colors hover:bg-red-500/15 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy}
                  title="Delete recording"
                  aria-label="Delete voice recording"
                  data-testid="delete-voice-audio"
                  onClick={() => onDelete(entry)}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
