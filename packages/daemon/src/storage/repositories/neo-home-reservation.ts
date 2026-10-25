import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';

export const reserveNeoHomeProjects = defineDbOp({
  name: 'neo.home.reserveProjects',
  mode: 'write',
  run: (db: Database) => {
    let changed = false;
    const projects = new NeoRepository(db, () => {
      changed = true;
    });
    const reserved = projects.listProjects().map((project) => ({
      id: project.id,
      homePath: projects.ensureHomePath(project),
    }));
    return { projects: reserved, changed };
  },
});
