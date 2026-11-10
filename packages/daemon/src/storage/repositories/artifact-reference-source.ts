import type { Database } from '../sqlite-compat.ts';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoTodoRepository } from '../../lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../lib/neo/packs/todo-policies.ts';
import { homedir } from 'node:os';
import type { ArtifactContext } from '../../lib/artifacts/file-policy.ts';
import type {
  ReferenceBinding,
  StoredReferenceSource,
} from '../../lib/artifacts/reference-plan.ts';
import { loadRegistrationBinding } from '../../lib/artifacts/registration-binding.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';
import { readPublicFileSource } from './public-file-source.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';

type Key = StoredReferenceSource['key'];
type Text = { text: readonly string[]; contexts: ArtifactContext[] };

export class ArtifactReferenceSourceRepository {
  constructor(
    private readonly db: Database,
    private readonly daemonId: string,
    private readonly home = homedir(),
    private readonly repository: (todo: NeoTodo | null, ask: NeoAsk | null) => string | null = (
      todo,
      ask
    ) => neoTodoRepository(todo ?? { check: null, named: null }, neoTodoPolicies(db), { ask, todo })
  ) {}

  private sessionContexts(sessionId: string): ArtifactContext[] {
    return this.db
      .prepare(`SELECT 'todo' AS kind, todo_id AS id FROM neo_todo_sessions
      WHERE json_extract(ref, '$.adapter') = 'hyperneo' AND json_extract(ref, '$.id') = ?
        AND json_extract(ref, '$.daemon') IS NULL
      UNION SELECT 'ask' AS kind, id FROM neo_asks WHERE session_id = ? LIMIT 101`)
      .all(sessionId, sessionId) as ArtifactContext[];
  }

  private text(key: Key, caller: OperationCaller): Text | null {
    const source = readPublicFileSource(this.db, key, caller);
    if (!source) return null;
    if (source.publication) {
      const publication = source.publication;
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
      return { text: source.text, contexts };
    }
    return {
      text: source.text,
      contexts:
        key.kind === 'todo'
          ? [{ kind: 'todo', id: key.id }]
          : this.sessionContexts(source.owner.id),
    };
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
      ? { ...binding, repository: this.repository(todo, ask), revision: { kind: 'worktree' } }
      : null;
  }

  load(key: Key, caller: OperationCaller): StoredReferenceSource | null {
    const source = this.text(key, caller);
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
