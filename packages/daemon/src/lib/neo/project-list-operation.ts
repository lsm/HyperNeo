import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { defineOperation } from '../operations/registry.ts';
import type { NeoRepository } from '../../storage/repositories/neo-repository.ts';

type ListRepo = Pick<NeoRepository, 'listProjects' | 'projectMerges' | 'projectWorkFactsAsync'>;
type LocalFolder = { projectId: string; folder: string };

const ListedProject = z.object({
  id: z.string(),
  name: z.string(),
  folders: z.array(z.string()),
  updatedAt: z.number(),
  hasSessions: z.boolean(),
  unknownWork: z.boolean(),
});
const Result = z.object({ projects: z.array(ListedProject) });
type Listed = z.infer<typeof Result>;

export function listNeoProjects(
  projects: readonly NeoProject[],
  folders: readonly LocalFolder[],
  busy: ReadonlySet<string> = new Set(),
  unknown: ReadonlySet<string> = new Set()
): Listed {
  return {
    projects: projects.map((project) => ({
      id: project.id,
      name: project.title,
      folders: folders.filter((entry) => entry.projectId === project.id).map((e) => e.folder),
      updatedAt: project.updatedAt,
      hasSessions: busy.has(project.id),
      unknownWork: unknown.has(project.id),
    })),
  };
}

const runNeoProjectList = (superpipe({})('neo.projects.list') as PipelineAPI)
  .input(['repo', 'machine'])
  .pipe((repo: ListRepo) => repo.listProjects(), 'repo', 'projects')
  .pipe(
    (repo: ListRepo, machine: string) => repo.projectMerges.localFolders(machine),
    ['repo', 'machine'],
    'folders'
  )
  .pipe(
    (repo: ListRepo, machine: string) => repo.projectWorkFactsAsync(machine),
    ['repo', 'machine'],
    'facts'
  )
  .pipe(
    (facts: { paths: Set<string> }, folders: readonly LocalFolder[]) =>
      new Set(
        folders.filter((entry) => facts.paths.has(entry.folder)).map((entry) => entry.projectId)
      ),
    ['facts', 'folders'],
    'busy'
  )
  .pipe((facts: { unknown: Set<string> }) => facts.unknown, 'facts', 'unknown')
  .pipe(listNeoProjects, ['projects', 'folders', 'busy', 'unknown'], 'listed')
  .endAsync('listed') as (repo: ListRepo, machine: string) => Promise<Listed>;

export function createNeoProjectListOperation(repo: ListRepo, machine: () => string) {
  return defineOperation({
    name: 'neo.projects.list',
    description:
      'List every project with its folders on this machine, including projects that have no chats.',
    inputSchema: z.object({}),
    resultSchema: Result,
    policy: { safetyClass: 'human_only' },
    execute: async () => runNeoProjectList(repo, machine()),
  });
}
