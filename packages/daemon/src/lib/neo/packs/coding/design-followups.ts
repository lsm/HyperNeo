import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { codingDesignFollowupReads } from './design-followup-worker.ts';
import type { CodingTodoPrRepository } from './todo-prs.ts';
import type { NeoWorkPrReader } from './work-prs.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

export async function wakeCodingDesignFollowups(
  db: Database,
  todos: CodingTodoPrRepository,
  readPrs: NeoWorkPrReader,
  wake: CodingSweepDeps['wake'],
  now: number
): Promise<void> {
  const gateway = gatewayFor(db);
  for (const row of await gateway.call(codingDesignFollowupReads, 'candidates')) {
    const saved = JSON.parse(row.prs) as NeoWorkPr[];
    const missing = saved.filter((pr) => pr.state === 'MERGED' && !pr.files);
    if (!missing.length) continue;
    const read = await readPrs(missing.map((pr) => pr.url));
    if (read)
      await todos.write(
        'record',
        row.todoId,
        saved.map((pr) => read.find((fresh) => fresh.url === pr.url) ?? pr),
        now
      );
  }
  for (const row of await gateway.call(codingDesignFollowupReads, 'gaps')) {
    await wake(
      `neo-design-followup:${row.askId}:${row.todoId}:${row.head ?? row.url}`,
      `Merged design ${row.url} (${row.files.join(', ')}) has no later todo in ask "${row.title}" (${row.askId}). Read its Change section and create the follow-up PR todos on this ask, chained with after. Keep the ask open until implementation is accounted for.`
    );
  }
}
