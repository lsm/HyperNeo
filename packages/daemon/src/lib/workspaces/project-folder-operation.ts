import { basename } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { WorkspaceHistoryRepository } from '../../storage/repositories/workspace-history-repository.ts';
import { defineOperation } from '../operations/registry.ts';
import { normalizeWorkspacePath, validateWorkspaceDirectory } from '../workspace-path.ts';

const Input = z.object({ projectPath: z.string().trim().min(1), path: z.string().trim().min(1) });
const Rejected = z.object({ accepted: z.literal(false), reason: z.string() });
type Plan = { projectPath: string; path: string; name: string };

async function validateFolders(
  input: z.infer<typeof Input>,
  repository: WorkspaceHistoryRepository
) {
  try {
    const normalized = normalizeWorkspacePath(input.projectPath);
    const known = repository.projects().some((project) => project.folders.includes(normalized));
    const [projectPath, path] = await Promise.all([
      known ? normalized : validateWorkspaceDirectory(normalized),
      validateWorkspaceDirectory(input.path),
    ]);
    return { value: { projectPath, path, name: basename(projectPath) || projectPath } };
  } catch (error) {
    return { reason: { accepted: false as const, reason: String(error) } };
  }
}

const addProjectFolder = (superpipe({})('workspace-project-add-folder') as PipelineAPI)
  .input(['input', 'repository'])
  .pipe(validateFolders, ['input', 'repository'], 'result:result')
  .pipe(
    (plan: Plan, repository: WorkspaceHistoryRepository) =>
      repository.addProjectFolder(plan.projectPath, plan.path, plan.name)
        ? { accepted: true as const }
        : { accepted: false as const, reason: 'Folder already belongs to another project.' },
    ['result', 'repository'],
    'result'
  )
  .endAsync('result') as (
  input: z.infer<typeof Input>,
  repository: WorkspaceHistoryRepository
) => Promise<{ accepted: true } | z.infer<typeof Rejected>>;

export function createProjectFolderOperation(repository: WorkspaceHistoryRepository) {
  return defineOperation({
    name: 'work.project.addFolder',
    description:
      'Add a folder to the HyperNeo project containing projectPath. Creates a project for a previously standalone folder. Refuses to move a folder out of another project.',
    inputSchema: Input,
    resultSchema: z.union([z.object({ accepted: z.literal(true) }), Rejected]),
    policy: { safetyClass: 'mutate' },
    execute: (input) => addProjectFolder(input, repository),
  });
}
