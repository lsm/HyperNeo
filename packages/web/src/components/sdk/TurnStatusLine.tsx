import { useEffect, useState } from 'preact/hooks';
import type { ChatTurn } from '../../lib/chat-turns.ts';
import { cn } from '../../lib/utils.ts';
import { Spinner } from '../ui/Spinner.tsx';

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function TurnStatusLine({
  turn,
  currentAction,
  expanded,
  onToggle,
}: {
  turn: ChatTurn;
  currentAction?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const running = turn.outcome === 'running';
  const now = useNow(running);
  if (turn.outcome === 'done' && turn.toolCount === 0 && turn.errorCount === 0) return null;
  const counts = [
    turn.toolCount > 0 ? plural(turn.toolCount, 'tool call') : null,
    turn.errorCount > 0 ? `${turn.errorCount} failed` : null,
  ].filter(Boolean);
  const elapsed = running && turn.startedAt !== null ? formatDuration(now - turn.startedAt) : null;
  const summary = running
    ? ['Working', currentAction?.replace(/\.\.\.$/, ''), elapsed].filter(Boolean).join(' · ')
    : [
        turn.outcome === 'failed'
          ? 'Failed'
          : turn.outcome === 'stopped'
            ? 'Stopped'
            : turn.durationMs !== null
              ? `Worked for ${formatDuration(turn.durationMs)}`
              : 'Done',
        ...counts,
      ].join(' · ');
  return (
    <div
      class={cn(
        'flex items-center gap-2 py-1.5 text-xs',
        turn.outcome === 'failed' ? 'text-danger' : 'text-fg-muted'
      )}
      data-testid="turn-status-line"
    >
      {running && <Spinner size="xs" />}
      <span class="truncate">{summary}</span>
      {!running && turn.toolCount + turn.errorCount > 0 && (
        <button type="button" class="text-fg-faint hover:text-fg underline" onClick={onToggle}>
          {expanded ? 'Hide steps' : 'Show steps'}
        </button>
      )}
    </div>
  );
}
