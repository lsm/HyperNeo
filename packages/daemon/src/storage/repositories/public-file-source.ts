import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { NeoConversationAskRepository } from './neo-conversation-ask-repository.ts';
import { SessionRepository } from './session-repository.ts';
import { hydrateSdkMessageBodies } from './sdk-message-body-read.ts';
import { extractVisibleText, parseSdkMessageRow } from './sdk-message-projections.ts';
import { isLocalUser } from '../../lib/operations/caller.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import type { StoredReferenceSource } from '../../lib/artifacts/reference-plan.ts';

type Key = StoredReferenceSource['key'] | { kind: 'question'; id: string; revisionId?: string };
type Source = {
  text: readonly string[];
  owner: WorkRef;
  workspacePath: string | null;
  publication?: NeoPublication;
};

export function readPublicFileSource(
  db: Database,
  key: Key,
  caller: OperationCaller
): Source | null {
  if (!isLocalUser(caller)) return null;
  const neo = new NeoRepository(db);
  const located = (
    text: readonly string[],
    owner: WorkRef,
    publication?: NeoPublication
  ): Source => ({
    text,
    owner,
    publication,
    workspacePath:
      owner.adapter === 'hyperneo' && !owner.daemon
        ? (new SessionRepository(db).getSession(owner.id)?.workspacePath ?? null)
        : null,
  });
  if (key.kind === 'publication') {
    const conversationId = neo.readConversationId();
    const owner = neo.defaultBinding();
    if (!conversationId || !owner) return null;
    const publication = new NeoPublicationRepository(db).get(conversationId, key.id);
    if (!publication) return null;
    const version =
      !key.revisionId || key.revisionId === (publication.revisionId ?? publication.publicationId)
        ? publication
        : publication.revisions?.find((item) => item.revisionId === key.revisionId);
    return version
      ? located(
          [version.shortText ?? '', version.fullText],
          { adapter: 'hyperneo', id: owner.sessionId },
          publication
        )
      : null;
  }
  if (key.revisionId) return null;
  if (key.kind === 'question') {
    const work = new NeoAskTodoRepository(db);
    const question = work.getQuestion(key.id);
    const ask = question ? work.getAsk(question.askId) : null;
    const owner = question?.sourceSession;
    return question && ask
      ? located(
          [question.text, question.document ?? ''],
          owner
            ? {
                adapter: owner.adapter,
                id: owner.id,
                ...(owner.daemon ? { daemon: owner.daemon } : {}),
              }
            : { adapter: 'hyperneo', id: ask.sessionId }
        )
      : null;
  }
  if (key.kind === 'todo') {
    const work = new NeoAskTodoRepository(db);
    const todo = work.getTodo(key.id);
    const ask = todo ? work.getAsk(todo.askId) : null;
    return todo && ask
      ? located(
          [
            todo.title,
            todo.doneWhen,
            todo.instruction ?? '',
            todo.report ?? '',
            todo.evidence ?? '',
            todo.blockedReason ?? '',
            todo.nextAction ?? '',
          ],
          new NeoTodoSessionRepository(db).readRef(todo.id) ?? {
            adapter: 'hyperneo',
            id: ask.sessionId,
          }
        )
      : null;
  }
  const row = db
    .prepare(
      hydrateSdkMessageBodies(
        'SELECT session_id, sdk_uuid, rowid AS body_seq FROM sdk_messages WHERE id = ? AND is_renderable = 1'
      )
    )
    .get(key.id) as { session_id: string; sdk_uuid: string; sdk_message: string } | null;
  const message = row ? parseSdkMessageRow(row.sdk_message, 'null') : null;
  if (
    !row ||
    !message ||
    !['user', 'assistant', 'result'].includes(message.type) ||
    !new SessionRepository(db).getSession(row.session_id)
  )
    return null;
  let text = extractVisibleText(message as unknown as Record<string, unknown>);
  if (
    row.session_id.startsWith('neo:') ||
    neo.getBindingBySession(row.session_id)?.kind === 'neo'
  ) {
    if (message.type !== 'user' || neo.defaultBinding()?.sessionId !== row.session_id) return null;
    const conversationId = neo.readConversationId();
    const ask = conversationId
      ? new NeoConversationAskRepository(db).find(conversationId, row.sdk_uuid)
      : null;
    if (
      !ask ||
      ask.askOrigin.sessionId !== row.session_id ||
      ask.askOrigin.messageId !== row.sdk_uuid
    )
      return null;
    text = extractVisibleText({ message: { content: ask.content } });
  }
  return located([text], { adapter: 'hyperneo', id: row.session_id });
}
