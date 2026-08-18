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

export type MinimalTurn = CompletedTurn | ActiveTurn;

const T_BASE = new Date('2026-04-25T21:42:00').getTime();

export const MOCK_TURNS: MinimalTurn[] = [
  {
    state: 'completed',
    id: 'turn-coder-1',
    agent: 'coder agent',
    startedAt: T_BASE,
    durationSec: 2841,
    stats: {
      toolCalls: 47,
      messages: 8,
      userInputs: 2,
      tokens: 128_432,
      costUsd: 4.2,
    },
    lastMessage:
      'PR #1631 is clean and mergeable. All CI checks pass (**Lint**, **Type Check**, **Web**, **Daemon**). Sending handoff to Reviewer.\n\nChanges:\n- `packages/web/src/components/space/thread/SpaceTaskThread.tsx` — refactored turn rendering\n- `packages/web/vite.config.ts` — added new dev entry point\n\nRun `bunx vite build` to verify.',
  },
  {
    state: 'completed',
    id: 'turn-reviewer-1',
    agent: 'reviewer agent',
    startedAt: T_BASE + 2841 * 1000 + 5_000,
    durationSec: 14,
    stats: {
      toolCalls: 6,
      messages: 3,
      userInputs: 1,
      tokens: 621,
      costUsd: 0.09,
    },
    lastMessage:
      'PR #1631 merged ✅ and root repo synced. Squash commit `abc1234` is now on `dev`.\n\nApproved via `gh pr review --approve`.',
  },
  {
    state: 'active',
    id: 'turn-coder-2',
    agent: 'coder agent',
    startedAt: T_BASE + 2841 * 1000 + 5_000 + 14_000 + 2_000,
    status: 'Running command...',
    stats: {
      toolCalls: 12,
      tokens: 34_200,
      costUsd: 1.23,
      elapsedSec: 142,
    },
    roster: [
      { tool: 'Bash', preview: 'bun run typecheck' },
      { tool: 'Read', preview: 'packages/daemon/src/lib/space/space-task-runtime.ts' },
      { tool: 'Grep', preview: 'provisionExistingSpaces' },
      { tool: 'Bash', preview: 'git status' },
    ],
  },
];

export function formatTokens(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  }
  return String(n);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
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
