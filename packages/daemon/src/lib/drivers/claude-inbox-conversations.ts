import {
  openClaudeInbox,
  type ClaudeInboxEvent,
  type ClaudeInboxSubmission,
  type ClaudeInboxTarget,
} from './claude-inbox.ts';

interface ClaudeInboxConversationDeps {
  open?: typeof openClaudeInbox;
  onEvent(returnTo: string, event: ClaudeInboxEvent): void | Promise<void>;
  onError(error: unknown): void;
}

export function createClaudeInboxConversations(deps: ClaudeInboxConversationDeps) {
  const inboxes = new Map<string, ReturnType<typeof openClaudeInbox>>();
  const events = new Set<Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function route(returnTo: string, event: ClaudeInboxEvent): void {
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

  return {
    async write(target: ClaudeInboxTarget, returnTo: string, submission: ClaudeInboxSubmission) {
      if (closed) throw new Error('Claude inbox conversations are closed.');
      if (!returnTo.trim()) throw new Error('Claude inbox reply destination is missing.');
      const key = JSON.stringify([
        target.sessionId,
        target.pid,
        target.socketPath,
        target.version,
        returnTo,
      ]);
      let opening = inboxes.get(key);
      if (!opening) {
        opening = (deps.open ?? openClaudeInbox)(target, (event) => route(returnTo, event));
        inboxes.set(key, opening);
        const current = opening;
        void opening.catch(() => {
          if (inboxes.get(key) === current) inboxes.delete(key);
        });
      }
      const inbox = await opening;
      if (closed) throw new Error('Claude inbox conversations are closed.');
      return inbox.write(submission);
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const results = await Promise.allSettled(
          [...inboxes.values()].map(async (opening) => {
            const inbox = await opening.catch(() => null);
            await inbox?.close();
          })
        );
        await Promise.allSettled([...events]);
        inboxes.clear();
        const failures = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        if (failures.length) throw new AggregateError(failures, 'Claude inbox shutdown failed.');
      })();
      return closing;
    },
  };
}
