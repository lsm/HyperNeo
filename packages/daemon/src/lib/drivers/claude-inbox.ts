import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { chmod, link, lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { z } from 'zod';

const FRAME_LIMIT = 1_048_576;
const IO_TIMEOUT_MS = 5_000;

export interface ClaudeInboxTarget {
  sessionId: string;
  pid: number;
  socketPath: string;
  version: string;
}

export interface ClaudeInboxSubmission {
  messageId: string;
  inputId: string;
  text: string;
  fromMode: 'bypass' | 'prompting';
}

export type ClaudeInboxEvent =
  | { kind: 'reply'; sessionId: string; messageId: string; from: string; content: string }
  | { kind: 'receipt'; sessionId: string; messageId: string; status: string };

export type ClaudeInboxFrameEvent =
  | Extract<ClaudeInboxEvent, { kind: 'receipt' }>
  | Omit<Extract<ClaudeInboxEvent, { kind: 'reply' }>, 'sessionId'>;

const ReplySchema = z.object({
  msgV: z.literal(1),
  msg_id: z.string().uuid(),
  type: z.literal('user'),
  from: z.string(),
  message: z.object({ role: z.literal('user'), content: z.string().min(1) }),
});

const ReceiptSchema = z.object({
  type: z.literal('control'),
  action: z.literal('peer_message_status'),
  from: z.string(),
  orig_msg_id: z.string(),
  status: z.enum(['held', 'denied', 'expired', 'delivered', 'refused', 'dropped']),
  status_detail: z.string().optional(),
});

function requireClaudeInboxProtocol(target: ClaudeInboxTarget): void {
  z.string().uuid().parse(target.sessionId);
}

export function claudeInboxName(identity: string): string {
  return createHash('sha256').update(identity).digest('hex').slice(0, 16);
}

function claudeInboxAddress(path: string): string {
  if (!/^\/[A-Za-z0-9/_.-]+\.sock$/.test(path)) throw new Error('Invalid Claude inbox address.');
  return `uds:${path}`;
}

export function claudeInboxText(text: string): string {
  return text.replace(/<(?=\/?cross-session-message(?:\s|>))/gi, '<\\');
}

export function claudeInboxFrame(
  target: ClaudeInboxTarget,
  replyPath: string,
  submission: ClaudeInboxSubmission
): string {
  requireClaudeInboxProtocol(target);
  z.string().uuid().parse(submission.messageId);
  z.string().uuid().parse(submission.inputId);
  if (!submission.text.trim()) throw new Error('Claude inbox message is empty.');
  const from = claudeInboxAddress(replyPath);
  const fromMode = z.enum(['bypass', 'prompting']).parse(submission.fromMode);
  const text = claudeInboxText(submission.text);
  const frame = `${JSON.stringify({
    msgV: 1,
    type: 'user',
    session_id: target.sessionId,
    uuid: submission.inputId,
    msg_id: submission.messageId,
    from,
    priority: 'next',
    message: {
      role: 'user',
      content: `<cross-session-message from="${from}" from-name="HyperNeo" from-mode="${fromMode}">\n${text}\n</cross-session-message>`,
    },
  })}\n`;
  if (Buffer.byteLength(frame) > FRAME_LIMIT) throw new Error('Claude inbox frame is too large.');
  return frame;
}

export function claudeInboxEvent(
  value: unknown,
  sent: ReadonlyMap<string, ClaudeInboxTarget>
): ClaudeInboxFrameEvent | null {
  const reply = ReplySchema.safeParse(value);
  if (reply.success)
    return {
      kind: 'reply',
      messageId: reply.data.msg_id,
      from: reply.data.from,
      content: reply.data.message.content,
    };
  const receipt = ReceiptSchema.safeParse(value);
  const target = receipt.success ? sent.get(receipt.data.orig_msg_id) : undefined;
  if (!receipt.success || !target || receipt.data.from !== `uds:${target.socketPath}`) return null;
  return {
    kind: 'receipt',
    sessionId: target.sessionId,
    messageId: receipt.data.orig_msg_id,
    status:
      receipt.data.status === 'expired' && receipt.data.status_detail === 'refused'
        ? 'refused'
        : receipt.data.status,
  };
}

async function requirePrivatePath(path: string, kind: 'directory' | 'socket'): Promise<void> {
  const entry = await lstat(path);
  if (
    process.getuid?.() === undefined ||
    entry.uid !== process.getuid() ||
    (entry.mode & 0o077) !== 0 ||
    !(kind === 'directory' ? entry.isDirectory() : entry.isSocket())
  )
    throw new Error(`Claude inbox ${kind} is not private and owned by this user.`);
}

export async function removeOwnedClaudeInboxPath(path: string, bound: Stats): Promise<void> {
  try {
    const entry = await lstat(path);
    if (
      entry.isSocket() &&
      entry.dev === bound.dev &&
      entry.ino === bound.ino &&
      entry.uid === bound.uid
    )
      await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

class UncertainClaudeWrite extends Error {}

function writeClaudeFrame(path: string, frame: string, connections: Set<Socket>): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    connections.add(socket);
    let written = false;
    let attempted = false;
    let hold: ReturnType<typeof setTimeout> | undefined;
    socket.setTimeout(IO_TIMEOUT_MS, () =>
      socket.destroy(new Error('Claude inbox write timed out.'))
    );
    socket.once('error', (error) =>
      reject(attempted ? new UncertainClaudeWrite(error.message, { cause: error }) : error)
    );
    socket.once('close', (failed) => {
      connections.delete(socket);
      clearTimeout(hold);
      if (failed) return;
      if (written) resolve();
      else
        reject(
          attempted
            ? new UncertainClaudeWrite('Claude inbox write is uncertain.')
            : new Error('Claude inbox closed before writing.')
        );
    });
    socket.once('connect', () => {
      attempted = true;
      socket.write(frame, (error) => {
        if (error) {
          socket.destroy(error);
          return;
        }
        written = true;
        hold = setTimeout(() => socket.end(), process.platform === 'darwin' ? 150 : 0);
      });
    });
  });
}

function requireClaudeInboxTarget(target: ClaudeInboxTarget, directory: string): void {
  if (
    !isAbsolute(target.socketPath) ||
    dirname(target.socketPath) !== directory ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    !new RegExp(`^${target.pid}(?:-[a-f0-9]{8})?\\.sock$`).test(basename(target.socketPath))
  )
    throw new Error('Claude inbox path does not match the live PID.');
  requireClaudeInboxProtocol(target);
}

async function removeStaleClaudeInbox(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSocket() && entry.uid === process.getuid?.()) await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function openClaudeInbox(
  directory: string,
  name: string,
  onEvent: (event: ClaudeInboxFrameEvent) => void
): Promise<{
  path: string;
  write: (
    target: ClaudeInboxTarget,
    submission: ClaudeInboxSubmission
  ) => Promise<{ written: true }>;
  close: () => Promise<void>;
}> {
  if (!/^[0-9a-f]{1,16}$/.test(name)) throw new Error('Invalid Claude inbox name.');
  await requirePrivatePath(directory, 'directory');
  const path = join(directory, `${name}.sock`);
  claudeInboxAddress(path);
  const bindingDir = await mkdtemp(join(directory, '.hn-'));
  const bindingPath = join(bindingDir, 's');
  const connections = new Set<Socket>();
  const sent = new Map<string, ClaudeInboxTarget>();
  const writes = new Map<string, { frame: string; result?: Promise<{ written: true }> }>();
  let closed = false;
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => connections.delete(socket));
    socket.setTimeout(IO_TIMEOUT_MS, () => socket.destroy());
    socket.setEncoding('utf8');
    let pending = '';
    socket.on('data', (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > FRAME_LIMIT) {
        socket.destroy();
        return;
      }
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        const event = claudeInboxEvent(value, sent);
        if (event) onEvent(event);
      }
    });
  });
  let bound: Stats | undefined;
  async function removePaths(): Promise<void> {
    try {
      if (bound) await removeOwnedClaudeInboxPath(path, bound);
    } finally {
      if (bound) await removeOwnedClaudeInboxPath(bindingPath, bound);
      await rmdir(bindingDir);
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(bindingPath, resolve);
    });
    bound = await lstat(bindingPath);
    await removeStaleClaudeInbox(path);
    await link(bindingPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removePaths();
    throw error;
  }
  return {
    path,
    async write(target, submission) {
      if (closed) return Promise.reject(new Error('Claude reply inbox is closed.'));
      requireClaudeInboxTarget(target, directory);
      const frame = claudeInboxFrame(target, path, submission);
      const existing = writes.get(submission.messageId);
      if (existing && existing.frame !== frame)
        throw new Error('Claude submission identity was reused for different content.');
      if (existing?.result) return existing.result;
      const result = requirePrivatePath(target.socketPath, 'socket')
        .then(() => {
          if (closed) throw new Error('Claude reply inbox is closed.');
          sent.set(submission.messageId, target);
          return writeClaudeFrame(target.socketPath, frame, connections);
        })
        .then(() => ({ written: true as const }))
        .catch((error: unknown) => {
          if (!(error instanceof UncertainClaudeWrite)) {
            writes.set(submission.messageId, { frame });
            sent.delete(submission.messageId);
          }
          throw error;
        });
      writes.set(submission.messageId, { frame, result });
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of connections) socket.destroy();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await removePaths();
      }
    },
  };
}
