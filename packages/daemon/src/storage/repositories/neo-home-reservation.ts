import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';

class NeoHomeReservation {
  constructor(private readonly db: Database) {}

  reserve() {
    let changed = false;
    const projects = new NeoRepository(this.db, () => {
      changed = true;
    });
    const reserved = projects.listProjects().map((project) => ({
      id: project.id,
      homePath: projects.ensureHomePath(project),
    }));
    return { projects: reserved, changed };
  }
}

export const reserveNeoHomeProjects = defineRepositoryOp(
  'neo.home.reserveProjects',
  'write',
  NeoHomeReservation,
  ['reserve']
);
