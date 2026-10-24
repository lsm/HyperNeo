import { once } from 'node:events';
import { createConnection } from 'node:net';

const TIMEOUT_MS = 30_000;
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface DesktopResponse {
  type?: string;
  requestId?: string;
  resultType?: string;
  error?: string;
  handledByClientId?: string;
  result?: { clientId?: string; result?: { turn?: { id?: string }; turnId?: string } };
}

export interface CodexDesktopIpc {
  call(
    method: string,
    params: object,
    version: number,
    targetClientId?: string
  ): Promise<DesktopResponse>;
}

export async function withCodexDesktopIpc<T>(
  socketPath: string,
  use: (client: CodexDesktopIpc) => Promise<T>,
  deadline?: number
): Promise<T> {
  const socket = createConnection(socketPath);
  const deadlineTimer =
    deadline === undefined
      ? undefined
      : setTimeout(
          () => socket.destroy(new Error('Codex Desktop handoff timed out.')),
          Math.max(0, deadline - Date.now())
        );
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
    if (deadline !== undefined && Date.now() >= deadline)
      throw new Error('Codex Desktop handoff timed out.');
    if (socket.destroyed) throw new Error('Codex Desktop closed the handoff connection.');
    const requestId = String(++nextId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        timer = setTimeout(
          () => reject(new Error(`Codex Desktop ${method} timed out.`)),
          deadline === undefined ? TIMEOUT_MS : Math.max(0, deadline - Date.now())
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
  try {
    await once(socket, 'connect');
    const initialized = await call('initialize', { clientType: 'hyperneo' }, 0);
    if (initialized.resultType !== 'success' || !initialized.result?.clientId)
      throw new Error(initialized.error ?? 'Codex Desktop IPC initialization failed.');
    clientId = initialized.result.clientId;
    return await use({ call });
  } finally {
    clearTimeout(deadlineTimer);
    socket.destroy();
  }
}
