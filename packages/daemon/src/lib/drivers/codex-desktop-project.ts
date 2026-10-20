import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { SpawnFn } from '../runtime-spawn/index.ts';

export function codexDesktopProject(
  state: {
    'local-projects'?: Record<string, { rootPaths?: string[] }>;
    'app-server-project-id-by-legacy-project-id-by-host'?: Record<string, Record<string, string>>;
  },
  folder: string,
  codexHome: string
): string | undefined {
  const project = Object.entries(state['local-projects'] ?? {}).find(([, project]) =>
    project.rootPaths?.some((root) => resolve(root) === resolve(folder))
  );
  return project
    ? state['app-server-project-id-by-legacy-project-id-by-host']?.[`local:${codexHome}`]?.[
        project[0]
      ]
    : undefined;
}

export async function ensureCodexDesktopProject(
  folder: string,
  codexHome: string,
  spawn: SpawnFn
): Promise<string> {
  const root = realpathSync(folder);
  const readProject = () => {
    try {
      return codexDesktopProject(
        JSON.parse(readFileSync(join(codexHome, '.codex-global-state.json'), 'utf8')),
        root,
        codexHome
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const existing = readProject();
  if (existing) return existing;
  const launcher = spawn(
    ['open', '-g', `codex://threads/new?${new URLSearchParams({ path: root })}`],
    { stdout: 'ignore', stderr: 'pipe' }
  );
  const timer = setTimeout(() => launcher.kill(), 30_000);
  try {
    const [code, stderr] = await Promise.all([
      launcher.exited,
      new Response(launcher.stderr).text(),
    ]);
    if (code !== 0) throw new Error(stderr.trim() || 'Could not register the Codex project.');
  } finally {
    clearTimeout(timer);
  }
  const deadline = Date.now() + 30_000;
  do {
    const projectId = readProject();
    if (projectId) return projectId;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw new Error(
    `Codex Desktop has not registered ${root}. Check its project folder confirmation before retrying.`
  );
}
