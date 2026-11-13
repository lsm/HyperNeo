import { createConnection } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

const Reply = z.object({
  ok: z.literal(true),
  result: z.union([
    z.object({
      call_id: z.string(),
      reason: z.enum(['tool_not_allowed', 'target_unverified', 'target_mismatch']),
      class: z.string().optional(),
      bundle_id: z.string().optional(),
    }),
    z.object({
      call_id: z.string(),
      value: z.object({
        bundle_id: z.string(),
        class: z.string(),
        instance: z.object({ pid: z.number() }).optional(),
        window_id: z.number().nullable().optional(),
      }),
    }),
  ]),
});

function ask(socket: string, request: Record<string, unknown>) {
  return new Promise<string | null>((resolve) => {
    const client = createConnection(socket);
    let text = '';
    const timer = setTimeout(() => finish(null), 2500);
    function finish(line: string | null) {
      clearTimeout(timer);
      client.destroy();
      resolve(line);
    }
    client.once('connect', () => client.write(JSON.stringify(request) + '\n'));
    client.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) finish(text.slice(0, text.indexOf('\n')));
      else if (text.length > 65536) finish(null);
    });
    client.once('end', () => finish(null));
    client.once('error', () => finish(null));
  });
}

export function createDesktopTargetBroker(dataDir: string) {
  return async (
    binding: { worker_id: string },
    name: string,
    args: Record<string, unknown>,
    callId: string
  ) => {
    const line = await ask(join(dataDir, 'desktop/control.sock'), {
      action: 'resolve',
      worker: binding.worker_id,
      tool: name,
      arguments: { pid: args.pid, window_id: args.window_id, bundle_id: args.bundle_id },
      callId,
    });
    let reply: unknown = null;
    try {
      reply = JSON.parse(line ?? 'null');
    } catch {
      return null;
    }
    const parsed = Reply.safeParse(reply);
    if (!parsed.success || parsed.data.result.call_id !== callId) return null;
    const result = parsed.data.result;
    if ('reason' in result)
      return { reason: result.reason, class: result.class, app_id: result.bundle_id };
    return {
      value: {
        app_id: result.value.bundle_id,
        class: result.value.class,
        pid: result.value.instance?.pid ?? null,
        window_id: result.value.window_id ?? null,
      },
    };
  };
}
