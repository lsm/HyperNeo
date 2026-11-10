import { NeoTrackerMirrorRepository } from '../../../../storage/repositories/neo-tracker-mirror.ts';
import { NEO_TRACKER_FAILURE_LIMIT } from '../../tracker-mirror-plan.ts';
import { listPackPreferences } from '../../preference-operations.ts';
import { codingApprovalUrl } from './pr-approved.ts';
import { CodingStageFactsRepository } from './stage-facts.ts';
import { CodingDeliveryFactsRepository } from './delivery-facts.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { NeoRefState, NeoRefStateReader } from './ask-prs.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import type { NeoTodo, NeoTodoCheck } from '@hyperneo/shared/types/neo-ask';
import { neoWorkPrVerdict, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { codingPrKey } from './pr-key.ts';
import { CodingTurnPrRepository, readCodingTurnFacts } from './turn-prs.ts';
import type { NeoTodoCheckResult, NeoTodoFactJudge, NeoTodoPack } from '../../pack-contract.ts';
import type { CodingPrState } from './pr-ledger.ts';
import { neoStatusLine, type NeoStatusLine } from '../../status-codes.ts';
import { createCodingPackTables } from './schema/coding-tables.ts';
import { neoRepositoryIdentity } from '../../project-mirror.ts';
import type { NeoTodoRepositoryDraft, NeoTodoPolicyScope } from '../../pack-contract.ts';
import type { NeoWorkPrReader } from './work-prs.ts';

export class CodingTodoPrRepository {
  readonly stageFacts: CodingStageFactsRepository;
  readonly deliveryFacts: CodingDeliveryFactsRepository;
  readonly turnPrs: CodingTurnPrRepository;

  constructor(private readonly db: Database) {
    this.stageFacts = new CodingStageFactsRepository(db);
    this.deliveryFacts = new CodingDeliveryFactsRepository(db);
    this.turnPrs = new CodingTurnPrRepository(db);
  }

  write(method: 'record', ...args: Parameters<CodingTodoPrRepository['record']>): Promise<void> {
    return gatewayFor(this.db).run(codingTodoPrWrites, { method, args }) as Promise<void>;
  }

  urls(todoId: string): string[] {
    return this.turnPrs.ownedPrs(todoId);
  }

  linked(todoId: string, url: string) {
    return this.urls(todoId).includes(codingPrKey(url) ?? url);
  }

  linkedIssues(url: string, todoId?: string): string[][] {
    const pr = parsePrUrl(url)!;
    const enabled =
      pr.host === 'github.com' &&
      listPackPreferences(this.db, 'coding').find(
        (preference) =>
          preference.key === 'mirror_issues' &&
          preference.scope.kind === 'repo' &&
          neoRepositoryIdentity(preference.scope.key)
            ?.slice('repository:'.length)
            .replace(/^github\.com\//, '') === `${pr.owner}/${pr.repo}`.toLowerCase()
      )?.value === true;
    if (!enabled) return [];
    const facts = new NeoTrackerMirrorRepository(this.db).facts();
    return facts.todos
      .filter(
        (todo) =>
          (!todoId || todo.id === todoId) &&
          todo.check?.pack === 'coding' &&
          !['done', 'removed', 'closed_unverified'].includes(todo.state) &&
          facts.asks.some((ask) => ask.id === todo.askId && ask.status === 'open') &&
          this.linked(todo.id, url)
      )
      .flatMap((todo) => {
        const rows = facts.mirrors.filter(
          (row) =>
            row.tracker === 'github-issues' &&
            (row.ownerKind === 'todo' ? row.ownerId === todo.id : row.ownerId === todo.askId)
        );
        const refs = rows.flatMap((row) => row.ref ?? []);
        if (refs.length) return [refs];
        const own = rows.find((row) => row.ownerKind === 'todo');
        if (own && (own.failures >= NEO_TRACKER_FAILURE_LIMIT || own.state === 'closed')) return [];
        return [[]];
      });
  }

  prs(todoId: string): NeoWorkPr[] {
    const row = this.db
      .prepare('SELECT prs_json AS prs FROM pack_coding_todo_prs WHERE todo_id = ?')
      .get(todoId) as { prs: string } | null;
    return row ? (JSON.parse(row.prs) as NeoWorkPr[]) : [];
  }

  holder(url: string, ref: WorkRef): string | undefined {
    const key = codingPrKey(url);
    const rows = this.db
      .prepare(
        `SELECT p.todo_id AS todoId, p.prs_json AS prs FROM pack_coding_todo_prs p
           JOIN neo_todos t ON t.id = p.todo_id AND t.state IN ('todo', 'doing', 'blocked')
           JOIN neo_todo_sessions s ON s.todo_id = p.todo_id
          WHERE json_extract(s.ref, '$.adapter') = ? AND json_extract(s.ref, '$.id') = ?
            AND json_extract(s.ref, '$.daemon') IS ?`
      )
      .all(ref.adapter, ref.id, ref.daemon ?? null) as { todoId: string; prs: string }[];
    const holders = rows.filter((row) =>
      (JSON.parse(row.prs) as NeoWorkPr[]).some((pr) => codingPrKey(pr.url) === key)
    );
    return holders.length === 1 ? holders[0].todoId : undefined;
  }

  readHolder(url: string, ref: WorkRef): Promise<string | undefined> {
    return gatewayFor(this.db).call(codingTodoPrReads, 'holder', url, ref);
  }

  isWaiting(todoId: string): boolean {
    return this.prs(todoId).some((pr) => pr.state === 'OPEN');
  }

  readWaiting(todoId: string): Promise<boolean> {
    return gatewayFor(this.db).call(codingTodoPrReads, 'isWaiting', todoId);
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

function neoGitRepo(remote: string | undefined): string | null {
  return neoRepositoryIdentity(remote)?.slice('repository:'.length) ?? null;
}

export function codingTodoRepository(
  todo: NeoTodoRepositoryDraft,
  claimed: readonly string[] = [],
  scope?: NeoTodoPolicyScope
): string | null {
  if (scope && 'todo' in scope)
    return scope.start
      ? scope.todo?.repo || scope.ask?.repo || null
      : (scope.todo?.repo ?? scope.ask?.repo ?? null);
  const issue = todo.check?.kind === 'issue_closed' && codingIssueRef(todo.check);
  if (issue) return neoGitRepo(`github.com/${issue.owner}/${issue.repo}`);
  const urls =
    todo.check?.pack === 'coding'
      ? todo.check.kind === 'pr_approved'
        ? [todo.check.params.url]
        : todo.check.params.urls
      : null;
  const pr = [...(Array.isArray(urls) ? urls : []), ...claimed]
    .map((url) => (typeof url === 'string' ? parsePrUrl(url) : null))
    .find(Boolean);
  if (pr) return neoGitRepo(`${pr.host}/${pr.owner}/${pr.repo}`);
  const named = todo.named?.repository;
  const place = todo.target?.verb === 'start' ? todo.target.place : null;
  const repositories = [...new Set(scope?.peers?.flatMap((peer) => peer.repo || []) ?? [])];
  return (
    (typeof named === 'string'
      ? neoGitRepo(/^[\w.-]+\/[\w.-]+$/.test(named.trim()) ? `github.com/${named.trim()}` : named)
      : null) ??
    place?.remotes?.map(neoGitRepo).find(Boolean) ??
    (place || repositories.length !== 1 ? null : repositories[0])
  );
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
  if (check.kind === 'pr_approved')
    return `${check.params.url} approved under the repository's saved merge policy`;
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
  if (draft.check?.kind === 'pr_approved')
    return codingApprovalUrl(draft.check.params.url)
      ? null
      : 'pr_approved_invalid_url: params.url must name a pull request.';
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
  approval?: NeoTodoCheckResult;
};

export function createCodingTodoPolicy(
  repo: Pick<CodingTodoPrRepository, 'urls'>
): Required<Pick<NeoTodoPack, 'doneWhen' | 'addUrls' | 'refuse' | 'record' | 'repository'>> {
  const repository: NonNullable<NeoTodoPack['repository']> = (todo, scope) =>
    codingTodoRepository(
      todo,
      scope && 'todo' in scope ? [] : todo.id ? repo.urls(todo.id) : [],
      scope
    );
  return {
    repository,
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
    refuse: (draft, _peers, scope) => {
      if (scope) {
        const name = repository({ ...draft, named: draft.named ?? null }, scope);
        if (draft.check?.pack === 'coding' && draft.target?.verb === 'send') {
          const expected =
            name ??
            repository(
              { ...draft, named: draft.named ?? null },
              { ask: scope.ask, peers: scope.peers }
            );
          const remotes = scope.workerRemotes?.map(neoGitRepo).filter(Boolean) ?? [];
          if (expected && !remotes.includes(neoGitRepo(expected)))
            return `worker_repository_mismatch: todo is ${expected}, worker ${draft.target.ref.id} is in ${remotes.join(', ') || 'unknown'}; send it to a worker of ${expected} or start one there.`;
        }
        return draft.target?.verb === 'start' && !draft.target.place && name
          ? `place_required: coding work for ${name} starts in its repository; pass target.place from work.find.`
          : null;
      }
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
  readRefs?: NeoRefStateReader,
  readApproval?: (url: string) => Promise<NeoTodoCheckResult>
): NeoTodoPack & NeoTodoFactJudge<CodingTodoFacts | null> {
  const readFacts = async (todo: NeoTodo, persist = true): Promise<CodingTodoFacts | null> => {
    if (todo.check && todo.check.pack !== 'coding') return null;
    if (todo.check?.kind === 'pr_approved')
      return {
        prs: [],
        observedAt: Date.now(),
        approval: await readApproval?.(String(todo.check.params.url)),
      };
    const facts = await readCodingTurnFacts(todo, repo.turnPrs, readPrs);
    if (persist && !facts.incomplete)
      await repo.write('record', todo.id, [...facts.prs], facts.observedAt);
    if (todo.check?.kind !== 'issue_closed') return facts;
    const ref = codingIssueRef(todo.check);
    const [issue] = ref ? await (readRefs ?? (async () => []))([ref]) : [];
    return { prs: facts.prs, observedAt: facts.observedAt, issue };
  };
  const checked = (todo: NeoTodo, facts: CodingTodoFacts) =>
    todo.check?.kind === 'pr_approved'
      ? (facts.approval ?? { done: false, evidence: null })
      : todo.check?.kind === 'issue_closed'
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
    check: async (todo, context) => {
      const facts = await readFacts(todo, !context?.readOnly);
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
  ['record']
);

export const codingTodoPrReads = defineRepositoryOp(
  'coding.todoPrReads',
  'read',
  CodingTodoPrRepository,
  ['isWaiting', 'holder', 'linkedIssues']
);
