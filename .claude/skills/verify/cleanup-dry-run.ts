import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { NEO_INBOX_ID } from '../../../packages/daemon/src/lib/neo/inbox.ts';
import { planNeoProjectCleanup } from '../../../packages/daemon/src/lib/neo/project-cleanup.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';

const db = new Database(process.argv[2] ?? join(homedir(), '.hyperneo/data/daemon.db'), {
  readonly: true,
});
const repo = new NeoRepository(db);
const facts = repo.projectCleanupFacts();
const plan = planNeoProjectCleanup(facts, {
  pinned: new Set([NEO_INBOX_ID]),
  machine: hostname(),
  mirrored: new Set(),
});
console.log(
  `${hostname()}: ${facts.length} projects, ${repo.projectMerges.redirects().length} past merges, ${plan.length} cleanup steps`
);
for (const step of plan)
  console.log(
    step.action === 'merge'
      ? `merge ${step.projectId} (${step.title}) into ${step.targetId}, only with apply: true`
      : `delete ${step.projectId} (${step.title})`
  );
db.close();
