import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { runLagPhase } from '../event-loop-activity.ts';

const worktreeProjects = new Map<string, { stamp: string; project: Promise<string> }>();

export async function gitWorktreeProject(folder: string): Promise<string> {
  try {
    const path = join(folder, '.git');
    const info = await runLagPhase('scanner:worktree:metadata', () => stat(path));
    if (info.isDirectory())
      return readFile(join(path, 'hyperneo-source-checkout'), 'utf8')
        .then((source) => source.trim() || folder)
        .catch(() => folder);
    const stamp = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    const cached = worktreeProjects.get(folder);
    if (cached?.stamp === stamp) return cached.project;
    const project = runLagPhase('scanner:worktree:read', () => readFile(path, 'utf8'))
      .then((text) => {
        const pointer = text.match(/^gitdir:\s*(.+)$/m)?.[1];
        const at = pointer?.trim().lastIndexOf('/.git/worktrees/') ?? -1;
        return pointer && at > 0 ? pointer.trim().slice(0, at) : folder;
      })
      .catch(() => {
        if (worktreeProjects.get(folder)?.project === project) worktreeProjects.delete(folder);
        return folder;
      });
    worktreeProjects.set(folder, { stamp, project });
    return project;
  } catch {
    worktreeProjects.delete(folder);
    return folder;
  }
}
