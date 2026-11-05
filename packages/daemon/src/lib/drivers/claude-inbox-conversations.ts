import { dirname } from 'node:path';
import {
  openClaudeInbox,
  type ClaudeInboxEvent,
  type ClaudeInboxFrameEvent,
  type ClaudeInboxSubmission,
  type ClaudeInboxTarget,
} from './claude-inbox.ts';

export interface ClaudeInboxRoutes {
  record(sessionId: string, returnTo: string, inboxDir: string): Promise<void>;
  returnTo(sessionId: string): string | null;
  inboxDirs(): string[];
}

interface ClaudeInboxConversationDeps {
  name: string;
  routes: ClaudeInboxRoutes;
  senderSession(from: string): Promise<string | null>;
  open?: typeof openClaudeInbox;
  onEvent(returnTo: string, event: ClaudeInboxEvent): void | Promise<void>;
  onError(error: unknown): void;
}

async function claudeFrameEvent(
  frame: ClaudeInboxFrameEvent,
  senderSession: (from: string) => Promise<string | null>
): Promise<ClaudeInboxEvent | null> {
  if (frame.kind === 'receipt') return frame;
  const sessionId = await senderSession(frame.from);
  return sessionId ? { ...frame, sessionId } : null;
}

export function createClaudeInboxConversations(deps: ClaudeInboxConversationDeps) {
  const inboxes = new Map<string, ReturnType<typeof openClaudeInbox>>();
  const events = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function deliver(frame: ClaudeInboxFrameEvent): Promise<void> {
    const event = await claudeFrameEvent(frame, deps.senderSession);
    const returnTo = event ? deps.routes.returnTo(event.sessionId) : null;
    if (event && returnTo) await deps.onEvent(returnTo, event);
  }

  function route(frame: ClaudeInboxFrameEvent): void {
    const task = deliver(frame);
    events.add(task);
    void task.then(
      () => events.delete(task),
      (error: unknown) => {
        events.delete(task);
        try {
          deps.onError(error);
        } catch {}
      }
    );
  }

  function inbox(directory: string): ReturnType<typeof openClaudeInbox> {
    const existing = inboxes.get(directory);
    if (existing) return existing;
    const current = (deps.open ?? openClaudeInbox)(directory, deps.name, route);
    inboxes.set(directory, current);
    void current.catch(() => {
      if (inboxes.get(directory) === current) inboxes.delete(directory);
    });
    return current;
  }

  return {
    async listen(): Promise<void> {
      if (!closed) await Promise.all(deps.routes.inboxDirs().map(inbox));
    },
    async write(target: ClaudeInboxTarget, returnTo: string, submission: ClaudeInboxSubmission) {
      if (closed) throw new Error('Claude inbox conversations are closed.');
      if (!returnTo.trim()) throw new Error('Claude inbox reply destination is missing.');
      const directory = dirname(target.socketPath);
      const opened = await inbox(directory);
      await deps.routes.record(target.sessionId, returnTo, directory);
      if (closed) throw new Error('Claude inbox conversations are closed.');
      return opened.write(target, submission);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const opened = await Promise.all(
          [...inboxes.values()].map((opening) => opening.catch(() => null))
        );
        const results = await Promise.allSettled(opened.map((item) => item?.close()));
        await Promise.allSettled([...events]);
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length) throw new AggregateError(failures, 'Claude inbox shutdown failed.');
      })();
      return closing;
    },
  };
}
