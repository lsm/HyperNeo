import type { Database } from '../sqlite-compat.ts';
import { homedir } from 'node:os';
import type { ArtifactContext } from '../../lib/artifacts/file-policy.ts';
import type {
  ReferenceBinding,
  StoredReferenceSource,
} from '../../lib/artifacts/reference-plan.ts';
import { loadRegistrationBinding } from '../../lib/artifacts/registration-binding.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';
import { hydrateSdkMessageBodies } from './sdk-message-body-read.ts';
import { extractVisibleText, parseSdkMessageRow } from './sdk-message-projections.ts';

type Key = StoredReferenceSource['key'];
type Text = { text: readonly string[]; contexts: ArtifactContext[] };

export class ArtifactReferenceSourceRepository {
  constructor(
    private readonly db: Database,
    private readonly daemonId: string,
    private readonly home = homedir()
  ) {}

  private sessionContexts(sessionId: string): ArtifactContext[] {
    return this.db
      .prepare(`SELECT 'todo' AS kind, todo_id AS id FROM neo_todo_sessions
      WHERE json_extract(ref, '$.adapter') = 'hyperneo' AND json_extract(ref, '$.id') = ?
        AND json_extract(ref, '$.daemon') IS NULL
      UNION SELECT 'ask' AS kind, id FROM neo_asks WHERE session_id = ? LIMIT 101`)
      .all(sessionId, sessionId) as ArtifactContext[];
  }

  private text(key: Key): Text | null {
    if (key.kind === 'publication') {
      const rows = this.db
        .prepare('SELECT conversation_id FROM neo_publications WHERE publication_id = ? LIMIT 2')
        .all(key.id) as { conversation_id: string }[];
      if (rows.length !== 1) return null;
      const publication = new NeoPublicationRepository(this.db).get(
        rows[0].conversation_id,
        key.id
      );
      if (!publication) return null;
      const version =
        !key.revisionId || key.revisionId === (publication.revisionId ?? publication.publicationId)
          ? publication
          : publication.revisions?.find((item) => item.revisionId === key.revisionId);
      const links = publication.links.flatMap<ArtifactContext>((link) =>
        link.kind === 'work'
          ? [{ kind: 'todo', id: link.id }]
          : link.kind === 'consultation'
            ? [{ kind: 'ask', id: link.id }]
            : []
      );
      const contexts = links.length
        ? links
        : publication.askOrigin
          ? (this.db
              .prepare(
                `SELECT 'ask' AS kind, id FROM neo_asks WHERE session_id = ? AND origin_message_id = ? LIMIT 101`
              )
              .all(
                publication.askOrigin.sessionId,
                publication.askOrigin.messageId
              ) as ArtifactContext[])
          : [];
      return version
        ? {
            text: [version.shortText, version.fullText].filter(
              (part): part is string => part !== undefined
            ),
            contexts,
          }
        : null;
    }
    if (key.revisionId) return null;
    if (key.kind === 'todo') {
      const todo = new NeoAskTodoRepository(this.db).getTodo(key.id);
      return todo
        ? {
            text: [
              todo.title,
              todo.doneWhen,
              todo.instruction ?? '',
              todo.report ?? '',
              todo.evidence ?? '',
              todo.blockedReason ?? '',
              todo.nextAction ?? '',
            ],
            contexts: [{ kind: 'todo', id: todo.id }],
          }
        : null;
    }
    const row = this.db
      .prepare(
        hydrateSdkMessageBodies(
          'SELECT session_id, rowid AS body_seq FROM sdk_messages WHERE id = ?'
        )
      )
      .get(key.id) as { session_id: string; sdk_message: string } | null;
    const message = row ? parseSdkMessageRow(row.sdk_message, 'null') : null;
    return row && message && ['user', 'assistant', 'result'].includes(message.type)
      ? {
          text: [extractVisibleText(message as unknown as Record<string, unknown>)],
          contexts: this.sessionContexts(row.session_id),
        }
      : null;
  }

  private binding(context: ArtifactContext): ReferenceBinding | null {
    const work = new NeoAskTodoRepository(this.db);
    const todo = context.kind === 'todo' ? work.getTodo(context.id) : null;
    const ask = work.getAsk(todo?.askId ?? context.id);
    const local = loadRegistrationBinding(this.db, this.daemonId, context, this.home);
    const ref = todo ? new NeoTodoSessionRepository(this.db).readRef(todo.id) : null;
    const binding =
      local ??
      (ask && ref?.daemon
        ? {
            context,
            daemonId: ref.daemon,
            neoSessionId: ask.sessionId,
            workerSessionId: ref.id,
            workspacePath: null,
            approvedEvidenceRoots: [],
          }
        : null);
    return binding
      ? { ...binding, repository: todo?.repo ?? ask?.repo ?? null, revision: { kind: 'worktree' } }
      : null;
  }

  load(key: Key): StoredReferenceSource | null {
    const source = this.text(key);
    if (!source || source.contexts.length > 100) return null;
    const unique = new Map(
      source.contexts.map((context) => [`${context.kind}:${context.id}`, context])
    );
    return {
      key,
      text: source.text,
      bindings: [...unique.values()].flatMap((context) => this.binding(context) ?? []),
    };
  }
}
