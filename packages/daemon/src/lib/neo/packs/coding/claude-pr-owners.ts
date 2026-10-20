import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeSessionPrReader } from '../../../drivers/claude-session-prs.ts';
import { readWorkspaceIdentity } from '../../../drivers/code-identity.ts';
import type { NeoSessionFacts } from '../types.ts';
import { codingPrKey } from './todo-prs.ts';

export function createCodingClaudeOwnerReader(
  sessionsDir = join(homedir(), 'Library/Application Support/Claude/claude-code-sessions'),
  projectsDir = join(homedir(), '.claude/projects'),
  identity = readWorkspaceIdentity
) {
  const read = createClaudeSessionPrReader(sessionsDir, projectsDir);
  return async (): Promise<NeoSessionFacts[]> => {
    const sessions: NeoSessionFacts[] = [];
    for (const { record, createdPrs, ...links } of await read()) {
      const created = new Set(createdPrs.flatMap((url) => codingPrKey(url) ?? []));
      const linkedPrs = (links.linkedPrs ?? []).map((pr) => ({
        ...pr,
        ...(!pr.dismissed && created.has(codingPrKey(pr.url) ?? '') ? { own: true as const } : {}),
      }));
      for (const url of created)
        if (!linkedPrs.some((pr) => codingPrKey(pr.url) === url))
          linkedPrs.push({ url, own: true });
      const folder = record.cwd ?? record.originCwd;
      sessions.push({
        ref: { adapter: 'claude-desktop', id: record.sessionId },
        status: record.isArchived ? 'stopped' : 'done',
        lastActivityAt: record.lastActivityAt,
        ...(folder ? { folder } : {}),
        remotes: folder ? ((await identity(folder)).remotes ?? []) : [],
        branches: links.branches ?? [],
        ...(links.linkedPrs || created.size ? { linkedPrs, linkedPrsWindow: true as const } : {}),
        openedPrs: createdPrs,
      });
    }
    return sessions;
  };
}
