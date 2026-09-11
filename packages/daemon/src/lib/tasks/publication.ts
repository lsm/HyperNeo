import superpipe, { type PipelineAPI } from 'superpipe';

export function requireDraftTask(
  status: string | undefined
): { value: 'publish' } | { reason: 'not_draft' } {
  return status === 'draft' ? { value: 'publish' } : { reason: 'not_draft' };
}

export const publishTask = (superpipe({})('publish-task') as PipelineAPI)
  .input(['readStatus', 'publish'])
  .pipe((readStatus: () => Promise<string | undefined>) => readStatus(), 'readStatus', 'status')
  .pipe(requireDraftTask, 'status', 'result:task')
  .pipe((publish: () => Promise<unknown>) => publish(), 'publish', 'task')
  .endAsync('task') as <T>(
  readStatus: () => Promise<string | undefined>,
  publish: () => Promise<T>
) => Promise<T | 'not_draft'>;
