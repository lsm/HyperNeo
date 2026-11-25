import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { CodexAppServer } from './codex-app-server.ts';

interface CodexProjectPage {
  data?: { id: string; roots?: { path: string }[] }[];
  nextCursor?: string | null;
}

export async function ensureCodexDesktopProject(
  folder: string,
  server: Pick<CodexAppServer, 'call'>
): Promise<string> {
  const root = realpathSync(folder);
  const matches = (path: string) => resolve(path) === root || resolve(path) === resolve(folder);
  let cursor: string | null | undefined;
  do {
    const page = (await server.call('project/list', cursor ? { cursor } : {})) as CodexProjectPage;
    const project = page.data?.find((candidate) =>
      candidate.roots?.some(({ path }) => matches(path))
    );
    if (project) return project.id;
    cursor = page.nextCursor;
  } while (cursor);
  const created = (await server.call('project/create', {
    idempotencyKey: `hyperneo:${root}`,
    name: basename(root),
    roots: [{ path: root }],
  })) as { project?: { id?: string } };
  if (!created.project?.id) throw new Error(`Codex did not create a project for ${root}.`);
  return created.project.id;
}
