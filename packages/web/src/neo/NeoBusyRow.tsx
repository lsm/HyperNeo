import type { AgentProcessingState } from '@hyperneo/shared';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';

export function neoWaitingLine(state: AgentProcessingState): string | null {
  if (state.status !== 'processing' || !state.waiting) return null;
  return t(state.waiting === 'model' ? 'session.waitingModel' : 'session.waitingReconnect');
}

export function NeoBusyRow({ words }: { words: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (words.length < 2) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setIndex((previous) => previous + 1);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [words]);
  return (
    <div class="neo-progress-slot">
      {words.length > 0 && (
        <div role="status" class="neo-progress" aria-live="off" aria-label={words[0]}>
          <span class="neo-progress-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span class="min-w-0">{words[index % words.length]}</span>
        </div>
      )}
    </div>
  );
}
