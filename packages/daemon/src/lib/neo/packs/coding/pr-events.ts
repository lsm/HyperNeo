import type { WorkRef } from '../../../drivers/types.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { CodingPrTransition } from './pr-ledger.ts';
import type { CodingSweepDeps } from './pr-sweep.ts';

const head = (row: CodingPrTransition) => row.head.slice(0, 7);
const pr = (row: CodingPrTransition) => `${row.repo}#${row.number} "${row.title}"`;

export function planCodingPrEvent(row: CodingPrTransition): { key: string; text: string } | null {
  const owner = (text: string) => ({
    key: `neo-pr-event:${row.repo}#${row.number}:${row.head}:${row.state}`,
    text: `${pr(row)} ${text}`,
  });
  if (row.state === 'failing')
    return owner(`has failing CI on head ${head(row)}. Fix it and push.`);
  if (row.state === 'changes_requested')
    return owner(`has requested changes on head ${head(row)}. Address the review and push.`);
  if (row.state === 'dirty')
    return owner('now conflicts with its base. Merge the base branch in and push.');
  if (row.state === 'approved_green')
    return owner(
      `is approved and green on head ${head(row)}. Merge it now with a manual squash on this head.`
    );
  if (row.from === 'failing' && row.state !== 'merged' && row.state !== 'closed')
    return owner(`has green CI again on head ${head(row)}.`);
  return null;
}

export class CodingPrEventRepository {
  constructor(private readonly db: Database) {}

  route(row: CodingPrTransition): { owner: WorkRef | null; claimed: boolean } {
    const found = this.db
      .prepare(
        `SELECT owner, EXISTS (SELECT 1 FROM pack_coding_pr_claims c
                 WHERE c.url = 'https://github.com/' || l.repo || '/pull/' || l.number) AS claimed
           FROM pack_coding_pr_ledger l WHERE l.repo = ? AND l.number = ?`
      )
      .get(row.repo, row.number) as { owner: string | null; claimed: number } | null;
    return {
      owner: found?.owner ? (JSON.parse(found.owner) as WorkRef) : null,
      claimed: !!found?.claimed,
    };
  }
}

export async function deliverCodingPrEvents(
  repo: CodingPrEventRepository,
  transitions: readonly CodingPrTransition[],
  deps: CodingSweepDeps
): Promise<void> {
  for (const row of transitions) {
    const event = planCodingPrEvent(row);
    const route = event ? repo.route(row) : null;
    if (!event || !route?.owner || route.claimed) continue;
    await deps.tell(route.owner, event.key, event.text).catch(() => false);
  }
}
