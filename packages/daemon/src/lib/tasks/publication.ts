import superpipe, { type PipelineAPI } from 'superpipe';

export function requireDraftTask(
  status: string | undefined
): { value: 'publish' } | { reason: 'not_draft' } {
  return status === 'draft' ? { value: 'publish' } : { reason: 'not_draft' };
}

export const decideTaskPublication = (superpipe({})('decide-task-publication') as PipelineAPI)
  .input('status')
  .pipe(requireDraftTask, 'status', 'result:publication')
  .end('publication') as (status: string | undefined) => 'publish' | 'not_draft';
