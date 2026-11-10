import { createConnection, type Socket } from 'node:net';
import { CallToolResultSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type Binding = { worker_id: string; driver_instance_id: string; socket: string };
export function createDriverTransport() {
  const sockets = new Set<Socket>();
  let control: Socket | undefined;
  let current: Binding | undefined;
  let ready: Promise<unknown> | undefined;
  let ended = false;
  let notifyClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  function close() {
    ended = true;
    notifyClosed();
    for (const socket of sockets) socket.destroy();
  }
  function exchange(
    binding: Binding,
    request: object,
    keep = false,
    sent?: () => void
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(binding.socket);
      socket.setEncoding('utf8');
      sockets.add(socket);
      if (keep) control = socket;
      let buffer = '';
      let settled = false;
      socket.setTimeout(keep ? 5000 : 125000, () => socket.destroy(new Error('driver_timeout')));
      socket.once('connect', () => {
        socket.write(JSON.stringify(request) + '\n');
        sent?.();
      });
      socket.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
          socket.destroy(new Error('driver_reply_too_large'));
          return;
        }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, end)) as { ok?: boolean; result?: unknown };
          if (reply.ok !== true) throw new Error('driver_error');
          settled = true;
          resolve(reply.result);
          if (keep) socket.setTimeout(0);
          else socket.destroy();
        } catch {
          socket.destroy(new Error('driver_error'));
        }
      });
      socket.once('error', reject);
      socket.once('close', () => {
        sockets.delete(socket);
        if (!settled) reject(new Error('driver_disconnected'));
        if (socket === control) close();
      });
    });
  }
  return {
    closed,
    dispatch: async (
      binding: Binding,
      name: string,
      args: Record<string, unknown>,
      sent?: () => void
    ): Promise<CallToolResult> => {
      if (
        ended ||
        (current &&
          (current.driver_instance_id !== binding.driver_instance_id ||
            current.socket !== binding.socket ||
            current.worker_id !== binding.worker_id))
      )
        throw new Error('driver_unavailable');
      current ??= binding;
      ready ??= exchange(binding, { method: 'session_begin', session_id: binding.worker_id }, true);
      await ready;
      if (ended || control?.destroyed) throw new Error('driver_unavailable');
      return CallToolResultSchema.parse(
        await exchange(
          binding,
          {
            method: 'call',
            name,
            args: { ...args, session: binding.worker_id },
            session_id: binding.worker_id,
          },
          false,
          sent
        )
      );
    },
    close,
  };
}
