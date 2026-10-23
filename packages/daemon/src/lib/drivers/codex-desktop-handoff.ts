import { Logger } from '../logger.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import { type CodexDesktopIpc, withCodexDesktopIpc } from './codex-desktop-ipc.ts';
import type { Result, WorkDelivery } from './types.ts';
import { reject } from './work-operations.ts';

const log = new Logger('codex-send');

const TIMEOUT_MS = 30_000;

export type CodexSendGate<Value> = { value: Value } | { reason: Result<WorkDelivery> };

export async function steerCodexDesktopTurn(
  socketPath: string | undefined,
  spawn: SpawnFn,
  threadId: string,
  text: string,
  messageId: string,
  mode: 'auto' | 'steer' = 'auto'
): Promise<CodexSendGate<'app-server'>> {
  if (!socketPath) {
    log.warn('work.send route', {
      threadId,
      messageId,
      path: 'app-server',
      reason: 'no_desktop_socket',
    });
    return { value: 'app-server' };
  }
  let dispatched = false;
  let desktopConnected = false;
  try {
    return await withCodexDesktopIpc(socketPath, async ({ call }) => {
      desktopConnected = true;
      const discovered = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      log.warn('work.send owner discovery', {
        threadId,
        messageId,
        result: discovered.resultType,
        ownerClientId: discovered.handledByClientId,
        reason: discovered.error,
      });
      const owner =
        discovered.resultType === 'success' && discovered.handledByClientId
          ? discovered.handledByClientId
          : discovered.error === 'no-client-found'
            ? await openCodexDesktopThread({ call }, spawn, threadId)
            : undefined;
      if (!owner)
        return {
          reason: reject(
            'not_delivered',
            `${discovered.error ?? 'Codex Desktop did not confirm thread ownership.'} Open the thread in Codex Desktop before sending input.`
          ),
        };
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
        owner
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
          owner
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
    if (
      !desktopConnected &&
      ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return { value: 'app-server' };
    return {
      reason: reject(
        'not_delivered',
        dispatched
          ? `${String(error)} The steer may have been accepted; check work.status before retrying.`
          : String(error)
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
  return withCodexDesktopIpc(socketPath, async (client) => {
    const owner = await openCodexDesktopThread(client, spawn, threadId);
    const started = await client.call(
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
  });
}

async function openCodexDesktopThread(
  { call }: CodexDesktopIpc,
  spawn: SpawnFn,
  threadId: string
): Promise<string> {
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
    return owner;
  } finally {
    clearTimeout(launchTimer);
  }
}
