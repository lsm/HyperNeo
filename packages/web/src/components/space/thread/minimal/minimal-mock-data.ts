export interface CompletedTurn {
  state: 'completed';
  id: string;
  agent: string;
  startedAt: number;
  durationSec: number;
  stats: {
    toolCalls: number;
    messages: number;
    userInputs: number;
    tokens: number;
    costUsd: number;
  };
  lastMessage: string;
}

export interface ActiveTurnStats {
  toolCalls: number;
  tokens: number;
  costUsd: number;
  elapsedSec: number;
}

export interface ActiveTurn {
  state: 'active';
  id: string;
  agent: string;
  startedAt: number;
  status: string;
  stats: ActiveTurnStats;
  roster: ToolCallEntry[];
}

export interface ToolCallEntry {
  tool: string;
  preview: string;
}

export function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
}

export function shortAgentName(label: string): string {
  return label.replace(/\s+agent$/i, '').toUpperCase();
}

export function agentInitial(label: string): string {
  const short = shortAgentName(label);
  return short.charAt(0);
}
