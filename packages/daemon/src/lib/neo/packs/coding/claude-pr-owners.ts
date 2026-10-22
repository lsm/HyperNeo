import { homedir } from 'node:os';
import { join } from 'node:path';
import { createClaudeSessionPrReader } from '../../../drivers/claude-session-prs.ts';
import { readWorkspaceIdentity } from '../../../drivers/code-identity.ts';
import type { NeoSessionFacts } from '../../pack-contract.ts';
import { codingPrKey } from './todo-prs.ts';

export function createCodingClaudeOwnerReader(
  sessionsDir = join(homedir(), 'Library/Application Support/Claude/claude-code-sessions'),
  projectsDir = join(homedir(), '.claude/projects'),
  identity = readWorkspaceIdentity
) {
  const read = createClaudeSessionPrReader(sessionsDir, projectsDir);
  const remotes = new Map<string, string[]>();
  return async (): Promise<NeoSessionFacts[]> => {
    const sessions: NeoSessionFacts[] = [];
    const present = new Set<string>();
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
      if (folder) {
        present.add(folder);
        if (!remotes.has(folder)) remotes.set(folder, (await identity(folder)).remotes ?? []);
      }
      sessions.push({
        ref: { adapter: 'claude-desktop', id: record.sessionId },
        status: record.isArchived ? 'stopped' : 'done',
        lastActivityAt: record.lastActivityAt,
        ...(folder ? { folder } : {}),
        remotes: folder ? remotes.get(folder)! : [],
        branches: links.branches ?? [],
        ...(links.linkedPrs ? { linkedPrs, linkedPrsWindow: true as const } : {}),
        openedPrs: createdPrs,
      });
    }
    for (const folder of remotes.keys()) if (!present.has(folder)) remotes.delete(folder);
    return sessions;
  };
}
