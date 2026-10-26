import { chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { getDataDir } from '../data-dir.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationCaller, OperationRegistry } from '../operations/registry.ts';
import { SESSION_DOOR_PRINCIPAL } from '../pairing/pairing-operations.ts';

const DOOR_OPERATIONS = new Set([
  'message.send',
  'neo.question.get',
  'system.build',
  'device.pair.create',
  'device.pair.reset_lockout',
  'device.list',
  'device.revoke',
  'device.reset_human',
  'device.unpaired.list',
  'device.would_refuse.list',
]);
const MAX_BODY_BYTES = 256 * 1024;

export function sessionDoorPath(): string {
  return join(getDataDir(), 'session-door.sock');
}

export function planSessionDoorCall(
  body: unknown
): { value: { name: string; input: unknown; caller: OperationCaller } } | { reason: string } {
  const { sender, name, input } = (body ?? {}) as Record<string, unknown>;
  if (typeof sender !== 'string' || !sender.trim())
    return { reason: 'no_sender: the session door needs the calling session id.' };
  if (typeof name !== 'string' || !DOOR_OPERATIONS.has(name))
    return {
      reason: `not_allowed: the session door runs only ${[...DOOR_OPERATIONS].join(', ')}.`,
    };
  const { from: _from, ...rest } = (input ?? {}) as Record<string, unknown>;
  return {
    value: {
      name,
      input: rest,
      caller: { source: 'mcp', principal: SESSION_DOOR_PRINCIPAL, sessionId: sender.trim() },
    },
  };
}

function doorAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

export async function startSessionDoor(
  registry: () => OperationRegistry,
  path = sessionDoorPath()
) {
  if (await doorAnswers(path)) throw new Error(`another daemon already serves ${path}`);
  await rm(path, { force: true });
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) chunks.length = 0;
      else chunks.push(chunk);
    });
    request.on('end', async () => {
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (size > MAX_BODY_BYTES)
        return reply(413, {
          error:
            'Request exceeds 256 KiB. Write the report to HYPERNEO_HANDOFF_DIR, call handoff.publish, then message.send {to, text, files: [reference]}.',
        });
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reply(400, { error: 'invalid_json' });
      }
      const plan = planSessionDoorCall(parsed);
      if ('reason' in plan) return reply(400, { error: plan.reason });
      const { name, input, caller } = plan.value;
      reply(200, await invokeOperation(registry(), name, input, caller));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const previous = process.umask(0o177);
    try {
      server.listen(path, resolve);
    } finally {
      process.umask(previous);
    }
  });
  await chmod(path, 0o600);
  return {
    path,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => void rm(path, { force: true }).then(resolve))
      ),
  };
}
