import { once } from 'node:events';
import { createConnection } from 'node:net';
import type { SpawnFn } from '../runtime-spawn/index.ts';

const TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface DesktopResponse {
  type?: string;
  requestId?: string;
  resultType?: string;
  error?: string;
  handledByClientId?: string;
  result?: { clientId?: string; result?: { turn?: { id?: string } } };
}

export async function startCodexDesktopTurn(
  socketPath: string,
  spawn: SpawnFn,
  threadId: string,
  request: Record<string, unknown>
): Promise<void> {
  const socket = createConnection(socketPath);
  let buffer = Buffer.alloc(0);
  let clientId = 'initializing-client';
  let nextId = 0;
  const pending = new Map<
    string,
    { resolve: (response: DesktopResponse) => void; reject: (error: Error) => void }
  >();
  const fail = (error: Error) => {
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  const write = (message: object) => {
    const body = Buffer.from(JSON.stringify(message));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length);
    body.copy(frame, 4);
    socket.write(frame);
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME_BYTES) throw new Error('Invalid Codex Desktop IPC frame.');
        if (buffer.length < size + 4) break;
        const message = JSON.parse(buffer.subarray(4, size + 4).toString()) as DesktopResponse;
        buffer = buffer.subarray(size + 4);
        if (message.type === 'client-discovery-request') {
          write({
            type: 'client-discovery-response',
            requestId: message.requestId,
            response: { canHandle: false },
          });
        } else if (message.type === 'response' && message.requestId) {
          pending.get(message.requestId)?.resolve(message);
          pending.delete(message.requestId);
        }
      }
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  });
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('Codex Desktop closed the handoff connection.')));
  socket.setTimeout(TIMEOUT_MS, () =>
    socket.destroy(new Error('Codex Desktop handoff timed out.'))
  );
  const call = async (
    method: string,
    params: object,
    version: number,
    targetClientId?: string
  ): Promise<DesktopResponse> => {
    if (socket.destroyed) throw new Error('Codex Desktop closed the handoff connection.');
    const requestId = String(++nextId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        timer = setTimeout(
          () => reject(new Error(`Codex Desktop ${method} timed out.`)),
          TIMEOUT_MS
        );
        write({
          type: 'request',
          requestId,
          sourceClientId: clientId,
          method,
          params,
          version,
          targetClientId,
        });
      });
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  };
  let launcher: ReturnType<SpawnFn> | undefined;
  let launchTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, 'connect');
    const initialized = await call('initialize', { clientType: 'hyperneo' }, 0);
    if (initialized.resultType !== 'success' || !initialized.result?.clientId)
      throw new Error(initialized.error ?? 'Codex Desktop IPC initialization failed.');
    clientId = initialized.result.clientId;
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
    socket.destroy();
  }
}
