import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';

type Action = 'neo.project.move' | 'neo.project.section';
type Result = { ok: true; projectId?: string } | { ok: false; reason: string };

export function requireNeoTreeMutation(result: Result): { value: Result } | { reason: Result } {
  return result.ok ? { value: result } : { reason: result };
}

export const mutateNeoProjectTree = (superpipe({})('neo-project-tree-mutation') as PipelineAPI)
  .input(['action', 'input', 'refresh'])
  .pipe(() => connectionManager.getHub(), 'action', 'hub')
  .pipe(invokeOperation<Result>, ['hub', 'action', 'input'], 'result')
  .pipe(requireNeoTreeMutation, 'result', 'result:outcome')
  .pipe((refresh: () => Promise<void>) => refresh(), 'refresh', 'refreshed')
  .endAsync('outcome') as (
  action: Action,
  input: unknown,
  refresh: () => Promise<void>
) => Promise<Result>;
