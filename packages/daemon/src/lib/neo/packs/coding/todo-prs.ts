import superpipe, { type PipelineAPI } from 'superpipe';
import { CodingStageFactsRepository } from './stage-facts.ts';
import { CodingDeliveryFactsRepository } from './delivery-facts.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import type { NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import { neoWorkPrVerdict, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import type { NeoTodoCheckResult, NeoTodoFactJudge, NeoTodoPack } from '../../pack-contract.ts';
import type { CodingPrState } from './pr-ledger.ts';
import { neoStatusLine, type NeoStatusLine } from '../../status-codes.ts';
import { createCodingPackTables } from './schema/coding-tables.ts';
import { neoGitRepo } from '../../todo-repo.ts';
import { extractNeoWorkPrUrls, type NeoWorkPrReader } from './work-prs.ts';
import { planCodingIssuePrClaims } from './issue-pr-claims.ts';
import { NeoAskTodoRepository } from '../../../../storage/repositories/neo-ask-todo-repository.ts';

export type CodingPrClaim = 'named' | 'reported' | 'branch';
export type CodingPrClaimRow = {
  todoId: string;
  url: string;
  claim: CodingPrClaim;
  claimedAt: number;
};
export type CodingTodoWindow = { start: number | null; end: number | null };

export const CODING_TODO_WINDOW_QUERY = `SELECT t.started_at AS start, MIN(next.started_at) AS end
  FROM neo_todos t LEFT JOIN neo_todo_sessions own ON own.todo_id = t.id
  LEFT JOIN neo_todo_sessions other ON other.ref = own.ref AND other.todo_id != t.id
  LEFT JOIN neo_todos next ON next.id = other.todo_id AND next.started_at > t.started_at
  WHERE t.id = ?`;

export function codingPrKey(url: string): string | null {
  const parsed = parsePrUrl(url);
  return parsed
    ? githubUrlKey(`https://${parsed.host}/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`)
    : null;
}

export class CodingTodoPrRepository {
  readonly stageFacts: CodingStageFactsRepository;
  readonly deliveryFacts: CodingDeliveryFactsRepository;

  constructor(private readonly db: Database) {
    this.stageFacts = new CodingStageFactsRepository(db);
    this.deliveryFacts = new CodingDeliveryFactsRepository(db);
  }

  claimClosingIssues(
    rows: readonly { repo: string; number: number; body?: string }[],
    now: number
  ): void {
    const store = new NeoAskTodoRepository(this.db);
    const todos = store.listTodosForAsks(store.listOpenAsks().map((ask) => ask.id));
    for (const row of rows)
      for (const claim of planCodingIssuePrClaims(row.repo, row.number, row.body ?? '', todos))
        this.claim(claim.todoId, [{ url: claim.url, claim: 'branch' }], now, 'additive');
  }

  stages(todoId: string) {
    return this.urls(todoId).flatMap((url) => this.stageFacts.read(url));
  }

  claim(
    todoId: string,
    claims: readonly { url: string; claim: CodingPrClaim }[],
    now: number,
    mode: 'replace-reported' | 'additive' = 'replace-reported'
  ) {
    const keyed = claims.flatMap(({ url, claim }) => {
      const key = codingPrKey(url);
      return key ? [{ key, claim }] : [];
    });
    if (mode === 'replace-reported')
      this.db
        .prepare(
          `DELETE FROM pack_coding_pr_claims WHERE todo_id = ? AND claim = 'reported'
           AND url NOT IN (SELECT value FROM json_each(?))`
        )
        .run(
          todoId,
          JSON.stringify(keyed.filter((item) => item.claim === 'reported').map((item) => item.key))
        );
    const insert = this.db.prepare(
      `INSERT INTO pack_coding_pr_claims (todo_id, url, claim, claimed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(todo_id, url) DO UPDATE SET claim = excluded.claim, claimed_at = excluded.claimed_at
        WHERE (claim = 'branch' AND excluded.claim != 'branch')
           OR (claim = 'reported' AND excluded.claim = 'named')`
    );
    for (const { key, claim } of keyed) insert.run(todoId, key, claim, now);
  }

  write<K extends 'claim' | 'record'>(
    method: K,
    ...args: Parameters<CodingTodoPrRepository[K]>
  ): Promise<void> {
    return gatewayFor(this.db).run(codingTodoPrWrites, { method, args }) as Promise<void>;
  }

  urls(todoId: string): string[] {
    return (
      this.db
        .prepare('SELECT url FROM pack_coding_pr_claims WHERE todo_id = ? ORDER BY claimed_at, url')
        .all(todoId) as { url: string }[]
    ).map((row) => row.url);
  }

  claimsOn(urls: readonly string[]): CodingPrClaimRow[] {
    return this.db
      .prepare(
        `SELECT todo_id AS todoId, url, claim, claimed_at AS claimedAt FROM pack_coding_pr_claims
          WHERE url IN (SELECT value FROM json_each(?))
            AND todo_id NOT IN (SELECT id FROM neo_todos WHERE state = 'removed')`
      )
      .all(JSON.stringify(urls)) as CodingPrClaimRow[];
  }

  window(todoId: string): CodingTodoWindow {
    const row = this.db.prepare(CODING_TODO_WINDOW_QUERY).get(todoId) as CodingTodoWindow | null;
    return row ?? { start: null, end: null };
  }

  readWindow(todoId: string): Promise<CodingTodoWindow> {
    return gatewayFor(this.db).call(codingTodoPrReads, 'window', todoId);
  }

  todosFor(urls: readonly string[]): string[] {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT todo_id AS todoId FROM pack_coding_pr_claims WHERE url IN (SELECT value FROM json_each(?))'
        )
        .all(JSON.stringify(urls.flatMap((url) => codingPrKey(url) ?? []))) as {
        todoId: string;
      }[]
    ).map((row) => row.todoId);
  }

  prs(todoId: string): NeoWorkPr[] {
    const row = this.db
      .prepare('SELECT prs_json AS prs FROM pack_coding_todo_prs WHERE todo_id = ?')
      .get(todoId) as { prs: string } | null;
    return row ? (JSON.parse(row.prs) as NeoWorkPr[]) : [];
  }

  isWaiting(todoId: string): boolean {
    return this.prs(todoId).some((pr) => pr.state === 'OPEN');
  }

  readWaiting(todoId: string): Promise<boolean> {
    return gatewayFor(this.db).call(codingTodoPrReads, 'isWaiting', todoId);
  }

  prsForTodos(ids: readonly string[]): Map<string, NeoWorkPr[]> {
    const rows = this.db
      .prepare(
        `SELECT todo_id AS todoId, prs_json AS prs FROM pack_coding_todo_prs
          WHERE todo_id IN (SELECT value FROM json_each(?))`
      )
      .all(JSON.stringify(ids)) as { todoId: string; prs: string }[];
    return new Map(rows.map((row) => [row.todoId, JSON.parse(row.prs) as NeoWorkPr[]]));
  }

  latest(url: string): { pr: NeoWorkPr; readAt: number } | null {
    const key = codingPrKey(url);
    const rows = this.db
      .prepare(
        `SELECT prs_json AS prs, read_at AS readAt FROM pack_coding_todo_prs WHERE todo_id IN
           (SELECT todo_id FROM pack_coding_pr_claims WHERE url = ?) ORDER BY read_at DESC`
      )
      .all(key) as { prs: string; readAt: number }[];
    for (const row of rows) {
      const pr = (JSON.parse(row.prs) as NeoWorkPr[]).find((item) => codingPrKey(item.url) === key);
      if (pr) return { pr, readAt: row.readAt };
    }
    return null;
  }

  record(todoId: string, prs: readonly NeoWorkPr[], now: number): void {
    for (const pr of prs) if (pr.head) this.stageFacts.observeHead(pr.url, pr.head, now);
    this.db
      .prepare(
        `INSERT INTO pack_coding_todo_prs (todo_id, prs_json, read_at) VALUES (?, ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET prs_json = excluded.prs_json, read_at = excluded.read_at`
      )
      .run(todoId, JSON.stringify(prs), now);
  }
}

export function planCodingTodoClaims(
  todo: Pick<NeoTodo, 'check' | 'startedAt'>,
  report: string | null,
  branchPrs: readonly NeoWorkPr[]
): { url: string; claim: CodingPrClaim }[] {
  const named = todo.check?.params.urls;
  return [
    ...(Array.isArray(named) ? named.filter((url) => typeof url === 'string') : []).map(
      (url: string) => ({ url, claim: 'named' as const })
    ),
    ...extractNeoWorkPrUrls(report).map((url) => ({ url, claim: 'reported' as const })),
    ...branchPrs
      .filter((pr) => todo.startedAt !== null && (pr.createdAt ?? 0) >= todo.startedAt)
      .map((pr) => ({ url: pr.url, claim: 'branch' as const })),
  ];
}

const CLAIM_RANK: Record<CodingPrClaim, number> = { named: 0, reported: 1, branch: 2 };

const outranks = (rival: CodingPrClaimRow, own: CodingPrClaimRow) =>
  CLAIM_RANK[rival.claim] < CLAIM_RANK[own.claim] ||
  (own.claim !== 'branch' &&
    rival.claim === own.claim &&
    (rival.claimedAt < own.claimedAt ||
      (rival.claimedAt === own.claimedAt && rival.todoId < own.todoId)));

const inWindow = (window: CodingTodoWindow, pr: NeoWorkPr) =>
  window.start !== null &&
  pr.createdAt !== undefined &&
  pr.createdAt >= window.start &&
  (window.end === null || pr.createdAt < window.end);

export function codingTodoOwnPrs(
  todo: Pick<NeoTodo, 'id' | 'startedAt'>,
  claims: readonly CodingPrClaimRow[],
  prs: readonly NeoWorkPr[],
  window: CodingTodoWindow
): NeoWorkPr[] {
  const mine = claims.filter(
    (row) =>
      row.todoId === todo.id &&
      !claims.some(
        (rival) => rival.todoId !== todo.id && rival.url === row.url && outranks(rival, row)
      )
  );
  const read = (row: CodingPrClaimRow) =>
    prs.filter((pr) => codingPrKey(pr.url) === row.url).slice(0, 1);
  const answered = mine
    .filter((row) => row.claim !== 'branch')
    .flatMap((row) =>
      read(row).filter(
        (pr) =>
          row.claim === 'named' ||
          todo.startedAt === null ||
          pr.mergedAt === undefined ||
          pr.mergedAt >= todo.startedAt
      )
    );
  if (answered.length) return answered;
  return mine
    .filter((row) => row.claim === 'branch')
    .flatMap(read)
    .filter((pr) => inWindow(window, pr))
    .sort(
      (a, b) =>
        Number(a.state === 'CLOSED') - Number(b.state === 'CLOSED') || createdAt(a) - createdAt(b)
    )
    .slice(0, 1);
}

export function codingTodoOpenBranchPrs(
  todo: Pick<NeoTodo, 'id'>,
  claims: readonly CodingPrClaimRow[],
  prs: readonly NeoWorkPr[],
  window: CodingTodoWindow,
  own: readonly NeoWorkPr[]
): NeoWorkPr[] {
  const owned = new Set(own.map((pr) => codingPrKey(pr.url)));
  const branch = new Set(
    claims
      .filter((row) => row.todoId === todo.id && row.claim === 'branch')
      .filter(
        (row) =>
          !claims.some(
            (rival) => rival.todoId !== todo.id && rival.url === row.url && outranks(rival, row)
          )
      )
      .map((row) => row.url)
  );
  return prs.filter((pr) => {
    const key = codingPrKey(pr.url);
    return (
      pr.state === 'OPEN' &&
      key !== null &&
      branch.has(key) &&
      !owned.has(key) &&
      inWindow(window, pr)
    );
  });
}

const prNumber = (pr: NeoWorkPr) => `#${pr.url.replace(/\/+$/, '').split('/').pop()}`;

const createdAt = (pr: NeoWorkPr) => pr.createdAt ?? 0;

export const CODING_PR_REPLACEMENT_GRACE_MS = 15 * 60_000;

export function codingTodoCheck(
  kind: string,
  prs: readonly NeoWorkPr[],
  now = Date.now()
): NeoTodoCheckResult | null {
  if (kind !== 'pr_merged') return null;
  const live = prs.filter((pr) => pr.state !== 'CLOSED');
  const spare = [...live].sort((a, b) => createdAt(a) - createdAt(b));
  const unreplaced = prs
    .filter((pr) => pr.state === 'CLOSED')
    .sort((a, b) => createdAt(a) - createdAt(b))
    .filter((closed) => {
      const at = spare.findIndex((pr) => createdAt(pr) > createdAt(closed));
      return at < 0 || !spare.splice(at, 1);
    });
  const expired = unreplaced.filter(
    (pr) => now - (pr.closedAt ?? 0) >= CODING_PR_REPLACEMENT_GRACE_MS
  );
  if (expired.length)
    return {
      done: false,
      evidence: null,
      failed: `${expired.map(prNumber).join(' ')} closed without merging and no pull request replaced it`,
    };
  if (unreplaced.length) return { done: false, evidence: null };
  const merged = live.filter((pr) => pr.state === 'MERGED');
  return live.length && merged.length === live.length
    ? { done: true, evidence: `${merged.map(prNumber).join(' ')} merged` }
    : { done: false, evidence: null };
}

const CODING_TODO_STATUS_EN = {
  'todo.pr.merged': '{pr} merged',
  'todo.pr.closed': '{pr} closed',
  'todo.pr.ciFailing': '{pr} CI failing',
  'todo.pr.changesRequested': '{pr} needs changes',
  'todo.pr.waitingHuman': '{pr} waiting on the human',
  'todo.pr.waitingCi': '{pr} open, waiting on CI',
  'todo.pr.approved': '{pr} approved, waiting to merge',
  'todo.pr.waitingReview': '{pr} open, waiting on review',
  'todo.pr.noReviewer': '{pr} open, no reviewer yet',
  'todo.pr.approvedGreen': '{pr} approved and green',
  'todo.pr.approvedPending': '{pr} approved, CI still pending',
  'todo.pr.dirty': '{pr} in conflict with its base',
  'todo.pr.draft': '{pr} draft',
  'todo.reportedNoPr': 'Session says it is done; no PR found',
} as const;

const PR_CODES = {
  done: 'todo.pr.merged',
  failed: 'todo.pr.ciFailing',
  waiting: 'todo.pr.waitingCi',
  ready: 'todo.pr.approved',
  pending: 'todo.pr.waitingReview',
} as const;

const LEDGER_CODES: Record<CodingPrState, keyof typeof CODING_TODO_STATUS_EN> = {
  merged: 'todo.pr.merged',
  closed: 'todo.pr.closed',
  failing: 'todo.pr.ciFailing',
  changes_requested: 'todo.pr.changesRequested',
  waiting_review: 'todo.pr.waitingReview',
  waiting_ci: 'todo.pr.waitingCi',
  waiting_human: 'todo.pr.waitingHuman',
  unreviewed: 'todo.pr.noReviewer',
  approved_green: 'todo.pr.approvedGreen',
  approved_pending: 'todo.pr.approvedPending',
  dirty: 'todo.pr.dirty',
  draft: 'todo.pr.draft',
};

export type CodingLedgerState = (url: string) => CodingPrState | null;

function prCode(pr: NeoWorkPr, ledger?: CodingLedgerState): keyof typeof CODING_TODO_STATUS_EN {
  const state = ledger?.(pr.url);
  if (state) return LEDGER_CODES[state];
  if (pr.state === 'CLOSED') return 'todo.pr.closed';
  if (pr.state === 'OPEN' && pr.checks === 'failing') return 'todo.pr.ciFailing';
  if (pr.state === 'OPEN' && pr.review === 'changes_requested') return 'todo.pr.changesRequested';
  return PR_CODES[neoWorkPrVerdict(pr)];
}

export function codingTodoStatusLine(
  todo: Pick<NeoTodo, 'state' | 'report' | 'evidence'>,
  prs: readonly NeoWorkPr[],
  ledger?: CodingLedgerState
): NeoStatusLine | null {
  if (prs.length)
    return neoStatusLine(
      CODING_TODO_STATUS_EN,
      prs.map((pr) => ({ code: prCode(pr, ledger), params: { pr: prNumber(pr) } }))
    );
  return todo.state === 'done' && todo.report && !todo.evidence
    ? neoStatusLine(CODING_TODO_STATUS_EN, [{ code: 'todo.reportedNoPr', params: {} }])
    : null;
}

export function codingTodoRepository(
  todo: Pick<NeoTodo, 'check' | 'named'>,
  claimed: readonly string[] = []
): string | null {
  const issue = todo.check?.kind === 'issue_closed' && codingIssueRef(todo.check);
  if (issue) return neoGitRepo(`github.com/${issue.owner}/${issue.repo}`);
  const urls = todo.check?.pack === 'coding' ? todo.check.params.urls : null;
  const pr = [...(Array.isArray(urls) ? urls : []), ...claimed]
    .map((url) => (typeof url === 'string' ? parsePrUrl(url) : null))
    .find(Boolean);
  if (pr) return neoGitRepo(`${pr.host}/${pr.owner}/${pr.repo}`);
  const named = todo.named?.repository;
  if (typeof named !== 'string') return null;
  return neoGitRepo(/^[\w.-]+\/[\w.-]+$/.test(named.trim()) ? `github.com/${named.trim()}` : named);
}

function codingCheckRefs(check: NeoTodoCheck | null): string[] {
  const urls = Array.isArray(check?.params.urls) ? check.params.urls : [];
  return urls.flatMap((url) => {
    const pr = typeof url === 'string' ? parsePrUrl(url) : null;
    return pr ? [`${pr.owner}/${pr.repo}#${pr.number}`] : [];
  });
}

function codingIssueRef(check: NeoTodoCheck | null) {
  const match =
    typeof check?.params.issue === 'string'
      ? /^([\w.-]+)\/([\w.-]+)#([1-9]\d*)$/.exec(check.params.issue)
      : null;
  return match && Number.isSafeInteger(Number(match[3]))
    ? { owner: match[1], repo: match[2], number: Number(match[3]) }
    : null;
}

function codingIssueCheck(issue: NeoRefState | undefined): NeoTodoCheckResult {
  return issue?.kind === 'issue' && issue.state === 'CLOSED'
    ? issue.stateReason === 'COMPLETED'
      ? { done: true, evidence: `${issue.url} completed` }
      : issue.stateReason === 'NOT_PLANNED'
        ? { done: false, evidence: null, failed: `${issue.url} closed as NOT_PLANNED` }
        : { done: false, evidence: null }
    : { done: false, evidence: null };
}

export function codingTodoDoneWhen(check: NeoTodoCheck): string | null {
  if (check.kind === 'issue_closed') return `${check.params.issue} completed`;
  if (check.kind !== 'pr_merged') return null;
  const refs = codingCheckRefs(check);
  return refs.length
    ? `${refs.join(', ')} merged`
    : "The one pull request this todo's session opens is merged";
}

export function codingTodoCheckRefusal(
  draft: Pick<NeoTodo, 'check' | 'instruction'>
): string | null {
  if (draft.check?.kind === 'issue_closed')
    return codingIssueRef(draft.check)
      ? null
      : 'issue_closed_invalid_issue: params.issue must be owner/repo#N.';
  if (draft.check?.kind !== 'pr_merged') return null;
  const urls = draft.check.params.urls;
  if (
    urls !== undefined &&
    (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string' || !codingPrKey(url)))
  )
    return 'pr_merged_invalid_urls: every URL must name a pull request.';
  return !draft.instruction && !codingCheckRefs(draft.check).length
    ? 'pr_merged_needs_urls: a todo with no instruction opens no pull request; name each one in params.urls.'
    : null;
}

type CodingTodoFacts = {
  prs: readonly NeoWorkPr[];
  observedAt: number;
  incomplete?: true;
  issue?: NeoRefState;
};

const readIssueFacts = (superpipe({})('coding.issue-facts') as PipelineAPI)
  .input(['todo', 'readRefs', 'readPrs', 'repo'])
  .pipe(() => Date.now(), 'todo', 'observedAt')
  .pipe(
    async (todo: NeoTodo, read: NeoRefStateReader) => {
      const ref = codingIssueRef(todo.check);
      return { issue: ref ? (await read([ref]))[0] : undefined };
    },
    ['todo', 'readRefs'],
    'facts'
  )
  .pipe(
    async (facts: Pick<CodingTodoFacts, 'issue'>, read: NeoWorkPrReader) => ({
      ...facts,
      prs: facts.issue?.closingPrs?.length ? ((await read(facts.issue.closingPrs)) ?? []) : [],
    }),
    ['facts', 'readPrs'],
    'facts'
  )
  .pipe(
    async (
      facts: Omit<CodingTodoFacts, 'observedAt'>,
      repo: CodingTodoPrRepository,
      todo: NeoTodo,
      observedAt: number
    ) => {
      await repo.write('record', todo.id, facts.prs, observedAt);
      return { ...facts, observedAt };
    },
    ['facts', 'repo', 'todo', 'observedAt'],
    'facts'
  )
  .endAsync('facts') as (
  todo: NeoTodo,
  readRefs: NeoRefStateReader,
  readPrs: NeoWorkPrReader,
  repo: CodingTodoPrRepository
) => Promise<CodingTodoFacts>;

export function createCodingTodoPolicy(
  repo: Pick<CodingTodoPrRepository, 'urls'>
): Required<Pick<NeoTodoPack, 'doneWhen' | 'addUrls' | 'refuse' | 'record'>> {
  return {
    doneWhen: codingTodoDoneWhen,
    addUrls: (todo, urls) =>
      todo.check?.kind === 'pr_merged'
        ? {
            ...todo.check,
            params: {
              ...todo.check.params,
              urls: [
                ...new Set(
                  [
                    ...(Array.isArray(todo.check.params.urls) ? todo.check.params.urls : []),
                    ...urls,
                  ].map((url) => (typeof url === 'string' ? (codingPrKey(url) ?? url) : url))
                ),
              ],
            },
          }
        : null,
    refuse: (draft) => {
      const refused = codingTodoCheckRefusal(draft);
      return refused?.startsWith('pr_merged_needs_urls:') ? null : refused;
    },
    record: (draft, peers = []) => {
      const refused = codingTodoCheckRefusal(draft);
      if (refused || draft.check?.kind !== 'pr_merged') return refused;
      const urls = Array.isArray(draft.check.params.urls) ? draft.check.params.urls : [];
      const keys = new Set(urls.flatMap((url) => codingPrKey(url) ?? []));
      for (const peer of peers) {
        if (
          peer.id === draft.id ||
          ['done', 'closed_unverified', 'removed', 'failed'].includes(peer.state)
        )
          continue;
        const named =
          peer.check?.pack === 'coding' && Array.isArray(peer.check.params.urls)
            ? peer.check.params.urls
            : [];
        const duplicate = [...named, ...repo.urls(peer.id)].find(
          (url) => typeof url === 'string' && keys.has(codingPrKey(url) ?? '')
        );
        if (duplicate) {
          const next =
            peer.check?.kind === 'pr_merged'
              ? 'Use neo.todo.edit addUrls on that todo.'
              : 'Continue that todo instead.';
          return `pr_already_tracked: ${duplicate} is already tracked by todo ${peer.id} "${peer.title}". ${next}`;
        }
      }
      return null;
    },
  };
}

export function createCodingTodoPack(
  repo: CodingTodoPrRepository,
  readPrs: NeoWorkPrReader,
  ledger?: CodingLedgerState,
  readRefs?: NeoRefStateReader
): NeoTodoPack & NeoTodoFactJudge<CodingTodoFacts | null> {
  const claimsOf = (todo: NeoTodo) => {
    const recorded = new Set(repo.prs(todo.id).flatMap((pr) => codingPrKey(pr.url) ?? []));
    return [
      ...planCodingTodoClaims(todo, todo.report, []),
      ...repo.claimsOn([...recorded]).filter((row) => row.todoId === todo.id),
    ];
  };
  const readFacts = async (todo: NeoTodo): Promise<CodingTodoFacts | null> => {
    if (todo.check && todo.check.pack !== 'coding') return null;
    if (todo.check?.kind === 'issue_closed')
      return readIssueFacts(todo, readRefs ?? (async () => []), readPrs, repo);
    await repo.write('claim', todo.id, claimsOf(todo), Date.now());
    const urls = repo.urls(todo.id);
    if (!urls.length) return todo.check ? { prs: [], observedAt: Date.now() } : null;
    const observedAt = Date.now();
    const read = await readPrs(urls);
    if (!read || urls.some((url) => !read.some((pr) => codingPrKey(pr.url) === url)))
      return { prs: [], observedAt: Date.now(), incomplete: true };
    const claims = repo.claimsOn(urls);
    const window = await repo.readWindow(todo.id);
    const prs = codingTodoOwnPrs(todo, claims, read, window);
    const open = todo.check ? [] : codingTodoOpenBranchPrs(todo, claims, read, window, prs);
    await repo.write('record', todo.id, [...prs, ...open], observedAt);
    return { prs, observedAt };
  };
  const checked = (todo: NeoTodo, facts: CodingTodoFacts) =>
    todo.check?.kind === 'issue_closed'
      ? codingIssueCheck(facts.issue)
      : todo.check
        ? codingTodoCheck(todo.check.kind, facts.prs, facts.observedAt)
        : null;
  return {
    readFacts,
    judge: (todo, facts) => {
      if (!facts || facts.incomplete || todo.check?.pack !== 'coding')
        return { state: 'no_opinion' };
      const result = checked(todo, facts);
      if (result?.failed) return { state: 'failed', reason: result.failed };
      return result?.done ? { state: 'done', evidence: result.evidence } : { state: 'no_opinion' };
    },
    schema: createCodingPackTables,
    repository: (todo) => codingTodoRepository(todo, todo.id ? repo.urls(todo.id) : []),
    openedPrs: async (todo, urls) => {
      await repo.write(
        'claim',
        todo.id,
        [...claimsOf(todo), ...urls.map((url) => ({ url, claim: 'branch' as const }))],
        Date.now()
      );
    },
    check: async (todo) => {
      const facts = await readFacts(todo);
      if (!facts) return null;
      if (facts.incomplete) return todo.check ? { done: false, evidence: null } : null;
      return checked(todo, facts);
    },
    statusLine: (todo) => codingTodoStatusLine(todo, repo.prs(todo.id), ledger),
    waiting: (todo) => repo.readWaiting(todo.id),
    ...createCodingTodoPolicy(repo),
  };
}

export const codingTodoPrWrites = defineRepositoryOp(
  'coding.todoPrWrites',
  'write',
  CodingTodoPrRepository,
  ['claim', 'record']
);

export const codingTodoPrReads = defineRepositoryOp(
  'coding.todoPrReads',
  'read',
  CodingTodoPrRepository,
  ['window', 'isWaiting']
);
