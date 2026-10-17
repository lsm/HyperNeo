import { dirname } from 'node:path';
import {
  openClaudeInbox,
  type ClaudeInboxEvent,
  type ClaudeInboxSubmission,
  type ClaudeInboxTarget,
} from './claude-inbox.ts';

export interface ClaudeInboxRoutes {
  record(sessionId: string, returnTo: string, inboxDir: string): void;
  returnTo(sessionId: string): string | null;
  lastInboxDir(): string | null;
}

interface ClaudeInboxConversationDeps {
  name: string;
  routes: ClaudeInboxRoutes;
  open?: typeof openClaudeInbox;
  onEvent(returnTo: string, event: ClaudeInboxEvent): void | Promise<void>;
  onError(error: unknown): void;
}

export function createClaudeInboxConversations(deps: ClaudeInboxConversationDeps) {
  let opening: ReturnType<typeof openClaudeInbox> | undefined;
  const events = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function route(event: ClaudeInboxEvent): void {
    const returnTo = deps.routes.returnTo(event.sessionId);
    if (!returnTo) return;
    const task = Promise.resolve().then(() => deps.onEvent(returnTo, event));
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
    if (opening) return opening;
    const current = (deps.open ?? openClaudeInbox)(directory, deps.name, route);
    opening = current;
    void current.catch(() => {
      if (opening === current) opening = undefined;
    });
    return current;
  }

  return {
    async listen(): Promise<void> {
      const directory = deps.routes.lastInboxDir();
      if (directory && !closed) await inbox(directory);
    },
    async write(target: ClaudeInboxTarget, returnTo: string, submission: ClaudeInboxSubmission) {
      if (closed) throw new Error('Claude inbox conversations are closed.');
      if (!returnTo.trim()) throw new Error('Claude inbox reply destination is missing.');
      const directory = dirname(target.socketPath);
      const opened = await inbox(directory);
      if (closed) throw new Error('Claude inbox conversations are closed.');
      deps.routes.record(target.sessionId, returnTo, directory);
      return opened.write(target, submission);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const opened = await opening?.catch(() => null);
        try {
          await opened?.close();
        } finally {
          await Promise.allSettled([...events]);
        }
      })();
      return closing;
    },
  };
}
