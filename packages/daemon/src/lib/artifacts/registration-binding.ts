import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../storage/repositories/neo-todo-session-repository.ts';
import type { ArtifactContext, ArtifactContextBinding } from './file-policy.ts';
import { homedir } from 'node:os';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { codexStatePath, OWN_THREADS, withCodexState } from '../../storage/codex-desktop-read.ts';
import { claudeTranscriptCwd } from '../drivers/claude-feed.ts';

const NATIVE_ADAPTERS = ['hyperneo', 'codex-desktop', 'claude-desktop', 'claude-code'];
const CLAUDE_DESKTOP_SESSIONS = 'Library/Application Support/Claude/claude-code-sessions';
const TRANSCRIPT_HEAD_BYTES = 64 * 1024;

function codexWorkspace(id: string, home: string): string | null {
  try {
    return withCodexState(
      codexStatePath(home),
      (db) => {
        const row = db
          .prepare(`SELECT cwd FROM threads WHERE id = ? AND ${OWN_THREADS}`)
          .get(id) as {
          cwd: string;
        } | null;
        return row?.cwd ?? null;
      },
      0
    );
  } catch {
    return null;
  }
}

function subfolders(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function claudeDesktopWorkspace(id: string, home: string): string | null {
  if (!/^local_[\w-]+$/.test(id)) return null;
  const file = subfolders(join(home, CLAUDE_DESKTOP_SESSIONS))
    .flatMap(subfolders)
    .map((scope) => join(scope, `${id}.json`))
    .find((path) => existsSync(path));
  try {
    const record = file
      ? (JSON.parse(readFileSync(file, 'utf8')) as {
          sessionId?: unknown;
          cwd?: string;
          originCwd?: string;
        })
      : null;
    return record?.sessionId === id ? (record.cwd ?? record.originCwd ?? null) : null;
  } catch {
    return null;
  }
}

function claudeCodeWorkspace(id: string, home: string): string | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const file = subfolders(join(home, '.claude', 'projects'))
    .map((project) => join(project, `${id}.jsonl`))
    .find((path) => existsSync(path));
  if (!file) return null;
  const head = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(file, 'r');
    return (
      claudeTranscriptCwd(head.toString('utf8', 0, readSync(fd, head, 0, head.length, 0))) || null
    );
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

const nativeWorkspace: Record<string, (id: string, home: string) => string | null> = {
  'codex-desktop': codexWorkspace,
  'claude-desktop': claudeDesktopWorkspace,
  'claude-code': claudeCodeWorkspace,
};

export function loadArtifactOwnershipBinding(
  db: Database,
  daemonId: string,
  context: ArtifactContext
): ArtifactContextBinding | null {
  const work = new NeoAskTodoRepository(db);
  const todo = context.kind === 'todo' ? work.getTodo(context.id) : null;
  const ask = work.getAsk(todo?.askId ?? context.id);
  if (!ask || (context.kind === 'todo' && !todo)) return null;
  const ref = todo ? new NeoTodoSessionRepository(db).readRef(todo.id) : null;
  if (ref?.daemon || (ref && !NATIVE_ADAPTERS.includes(ref.adapter))) return null;
  if (ref && ref.adapter !== 'hyperneo') {
    return {
      context,
      daemonId,
      neoSessionId: ask.sessionId,
      workerSessionId: `${ref.adapter}:${ref.id}`,
      workerRef: { adapter: ref.adapter, id: ref.id },
      workspacePath: null,
      approvedEvidenceRoots: [],
    };
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

export function loadRegistrationBinding(
  db: Database,
  daemonId: string,
  context: ArtifactContext,
  home = homedir()
): ArtifactContextBinding | null {
  const binding = loadArtifactOwnershipBinding(db, daemonId, context);
  if (!binding?.workerRef) return binding;
  const workspacePath = nativeWorkspace[binding.workerRef.adapter]?.(binding.workerRef.id, home);
  return { ...binding, workspacePath: workspacePath ?? null };
}
