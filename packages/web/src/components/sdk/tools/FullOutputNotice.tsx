import { useState } from 'preact/hooks';
import { toast } from '../../../lib/toast.ts';
import {
  cappedOutputChars,
  formatChars,
  type FullToolOutput,
  loadFullToolOutput,
} from './full-tool-output.ts';

export interface CappedOutput {
  chars: number;
  loading: boolean;
  onShowFull: () => void;
}

export function useFullToolOutput(
  output: unknown,
  structuredOutput: unknown,
  sessionId: string | undefined,
  messageUuid: string | undefined,
  toolId: string
): FullToolOutput & { capped?: CappedOutput } {
  const [full, setFull] = useState<FullToolOutput | null>(null);
  const [loading, setLoading] = useState(false);
  if (full) return full;
  const chars = cappedOutputChars(output) ?? cappedOutputChars(structuredOutput);
  const onShowFull = async () => {
    if (!sessionId || !messageUuid) return;
    setLoading(true);
    try {
      setFull(await loadFullToolOutput(sessionId, messageUuid, toolId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load the full output');
    } finally {
      setLoading(false);
    }
  };
  return {
    output,
    structuredOutput,
    capped: chars !== null && sessionId && messageUuid ? { chars, loading, onShowFull } : undefined,
  };
}

export function FullOutputNotice({ capped }: { capped?: CappedOutput }) {
  if (!capped) return null;
  return (
    <div class="flex items-center gap-2 text-xs text-fg-muted">
      <span>Showing the first 16 KB of {formatChars(capped.chars)}.</span>
      <button
        type="button"
        onClick={capped.onShowFull}
        disabled={capped.loading}
        class="font-medium text-accent hover:underline disabled:opacity-50"
      >
        {capped.loading ? 'Loading…' : 'Show full output'}
      </button>
    </div>
  );
}
