import { createConnection } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

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
    tool: string;
    arguments: Record<string, unknown>;
    callId: string;
  }
): Promise<z.infer<typeof DesktopDispatchReply>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(join(dataDir, 'desktop/control.sock'));
    client.setEncoding('utf8');
    let text = '';
    const timer = setTimeout(() => fail(new Error('Desktop host timed out.')), 60000);
    function fail(error: Error) {
      clearTimeout(timer);
      client.destroy();
      reject(error);
    }
    client.once('connect', () =>
      client.write(JSON.stringify({ action: 'dispatch', ...request }) + '\n')
    );
    client.once('error', fail);
    client.once('end', () => fail(new Error('Desktop host closed without a reply.')));
    client.on('data', (chunk) => {
      text += chunk.toString();
      if (Buffer.byteLength(text) > 9 << 20)
        return fail(new Error('Desktop host reply too large.'));
      if (!text.includes('\n')) return;
      try {
        const { result } = Envelope.parse(JSON.parse(text.slice(0, text.indexOf('\n'))));
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
