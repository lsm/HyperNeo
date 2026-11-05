import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import type { NeoProjectInput, NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { isLocalUser } from '../operations/caller.ts';
import type { OperationCaller } from '../operations/registry.ts';

export type NeoProjectSaveRequest = Omit<NeoProjectInput, 'id'> & {
  id?: string;
  expectedRevision: number;
};
type Failure = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Failure };

export function requireNeoProjectSaveId(
  input: Pick<NeoProjectSaveRequest, 'id' | 'expectedRevision'>,
  caller: OperationCaller
): Gate<OperationCaller> {
  if (input.id && input.expectedRevision === 0)
    return {
      reason: {
        ok: false,
        reason: 'Omit id to create a project; the daemon assigns its id and returns it.',
      },
    };
  if (!input.id && input.expectedRevision > 0)
    return { reason: { ok: false, reason: 'Pass the id of the project you are updating.' } };
  return { value: caller };
}

export const saveNeoProjectCommand = (superpipe({})('neo.project.save') as PipelineAPI)
  .input(['input', 'caller', 'repo'])
  .pipe(
    (caller: OperationCaller, repo: NeoRepository): Gate<OperationCaller> => {
      if (isLocalUser(caller)) return { value: caller };
      const binding = caller.sessionId ? repo.getBindingBySession(caller.sessionId) : null;
      return caller.source === 'mcp' && binding?.kind === 'neo'
        ? { value: caller }
        : { reason: { ok: false, reason: 'This operation belongs to Neo.' } };
    },
    ['caller', 'repo'],
    'result:admission'
  )
  .pipe(requireNeoProjectSaveId, ['input', 'admission'], 'result:admission')
  .pipe(
    (input: NeoProjectSaveRequest) => ({ ...input, id: input.id ?? crypto.randomUUID() }),
    ['input', 'admission'],
    'request'
  )
  .pipe(
    (
      input: NeoProjectSaveRequest,
      request: NeoProjectSaveRequest & { id: string },
      caller: OperationCaller,
      repo: NeoRepository
    ) => {
      const created = input.id ? null : repo.getProject(request.id);
      return created ? { reason: { ok: true as const, project: created } } : { value: caller };
    },
    ['input', 'request', 'admission', 'repo'],
    'result:admission'
  )
  .pipe(
    (input: NeoProjectSaveRequest & { id: string }, repo: NeoRepository) => {
      const project = repo.saveProject(input, input.expectedRevision);
      return project
        ? { ok: true as const, project }
        : {
            ok: false as const,
            reason: 'superseded: read the current project before saving again',
          };
    },
    ['request', 'repo'],
    'admission'
  )
  .end('admission') as (
  input: NeoProjectSaveRequest,
  caller: OperationCaller,
  repo: NeoRepository
) => Failure | { ok: true; project: NeoProject };
