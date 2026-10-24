import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { ArtifactContext, ArtifactContextBinding } from './file-policy.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OWN_THREADS, withCodexState } from '../../storage/codex-desktop-read.ts';

function codexWorkspace(id: string, home: string): string | null {
  try {
    return withCodexState(join(home, '.codex', 'state_5.sqlite'), (db) => {
      const row = db.prepare(`SELECT cwd FROM threads WHERE id = ? AND ${OWN_THREADS}`).get(id) as {
        cwd: string;
      } | null;
      return row?.cwd ?? null;
    });
  } catch {
    return null;
  }
}

export function loadRegistrationBinding(
  db: Database,
  daemonId: string,
  context: ArtifactContext,
  home = homedir()
): ArtifactContextBinding | null {
  const work = new NeoAskTodoRepository(db);
  const todo = context.kind === 'todo' ? work.getTodo(context.id) : null;
  const ask = work.getAsk(todo?.askId ?? context.id);
  if (!ask || (context.kind === 'todo' && !todo)) return null;
  const ref = todo ? new NeoTodoSessionRepository(db).readRef(todo.id) : null;
  if (ref?.daemon || (ref && !['hyperneo', 'codex-desktop'].includes(ref.adapter))) return null;
  if (ref?.adapter === 'codex-desktop') {
    const workspacePath = codexWorkspace(ref.id, home);
    return workspacePath
      ? {
          context,
          daemonId,
          neoSessionId: ask.sessionId,
          workerSessionId: `${ref.adapter}:${ref.id}`,
          workerRef: { adapter: ref.adapter, id: ref.id },
          workspacePath,
          approvedEvidenceRoots: [],
        }
      : null;
  }
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
