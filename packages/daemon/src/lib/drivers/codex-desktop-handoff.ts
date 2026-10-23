import { Logger } from '../logger.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { type CodexDesktopIpc, withCodexDesktopIpc } from './codex-desktop-ipc.ts';
import type { Result, WorkDelivery } from './types.ts';
import { reject } from './work-operations.ts';

const log = new Logger('codex-send');

const TIMEOUT_MS = 30_000;

export type CodexSendGate<Value> = { value: Value } | { reason: Result<WorkDelivery> };

async function codexDesktopRunning(spawn: SpawnFn): Promise<boolean> {
  const probe = spawn(['ps', '-axo', 'comm='], { stdout: 'pipe', stderr: 'ignore' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, processes] = await Promise.race([
      Promise.all([probe.exited, new Response(probe.stdout).text()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          probe.kill();
          reject(new Error('Could not determine whether Codex Desktop is running.'));
        }, 5_000);
      }),
    ]);
    if (code !== 0) throw new Error('Could not determine whether Codex Desktop is running.');
    return processes
      .split('\n')
      .some((path) =>
        /\/(Codex|ChatGPT)\.app\/Contents\/MacOS\/(Codex|ChatGPT)$/.test(path.trim())
      );
  } finally {
    clearTimeout(timer);
  }
}

async function openCodexDesktopOwner(
  { call }: CodexDesktopIpc,
  spawn: SpawnFn,
  threadId: string
): Promise<string> {
  const launcher = spawn(['open', '-g', `codex://threads/${threadId}`], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  const deadline = Date.now() + TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, stderr] = await Promise.race([
      Promise.all([launcher.exited, new Response(launcher.stderr).text()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          launcher.kill();
          reject(new Error('Codex Desktop open timed out.'));
        }, TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(stderr.trim() || 'Could not open the thread in Codex Desktop.');
    do {
      const discovered = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      if (discovered.resultType === 'success' && discovered.handledByClientId)
        return discovered.handledByClientId;
      if (discovered.resultType !== 'success' && discovered.error !== 'no-client-found')
        throw new Error(discovered.error ?? 'Codex Desktop ownership discovery failed.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw new Error('Codex Desktop did not take ownership of the thread in time.');
  } finally {
    clearTimeout(timer);
  }
}

export async function steerCodexDesktopTurn(
  socketPath: string | undefined,
  spawn: SpawnFn,
  threadId: string,
  text: string,
  messageId: string,
  mode: 'auto' | 'steer' = 'auto',
  desktopRunning = () => codexDesktopRunning(spawn)
): Promise<CodexSendGate<'app-server'>> {
  try {
    if (!(await desktopRunning())) {
      log.warn('work.send route', {
        threadId,
        messageId,
        path: 'app-server',
        reason: 'desktop_not_running',
      });
      return { value: 'app-server' };
    }
  } catch (error) {
    log.warn('work.send route', {
      threadId,
      messageId,
      path: 'refused',
      reason: 'desktop_running_probe_failed',
      detail: String(error),
    });
    return { reason: reject('not_delivered', String(error)) };
  }
  if (!socketPath) {
    log.warn('work.send route', {
      threadId,
      messageId,
      path: 'refused',
      reason: 'desktop_socket_missing',
    });
    return {
      reason: reject(
        'not_delivered',
        'Codex Desktop is running but its ownership endpoint is unavailable; no background writer was started.'
      ),
    };
  }
  let dispatched = false;
  try {
    return await withCodexDesktopIpc(socketPath, async ({ call }) => {
      let owner = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      log.warn('work.send owner discovery', {
        threadId,
        messageId,
        result: owner.resultType,
        ownerClientId: owner.handledByClientId,
        reason: owner.error,
      });
      if (owner.resultType !== 'success' || !owner.handledByClientId) {
        if (owner.error !== 'no-client-found')
          throw new Error(owner.error ?? 'Codex Desktop did not confirm an owner.');
        owner = {
          resultType: 'success',
          handledByClientId: await openCodexDesktopOwner({ call }, spawn, threadId),
        };
      }
      log.warn('work.send route', { threadId, messageId, path: 'desktop-steer' });
      dispatched = true;
      const response = await call(
        'thread-follower-steer-turn',
        {
          conversationId: threadId,
          clientUserMessageId: messageId,
          input: [{ type: 'text', text, text_elements: [] }],
          restoreMessage: {
            id: messageId,
            text,
            context: { workspaceRoots: [], commentAttachments: [] },
            responsesapiClientMetadata: {},
          },
        },
        1,
        owner.handledByClientId
      );
      if (
        response.resultType === 'error' &&
        /no-client-found|active turn already ended|NoActiveTurn|activeTurnNotSteerable/.test(
          response.error ?? ''
        )
      ) {
        if (mode === 'steer')
          return { reason: reject('not_delivered', response.error ?? 'Desktop refused steering.') };
        const started = await call(
          'thread-follower-start-turn',
          {
            conversationId: threadId,
            turnStart: {
              request: { threadId, input: [{ type: 'text', text, text_elements: [] }] },
              context: { inheritThreadSettings: true },
            },
          },
          2,
          owner.handledByClientId
        );
        const startedTurnId = started.result?.result?.turn?.id;
        return started.resultType === 'success' && startedTurnId
          ? { reason: { ok: true, value: { delivered: true, startedTurnId } } }
          : {
              reason: reject(
                'not_delivered',
                started.error ?? 'Desktop did not confirm starting a turn.'
              ),
            };
      }
      const turnId = response.result?.result?.turnId;
      log.warn('work.send desktop result', {
        threadId,
        messageId,
        result: response.resultType,
        turnId,
        reason: response.error,
      });
      return response.resultType === 'success' && turnId
        ? { reason: { ok: true, value: { delivered: true, steeredIntoTurnId: turnId } } }
        : {
            reason: reject(
              'not_delivered',
              response.error ??
                'Desktop did not confirm steering; the message may have been accepted. Check work.status before retrying.'
            ),
          };
    });
  } catch (error) {
    log.warn('work.send desktop transport failed', {
      threadId,
      messageId,
      dispatched,
      reason: String(error),
    });
    return {
      reason: reject(
        'not_delivered',
        dispatched
          ? `${String(error)} The steer may have been accepted; check work.status before retrying.`
          : `${String(error)} No background writer was started; open the thread in Codex Desktop and retry.`
      ),
    };
  }
}

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
  const owner = await openCodexDesktopOwner({ call }, spawn, threadId);
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
}
