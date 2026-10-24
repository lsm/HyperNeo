import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../storage/sqlite-compat.ts';
import type { SessionEventSubscriptionRepository } from '../../../storage/repositories/session-event-subscription-repository.ts';
import { githubRepoOfTopic } from '../subscription-operations.ts';
import type { GitHubWatchedRepo } from './github-repository.ts';
import { deliverCodingHealth } from '../../neo/packs/coding/health-delivery.ts';
import type { CodingPrLedgerRepository } from '../../neo/packs/coding/pr-ledger.ts';

type Repo = { owner: string; repo: string };

export class GitHubWatchInventory {
  constructor(
    private readonly db: Database,
    private readonly subscriptions: SessionEventSubscriptionRepository
  ) {}

  list(): Repo[] {
    const todos = this.db
      .prepare(`SELECT DISTINCT coalesce(t.repo, a.repo) AS repo
      FROM neo_todos t JOIN neo_asks a ON a.id = t.ask_id
      WHERE a.status = 'open' AND t.state IN ('todo', 'doing', 'blocked')
        AND json_extract(t.check_json, '$.pack') = 'coding'`)
      .all() as { repo: string | null }[];
    const candidates = [
      ...this.subscriptions.listAll().map((sub) => githubRepoOfTopic(sub.topic)),
      ...todos.map((row) =>
        row.repo && /^[\w.-]+\/[\w.-]+$/.test(row.repo)
          ? githubRepoOfTopic(`github/${row.repo}/`)
          : null
      ),
    ];
    return [
      ...new Map(
        candidates
          .filter((repo): repo is Repo => repo !== null)
          .map((repo) => [`${repo.owner}/${repo.repo}`.toLowerCase(), repo])
      ).values(),
    ];
  }

  references(owner: string, repo: string): boolean {
    return this.list().some(
      (row) =>
        row.owner.toLowerCase() === owner.toLowerCase() &&
        row.repo.toLowerCase() === repo.toLowerCase()
    );
  }
}

export const reportGitHubWatchHealth = (superpipe({})('github-watch-health') as PipelineAPI)
  .input(['ledger', 'repos', 'reached', 'wake', 'now'])
  .pipe(
    async (
      ledger: CodingPrLedgerRepository,
      repos: GitHubWatchedRepo[],
      reached: Set<string>,
      now: number
    ) => {
      const groups = new Map<string, boolean>();
      for (const repo of repos) {
        const key = `polling:${repo.owner}/${repo.repo}`.toLowerCase();
        groups.set(key, (groups.get(key) ?? true) && reached.has(repo.id));
      }
      for (const [key, complete] of groups)
        await ledger.write('recordHealth', key, {
          at: now,
          outcome: complete ? 'complete' : 'not_reached',
        });
      return [...groups.keys()];
    },
    ['ledger', 'repos', 'reached', 'now'],
    'keys'
  )
  .pipe(deliverCodingHealth, ['ledger', 'keys', 'wake', 'now'])
  .endAsync() as (
  ledger: CodingPrLedgerRepository,
  repos: GitHubWatchedRepo[],
  reached: Set<string>,
  wake: (key: string, text: string) => Promise<boolean>,
  now: number
) => Promise<void>;
