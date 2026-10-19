import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

export const NEO_INBOX_ID = 'inbox';
const NEO_INBOX_SUMMARY = 'Self-contained one-off questions that need no continuing project.';

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
