import superpipe, { type PipelineAPI } from 'superpipe';
import type { ProcessLister } from '../process-watchdog.ts';
import type { ClaudeLiveSession } from './claude-desktop-adapter.ts';

function receiverPid(sessionId: string, live: readonly ClaudeLiveSession[]): number | null {
  const matches = live.filter((session) => session.sessionId === sessionId);
  return matches.length === 1 && matches[0].owner === 'desktop' ? (matches[0].pid ?? null) : null;
}

async function receiverCommand(pid: number | null, processes: ProcessLister): Promise<string> {
  if (!pid) return '';
  return (await processes().catch(() => [])).find((process) => process.pid === pid)?.command ?? '';
}

function commandMode(command: string): string | null {
  const args = command.split(' -- ')[0];
  const mode =
    /(?:^|\s)--permission-mode(?:=|\s+)(bypassPermissions|auto|default|acceptEdits|plan|dontAsk)(?=\s|$)/.exec(
      args
    )?.[1];
  return (
    mode ??
    (/(?:^|\s)--dangerously-skip-permissions(?=\s|$)/.test(args) ? 'bypassPermissions' : null)
  );
}

export const readClaudeReceiverMode = (superpipe({})('read-claude-receiver-mode') as PipelineAPI)
  .input(['sessionId', 'liveSessions', 'processes'])
  .pipe(
    (read: () => Promise<readonly ClaudeLiveSession[]>) => read().catch(() => []),
    'liveSessions',
    'live'
  )
  .pipe(receiverPid, ['sessionId', 'live'], 'pid')
  .pipe(receiverCommand, ['pid', 'processes'], 'command')
  .pipe(commandMode, 'command', 'mode')
  .endAsync('mode') as (
  sessionId: string,
  liveSessions: () => Promise<readonly ClaudeLiveSession[]>,
  processes: ProcessLister
) => Promise<string | null>;
