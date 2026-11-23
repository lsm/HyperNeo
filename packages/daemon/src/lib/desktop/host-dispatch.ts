import { createConnection } from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const epoch = randomUUID();
let sequence = 0;

export class DesktopTurn {
  readonly id = [epoch, ++sequence] as const;
  stopped = false;

  async cancel(dataDir: string, worker: string): Promise<boolean> {
    this.stopped = true;
    const path = join(dataDir, 'desktop/control.sock');
    const client = createConnection({ path, signal: AbortSignal.timeout(18_000) }, () =>
      client.write(`${JSON.stringify({ action: 'cancelTurn', worker, turn: this.id })}\n`)
    );
    try {
      let text = '';
      for await (const chunk of client) {
        text += chunk.toString();
        const newline = text.indexOf('\n');
        if (newline !== -1) {
          const reply = JSON.parse(text.slice(0, newline));
          return reply?.ok === true && reply.result?.state === 'stopped';
        }
        if (text.length > 4096) return false;
      }
      return false;
    } catch (error) {
      return ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
    } finally {
      client.destroy();
    }
  }
}

export const DesktopDispatchReply = z.object({
  call_id: z.string(),
  bundle_id: z.string().nullable(),
  class: z.string().nullable(),
  decision: z.enum(['allowed', 'refused']),
  reason: z.string().nullable(),
  dispatched: z.boolean(),
  content: z
    .array(z.looseObject({ type: z.string() }))
    .optional()
    .catch(undefined),
  structuredContent: z.unknown().optional(),
});
const Envelope = z.object({ ok: z.literal(true), result: DesktopDispatchReply });

export function dispatchDesktopCall(
  dataDir: string,
  request: {
    worker: string;
    workDir: string;
    apps: string[];
    todo: string;
    todos: string[];
    tool: string;
    arguments: Record<string, unknown>;
    callId: string;
    turn?: DesktopTurn['id'];
  }
): Promise<z.infer<typeof DesktopDispatchReply>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(join(dataDir, 'desktop/control.sock'));
    client.setEncoding('utf8');
    let text = '';
    const timer = setTimeout(() => fail(new Error('Desktop host timed out.')), 105000);
    function fail(error: Error) {
      clearTimeout(timer);
      client.destroy();
      reject(error);
    }
    client.once('connect', () =>
      client.write(JSON.stringify({ action: 'dispatch', ...request }) + '\n')
    );
    client.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'ECONNREFUSED') return fail(error);
      clearTimeout(timer);
      client.destroy();
      resolve({
        call_id: request.callId,
        bundle_id: null,
        class: null,
        decision: 'refused',
        reason: 'desktop_app_not_connected',
        dispatched: false,
      });
    });
    client.once('end', () => fail(new Error('Desktop host closed without a reply.')));
    client.on('data', (chunk) => {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 9 << 20)
        return fail(new Error('Desktop host reply too large.'));
      if (!text.includes('\n')) return;
      try {
        const envelope: unknown = JSON.parse(text.slice(0, text.indexOf('\n')));
        const busy = z
          .object({ ok: z.literal(false), error: z.literal('desktop_busy') })
          .safeParse(envelope);
        if (busy.success) {
          clearTimeout(timer);
          client.destroy();
          resolve({
            call_id: request.callId,
            bundle_id: null,
            class: null,
            decision: 'refused',
            reason: 'desktop_busy',
            dispatched: false,
          });
          return;
        }
        const { result } = Envelope.parse(envelope);
        if (result.call_id !== request.callId)
          throw new Error('Desktop host reply does not match this call.');
        clearTimeout(timer);
        client.destroy();
        resolve(result);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid desktop host reply.'));
      }
    });
  });
}
