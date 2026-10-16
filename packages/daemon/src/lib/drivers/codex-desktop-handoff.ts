import type { SpawnFn } from '../runtime-spawn/index.ts';
import { type CodexDesktopIpc, withCodexDesktopIpc } from './codex-desktop-ipc.ts';

const TIMEOUT_MS = 30_000;

export async function startCodexDesktopTurn(
  socketPath: string,
  spawn: SpawnFn,
  threadId: string,
  request: Record<string, unknown>
): Promise<void> {
  return withCodexDesktopIpc(socketPath, (client) => handoff(client, spawn, threadId, request));
}

async function handoff(
  { call }: CodexDesktopIpc,
  spawn: SpawnFn,
  threadId: string,
  request: Record<string, unknown>
): Promise<void> {
  let launcher: ReturnType<SpawnFn> | undefined;
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    launcher = spawn(['open', '-g', `codex://threads/${threadId}`], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    launchTimer = setTimeout(() => launcher?.kill(), TIMEOUT_MS);
    const [code, stderr] = await Promise.all([
      launcher.exited,
      new Response(launcher.stderr).text(),
    ]);
    clearTimeout(launchTimer);
    if (code !== 0) throw new Error(stderr.trim() || 'Could not open the thread in Codex Desktop.');
    const deadline = Date.now() + TIMEOUT_MS;
    let owner: string | undefined;
    do {
      const discovered = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      if (discovered.resultType === 'success') owner = discovered.handledByClientId;
      else if (discovered.error !== 'no-client-found')
        throw new Error(discovered.error ?? 'Codex Desktop ownership discovery failed.');
      if (!owner) await new Promise((resolve) => setTimeout(resolve, 200));
    } while (!owner && Date.now() < deadline);
    if (!owner) throw new Error('Codex Desktop did not take ownership of the new thread.');
    const started = await call(
      'thread-follower-start-turn',
      {
        conversationId: threadId,
        turnStart: { request, context: { inheritThreadSettings: false } },
      },
      2,
      owner
    );
    if (started.resultType !== 'success' || !started.result?.result?.turn?.id)
      throw new Error(started.error ?? 'Codex Desktop did not confirm the opening turn.');
  } finally {
    clearTimeout(launchTimer);
  }
}
