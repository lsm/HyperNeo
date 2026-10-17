import { randomUUID } from 'node:crypto';
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
}

export type ClaudeInboxEvent =
  | { kind: 'reply'; sessionId: string; messageId: string; from: string; content: string }
  | { kind: 'receipt'; sessionId: string; messageId: string; status: string };

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
  if (!['2.1.295', '2.1.299'].includes(target.version))
    throw new Error('Unverified Claude inbox protocol version.');
  z.string().uuid().parse(target.sessionId);
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
      content: `<cross-session-message from="${from}" from-name="HyperNeo" from-mode="bypass">\n${text}\n</cross-session-message>`,
    },
  })}\n`;
  if (Buffer.byteLength(frame) > FRAME_LIMIT) throw new Error('Claude inbox frame is too large.');
  return frame;
}

export function claudeInboxEvent(
  value: unknown,
  target: ClaudeInboxTarget,
  sent: ReadonlySet<string>
): ClaudeInboxEvent | null {
  const from = `uds:${target.socketPath}`;
  const reply = ReplySchema.safeParse(value);
  if (reply.success && reply.data.from === from) {
    return {
      kind: 'reply',
      sessionId: target.sessionId,
      messageId: reply.data.msg_id,
      from,
      content: reply.data.message.content,
    };
  }
  const receipt = ReceiptSchema.safeParse(value);
  if (!receipt.success || receipt.data.from !== from || !sent.has(receipt.data.orig_msg_id))
    return null;
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

export async function openClaudeInbox(
  target: ClaudeInboxTarget,
  onEvent: (event: ClaudeInboxEvent) => void
): Promise<{
  path: string;
  write: (submission: ClaudeInboxSubmission) => Promise<{ written: true }>;
  close: () => Promise<void>;
}> {
  if (
    !isAbsolute(target.socketPath) ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0 ||
    !new RegExp(`^${target.pid}(?:-[a-f0-9]{8})?\\.sock$`).test(basename(target.socketPath))
  )
    throw new Error('Claude inbox path does not match the live PID.');
  requireClaudeInboxProtocol(target);
  const directory = dirname(target.socketPath);
  await requirePrivatePath(directory, 'directory');
  await requirePrivatePath(target.socketPath, 'socket');
  const path = join(directory, `${process.pid}-${randomUUID().slice(0, 8)}.sock`);
  claudeInboxAddress(path);
  const bindingDir = await mkdtemp(join(directory, '.hn-'));
  const bindingPath = join(bindingDir, 's');
  const connections = new Set<Socket>();
  const sent = new Set<string>();
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
        const event = claudeInboxEvent(value, target, sent);
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
    await link(bindingPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removePaths();
    throw error;
  }
  return {
    path,
    async write(submission) {
      if (closed) return Promise.reject(new Error('Claude reply inbox is closed.'));
      const frame = claudeInboxFrame(target, path, submission);
      const existing = writes.get(submission.messageId);
      if (existing && existing.frame !== frame)
        throw new Error('Claude submission identity was reused for different content.');
      if (existing?.result) return existing.result;
      const result = requirePrivatePath(target.socketPath, 'socket')
        .then(() => {
          if (closed) throw new Error('Claude reply inbox is closed.');
          sent.add(submission.messageId);
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
