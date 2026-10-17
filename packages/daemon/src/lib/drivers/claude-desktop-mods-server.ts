import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, link, lstat, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { readClaudeInboxEndpoint } from './claude-inbox-endpoint.ts';
import { removeOwnedClaudeInboxPath } from './claude-inbox.ts';
import type { ClaudeLiveSession } from './claude-desktop-adapter.ts';

const LIMIT = 1_048_576;
class DesktopModsBodyLimit extends Error {}
const EventSchema = z
  .object({
    sequence: z.number().int().positive(),
    kind: z.enum([
      'session.start',
      'session.end',
      'turn.start',
      'turn.complete',
      'command.started',
      'command.resolved',
      'command.rejected',
    ]),
    turnId: z.string().min(1).optional(),
    commandId: z.string().min(1).optional(),
    reason: z.string().optional(),
    isAborted: z.boolean().optional(),
    operation: z.enum(['stop', 'submit']).optional(),
    result: z.unknown().optional(),
  })
  .strict();
const ExchangeSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    instanceId: z.string().min(1),
    events: z.array(EventSchema),
  })
  .strict()
  .refine(
    (value) =>
      value.instanceId.startsWith(`${value.sessionId}:`) &&
      value.events.every(
        (event, i) =>
          (i === 0 || event.sequence === value.events[i - 1].sequence + 1) &&
          (!event.kind.startsWith('turn.') || !!event.turnId) &&
          (!event.kind.startsWith('command.') || !!event.commandId)
      )
  );
const CommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      id: z.string().min(1),
      instanceId: z.string().min(1),
      kind: z.literal('stop'),
      turnId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      id: z.string().min(1),
      instanceId: z.string().min(1),
      kind: z.literal('submit'),
      from: z.string().trim().min(1),
      text: z.string().min(1),
    })
    .strict(),
]);
const ReplySchema = z
  .object({ ack: z.number().int().nonnegative(), command: CommandSchema.optional() })
  .strict();
type Exchange = z.infer<typeof ExchangeSchema>;
type Reply = z.infer<typeof ReplySchema>;
interface Deps {
  parentDirectory: string;
  registrationsDir: string;
  liveSessions(): Promise<readonly ClaudeLiveSession[]>;
  persist(exchange: Exchange, ownerPid: number, observedIdle: boolean): Promise<Reply>;
  onError(error: unknown): void;
}
interface RequestData {
  authorization?: string;
  method?: string;
  path?: string;
  body: string;
}
type Gate<T> = { value: T } | { reason: Response };

function authenticate(request: RequestData, token: string): Gate<true> {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(request.authorization ?? '');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { reason: new Response(null, { status: 401 }) };
  if (request.method !== 'POST' || request.path !== '/bridge/exchange')
    return { reason: new Response(null, { status: 404 }) };
  return { value: true };
}
function parseExchange(request: RequestData): Gate<Exchange> {
  try {
    const parsed = ExchangeSchema.safeParse(JSON.parse(request.body));
    if (parsed.success) return { value: parsed.data };
  } catch {}
  return { reason: new Response(null, { status: 400 }) };
}
async function requireDesktop(exchange: Exchange, deps: Deps) {
  const live = await deps.liveSessions();
  const target = await readClaudeInboxEndpoint(exchange.sessionId, live, deps.registrationsDir);
  return !('ok' in target) && target.version === '2.1.299'
    ? {
        value: {
          pid: target.pid,
          idle: live.find((row) => row.pid === target.pid)?.status === 'idle',
        },
      }
    : { reason: new Response(null, { status: 409 }) };
}
async function persistExchange(
  exchange: Exchange,
  owner: { pid: number; idle: boolean },
  deps: Deps
): Promise<Response> {
  const reply = ReplySchema.parse(await deps.persist(exchange, owner.pid, owner.idle));
  const last = exchange.events.at(-1)?.sequence;
  if (
    (last !== undefined && reply.ack > last) ||
    (reply.command && reply.command.instanceId !== exchange.instanceId)
  )
    throw new Error('Invalid Desktop mods persistence response');
  return Response.json(reply);
}
const exchangeDesktopMods = (superpipe({})('exchange-claude-desktop-mods') as PipelineAPI)
  .input(['request', 'token', 'deps'])
  .pipe(authenticate, ['request', 'token'], 'result:response')
  .pipe(parseExchange, 'request', 'result:response')
  .pipe((exchange: Exchange) => exchange, 'response', 'exchange')
  .pipe(requireDesktop, ['exchange', 'deps'], 'result:response')
  .pipe(persistExchange, ['exchange', 'response', 'deps'], 'response')
  .endAsync('response') as (request: RequestData, token: string, deps: Deps) => Promise<Response>;

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    request.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > LIMIT) {
        chunks.length = 0;
        reject(new DesktopModsBodyLimit('Desktop mods request is too large'));
      } else chunks.push(chunk);
    });
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
    request.once('aborted', () => reject(new Error('Desktop mods request aborted')));
  });
}
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  deps: Deps
) {
  try {
    const result = await exchangeDesktopMods(
      {
        authorization: request.headers.authorization,
        method: request.method,
        path: request.url,
        body: await readBody(request),
      },
      token,
      deps
    );
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(await result.text());
  } catch (error) {
    if (!(error instanceof DesktopModsBodyLimit)) deps.onError(error);
    response.writeHead(error instanceof DesktopModsBodyLimit ? 413 : 500);
    response.end();
  }
}

export async function createClaudeDesktopModsServer(deps: Deps) {
  const directory = await mkdtemp(join(deps.parentDirectory, 'hn-cdm-'));
  const socketPath = join(directory, 'bridge.sock');
  const bindingPath = join(directory, 'bound.sock');
  const connectionFile = join(directory, 'connection.json');
  const token = randomBytes(32).toString('hex');
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const work = handleRequest(request, response, token, deps);
    pending.add(work);
    void work.finally(() => pending.delete(work));
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.setTimeout(10_000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  let bound: Stats | undefined;
  let config: Stats | undefined;
  async function clean() {
    if (bound) {
      await removeOwnedClaudeInboxPath(socketPath, bound);
      await removeOwnedClaudeInboxPath(bindingPath, bound);
    }
    await lstat(connectionFile)
      .then(async (entry) => {
        if (
          config &&
          entry.isFile() &&
          entry.dev === config.dev &&
          entry.ino === config.ino &&
          entry.uid === config.uid
        )
          await unlink(connectionFile);
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    await rmdir(directory);
  }
  try {
    await chmod(directory, 0o700);
    if (Buffer.byteLength(bindingPath) > 100)
      throw new Error('Desktop mods socket path is too long');
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindingPath, resolve);
    });
    bound = await lstat(bindingPath);
    await link(bindingPath, socketPath);
    await chmod(socketPath, 0o600);
    await writeFile(connectionFile, JSON.stringify({ socketPath, token }), {
      mode: 0o600,
      flag: 'wx',
    });
    config = await lstat(connectionFile);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clean();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    connectionFile,
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(pending);
        await clean();
      })();
      return closing;
    },
  };
}
