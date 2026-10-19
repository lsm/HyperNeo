import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

export const NEO_INBOX_ID = 'inbox';
const NEO_INBOX_SUMMARY = 'Self-contained one-off questions that need no continuing project.';

export async function openNeoDefaultSession(
  repo: Pick<NeoRepository, 'saveProject'>,
  open: () => Promise<string>
): Promise<string> {
  repo.saveProject(
    { id: NEO_INBOX_ID, title: 'Inbox', summary: NEO_INBOX_SUMMARY, context: '' },
    0
  );
  return open();
}
