import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { ArtifactContext, ArtifactContextBinding } from './file-policy.ts';

export function loadRegistrationBinding(
  db: Database,
  daemonId: string,
  context: ArtifactContext
): ArtifactContextBinding | null {
  const work = new NeoAskTodoRepository(db);
  const todo = context.kind === 'todo' ? work.getTodo(context.id) : null;
  const ask = work.getAsk(todo?.askId ?? context.id);
  if (!ask || (context.kind === 'todo' && !todo)) return null;
  const ref = todo ? new NeoTodoSessionRepository(db).readRef(todo.id) : null;
  if (ref && (ref.adapter !== 'hyperneo' || ref.daemon)) return null;
  const workerSessionId = ref?.id ?? null;
  const session = db
    .prepare('SELECT workspace_path FROM sessions WHERE id = ?')
    .get(workerSessionId ?? ask.sessionId) as { workspace_path: string | null } | null;
  return {
    context,
    daemonId,
    neoSessionId: ask.sessionId,
    workerSessionId,
    workspacePath: session?.workspace_path ?? null,
    approvedEvidenceRoots: [],
  };
}
