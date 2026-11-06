import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { findGitHubWatchedRepo } from './github-watched-repo-lookups.ts';

export const gitHubWatchedRepoRead = defineDbOp({
  name: 'github.watched.lookup.read',
  mode: 'read',
  run: (db: Database, input: { spaceId: string; owner: string; repo: string }) =>
    findGitHubWatchedRepo(db, input.spaceId, input.owner, input.repo),
});
