import { Logger } from '../logger.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { type CodexDesktopIpc, withCodexDesktopIpc } from './codex-desktop-ipc.ts';
import type { Rejected, Result, WorkDelivery } from './types.ts';
import { reject } from './work-operations.ts';
import { workerSandboxOn } from './worker-sandbox.ts';

const log = new Logger('codex-send');

const TIMEOUT_MS = 30_000;

export type CodexSendGate<Value> = { value: Value } | { reason: Result<WorkDelivery> };

async function codexDesktopRunning(spawn: SpawnFn, platform = process.platform): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = spawn(['ps', '-axo', 'comm='], { stdout: 'pipe', stderr: 'ignore' });
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
  } catch (error) {
    if (platform !== 'darwin') return false;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function discoverCodexDesktopOwner({ call }: CodexDesktopIpc, threadId: string) {
  return call(
    'thread-owner-discovery',
    { hostId: 'local', conversationId: threadId },
    1,
    undefined,
    1_000
  ).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message === 'Codex Desktop thread-owner-discovery timed out.'
    )
      return undefined;
    throw error;
  });
}

async function openCodexDesktopOwner(
  { call }: CodexDesktopIpc,
  spawn: SpawnFn,
  threadId: string,
  deadline = Date.now() + TIMEOUT_MS
): Promise<string> {
  if (Date.now() >= deadline) throw new Error('Codex Desktop open timed out.');
  const launcher = spawn(['open', '-g', `codex://threads/${threadId}`], {
    stdout: 'ignore',
    stderr: 'pipe',
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, stderr] = await Promise.race([
      Promise.all([launcher.exited, new Response(launcher.stderr).text()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            launcher.kill();
            reject(new Error('Codex Desktop open timed out.'));
          },
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(stderr.trim() || 'Could not open the thread in Codex Desktop.');
    do {
      const discovered = await discoverCodexDesktopOwner({ call }, threadId);
      if (discovered?.resultType === 'success' && discovered.handledByClientId)
        return discovered.handledByClientId;
      if (
        discovered &&
        discovered.resultType !== 'success' &&
        discovered.error !== 'no-client-found'
      )
        throw new Error(discovered.error ?? 'Codex Desktop ownership discovery failed.');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now())))
      );
    } while (Date.now() < deadline);
    throw new Error('Codex Desktop did not take ownership of the thread in time.');
  } finally {
    clearTimeout(timer);
  }
}

function uncertainDesktopInput(messageId: string, detail: string): Rejected {
  return { ...reject('not_delivered', detail), uncertainDesktopInputId: messageId };
}

const desktopSends = new Map<string, Promise<void>>();

export async function steerCodexDesktopTurn(
  ...args: Parameters<typeof sendDesktopTurn>
): Promise<CodexSendGate<'app-server'>> {
  const key = JSON.stringify([args[0], args[2]]);
  const deadline = args[8] ?? Date.now() + TIMEOUT_MS;
  args[8] = deadline;
  const previous = desktopSends.get(key) ?? Promise.resolve();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => held);
  desktopSends.set(key, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
      }),
    ]);
    if (!acquired)
      return {
        reason: reject(
          'busy',
          'Another Desktop handoff is still pending. No input was dispatched; inspect work.status before retrying.',
          true
        ),
      };
    return await sendDesktopTurn(...args);
  } finally {
    clearTimeout(timer);
    release();
    void tail.then(() => {
      if (desktopSends.get(key) === tail) desktopSends.delete(key);
    });
  }
}

async function sendDesktopTurn(
  socketPath: string | undefined,
  spawn: SpawnFn,
  threadId: string,
  text: string,
  messageId: string,
  mode: 'auto' | 'steer' | 'queue' = 'auto',
  desktopRunning = () => codexDesktopRunning(spawn, probePlatform),
  probePlatform = process.platform,
  deadline = Date.now() + TIMEOUT_MS
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
    return { reason: reject('not_delivered', String(error), true) };
  }
  if (mode === 'queue') {
    let owned = false;
    if (socketPath) {
      try {
        owned = await withCodexDesktopIpc(
          socketPath,
          async ({ call }) => {
            const discovered = await discoverCodexDesktopOwner({ call }, threadId);
            if (discovered?.resultType === 'success' && discovered.handledByClientId) return true;
            if (
              discovered &&
              discovered.resultType !== 'success' &&
              discovered.error !== 'no-client-found'
            )
              throw new Error(discovered.error ?? 'Codex Desktop ownership discovery failed.');
            return false;
          },
          deadline
        );
      } catch (error) {
        log.warn('work.send route', {
          threadId,
          messageId,
          path: 'app-server',
          reason: 'desktop_owner_unknown',
          detail: String(error),
        });
        owned = false;
      }
    }
    if (!owned) {
      log.warn('work.send route', {
        threadId,
        messageId,
        path: 'app-server',
        reason: 'desktop_not_owner',
      });
      return { value: 'app-server' };
    }
    log.warn('work.send route', {
      threadId,
      messageId,
      path: 'refused',
      reason: 'desktop_owns_queue',
    });
    return {
      reason: reject(
        'busy',
        'Codex Desktop owns this thread; queued input cannot be added until the thread is released.',
        true
      ),
    };
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
        'Codex Desktop is running but its ownership endpoint is unavailable; no background writer was started.',
        true
      ),
    };
  }
  let dispatched = false;
  try {
    const admit = async ({ call }: CodexDesktopIpc): Promise<CodexSendGate<'app-server'>> => {
      let owner = await discoverCodexDesktopOwner({ call }, threadId);
      log.warn('work.send owner discovery', {
        threadId,
        messageId,
        result: owner?.resultType ?? 'pending',
        ownerClientId: owner?.handledByClientId,
        reason: owner?.error,
      });
      if (owner?.resultType !== 'success' || !owner.handledByClientId) {
        if (owner && owner.error !== 'no-client-found')
          throw new Error(owner.error ?? 'Codex Desktop did not confirm an owner.');
        owner = {
          resultType: 'success',
          handledByClientId: await openCodexDesktopOwner({ call }, spawn, threadId, deadline),
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
          return {
            reason: reject('not_delivered', response.error ?? 'Desktop refused steering.', true),
          };
        const started = await call(
          'thread-follower-start-turn',
          {
            conversationId: threadId,
            turnStart: {
              clientUserMessageId: messageId,
              request: {
                threadId,
                input: [{ type: 'text', text, text_elements: [] }],
                ...(!workerSandboxOn(true) ? { sandboxPolicy: { type: 'dangerFullAccess' } } : {}),
              },
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
              reason: uncertainDesktopInput(
                messageId,
                `Input ${messageId}: ${started.error ?? 'Desktop did not confirm starting a turn.'} Delivery is uncertain; check work.status and Desktop before retrying.`
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
            reason: uncertainDesktopInput(
              messageId,
              `Input ${messageId}: ${response.error ?? 'Desktop did not confirm steering.'} Delivery is uncertain; check work.status and Desktop before retrying.`
            ),
          };
    };
    return await withCodexDesktopIpc(socketPath, admit, deadline);
  } catch (error) {
    log.warn('work.send desktop transport failed', {
      threadId,
      messageId,
      dispatched,
      reason: String(error),
    });
    return {
      reason: dispatched
        ? uncertainDesktopInput(
            messageId,
            `Input ${messageId}: ${String(error)} The steer may have been accepted; check work.status and Desktop before retrying.`
          )
        : reject(
            'not_delivered',
            `${String(error)} No background writer was started; open the thread in Codex Desktop and retry.`,
            true
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
  const deadline = Date.now() + TIMEOUT_MS;
  return withCodexDesktopIpc(
    socketPath,
    (client) => handoff(client, spawn, threadId, request, deadline),
    deadline
  );
}

async function handoff(
  { call }: CodexDesktopIpc,
  spawn: SpawnFn,
  threadId: string,
  request: Record<string, unknown>,
  deadline: number
): Promise<void> {
  const owner = await openCodexDesktopOwner({ call }, spawn, threadId, deadline);
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
