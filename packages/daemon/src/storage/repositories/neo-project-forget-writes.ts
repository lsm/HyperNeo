import type { OperationCaller } from '../../lib/operations/registry.ts';
import { runNeoProjectForget } from '../../lib/neo/project-forget-operation.ts';
import { unwatchCodingRepos } from '../../lib/neo/packs/coding/watched-repos.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';
import { SessionRepository } from './session-repository.ts';

class NeoProjectForgetCommands {
  constructor(private readonly db: Database) {}

  forget(projectId: string, caller: OperationCaller, removeHistory: boolean) {
    const repo = new NeoRepository(this.db);
    return runNeoProjectForget(
      projectId,
      caller,
      repo,
      (repos) => unwatchCodingRepos(this.db, repos, repo.allRepositories()),
      removeHistory
    );
  }
}

export const neoProjectForgetWrites = defineRepositoryOp(
  'neo.project.forget',
  'write',
  NeoProjectForgetCommands,
  ['forget']
);

class ProjectSessionPathsReader {
  constructor(private readonly db: Database) {}
  list(machine: string) {
    const repo = new NeoRepository(this.db);
    const projects = repo.listProjects();
    const folders = repo.projectMerges.localFolders(machine);
    return {
      rows: new SessionRepository(this.db).listSessions({ workspacePaths: true }),
      unknown: projects
        .filter((project) =>
          repo.projectWorkIsUnknown(
            project.id,
            machine,
            folders.some((folder) => folder.projectId === project.id),
            projects
          )
        )
        .map((project) => project.id),
    };
  }
}

export const projectSessionPathsReads = defineRepositoryOp(
  'neo.project.session-paths',
  'read',
  ProjectSessionPathsReader,
  ['list']
);
