import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

export const NEO_INBOX_ID = 'inbox';
const NEO_INBOX_SUMMARY = 'Self-contained one-off questions that need no continuing project.';
const PROJECT_SUMMARY_CHARS = 160;
const NEW_PROJECT_TITLE_CHARS = 60;

export interface NeoHolder {
  parentId?: string | null;
  ancestorIds?: readonly string[];
  projectId: string;
  sessionId: string;
  title: string;
  summary: string;
  repository?: string;
  provider?: string;
}

export function neoNewProject(
  target: string,
  id: string
): { id: string; title: string; summary: string } {
  const line = target.trim().replace(/\s+/g, ' ');
  return {
    id,
    title:
      line.length <= NEW_PROJECT_TITLE_CHARS
        ? line
        : `${line.slice(0, NEW_PROJECT_TITLE_CHARS - 1).trimEnd()}…`,
    summary: neoExcerpt(target.trim(), PROJECT_SUMMARY_CHARS),
  };
}

function neoExcerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const head = Math.ceil((max - 1) / 2);
  return `${flat.slice(0, head)}…${flat.slice(flat.length - (max - 1 - head))}`;
}

export async function openNeoNewProject(
  repo: Pick<NeoRepository, 'saveProject' | 'getProject' | 'discardUnopenedProject'>,
  openHolder: (projectId: string) => Promise<string>,
  project: { id: string; title: string; summary: string }
): Promise<NeoHolder | null> {
  const saved = repo.saveProject({ ...project, context: '' }, 0) ?? repo.getProject(project.id);
  if (!saved) return null;
  try {
    const sessionId = await openHolder(saved.id);
    return { projectId: saved.id, sessionId, title: saved.title, summary: saved.summary };
  } catch {
    repo.discardUnopenedProject(saved.id);
    return null;
  }
}

export async function openNeoDefaultSession(
  repo: Pick<NeoRepository, 'saveProject'>,
  openHolder: (projectId: string) => Promise<string>
): Promise<NeoHolder> {
  repo.saveProject(
    { id: NEO_INBOX_ID, title: 'Inbox', summary: NEO_INBOX_SUMMARY, context: '' },
    0
  );
  return {
    projectId: NEO_INBOX_ID,
    sessionId: await openHolder(NEO_INBOX_ID),
    title: 'Inbox',
    summary: NEO_INBOX_SUMMARY,
  };
}
