import { CodingAssignmentsRepository } from './assignments.ts';
import { type CodingAttend, codingPrHeadEvent } from './attention.ts';
import { codingReviewCoversMergeHold } from './review-merge-hold.ts';
import {
  CODING_DAEMON_MERGE_MAX_ATTEMPTS,
  planCodingMergeAttempt,
  runCodingMergeAttempt,
} from './daemon-merge-attempt.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { Logger } from '../../../logger.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { parsePrUrl } from '../../../github/parse-pr-url.ts';
import { homedir } from 'node:os';
import { fetchRateLimitResetEpoch, readGithubBudget } from '../../../github/gh-lookup-helpers.ts';
import { computeRateLimitRetryMs, isRateLimitError } from '../../../session/rate-limit-detector.ts';
import {
  CODING_LEDGER_MIN_RATE,
  type CodingPrLedgerRepository,
  type CodingMergePolicy,
  type CodingPrState,
} from './pr-ledger.ts';
import type { CodingPrEventRepository } from './pr-events.ts';
import {
  codingDeliveryKey,
  codingFailingReviewReceiptKey,
  type CodingSweepDeps,
} from './pr-sweep.ts';
import {
  codingMergeFactReadFailed,
  readCodingDaemonMergeFacts,
  readCodingLocalMergeFacts,
  readCodingRequiredChecks,
} from './daemon-merge-facts.ts';
import {
  codingNoChecksNeedsHuman,
  decideCodingHumanHandoff,
  decideCodingDaemonMerge,
} from './daemon-merge-gates.ts';
import { codingMergeGithubSchemas } from './merge-operation.ts';

const log = new Logger('CodingDaemonMerge');
const CODING_MERGE_REREAD_MS = 600_000;
const prUrl = (row: { repo: string; number: number }) =>
  `https://${process.env.GH_HOST ?? 'github.com'}/${row.repo}/pull/${row.number}`.toLowerCase();

type Receipt = ReturnType<CodingPrLedgerRepository['daemonMerge']>[number];
type Candidate = {
  url: string;
  head: string;
  policy: CodingMergePolicy;
  ledgerState: CodingPrState;
  stateSince: number;
  readKey?: string;
};
type Observed = Candidate & { facts: Awaited<ReturnType<typeof readCodingDaemonMergeFacts>> };
const admit = (observed: Observed) => {
  const decision = decideCodingDaemonMerge(observed.facts, observed.policy);
  const reason =
    decision.kind === 'skip' &&
    decision.reason === 'merge_policy_unresolved' &&
    observed.facts.ok &&
    observed.facts.state === 'OPEN'
      ? 'needs_human_signoff'
      : decision.kind === 'skip' || decision.kind === 'read_failure'
        ? decision.reason
        : decision.kind;
  const ledgerReady =
    observed.ledgerState === 'approved_green' ||
    (['approved_pending', 'waiting_ci'].includes(observed.ledgerState) &&
      observed.facts.ok &&
      observed.facts.requiredCi.count === 0) ||
    (observed.facts.ok && observed.facts.fileScopePaginated && observed.facts.passingCommitStatus);
  return decision.kind === 'merge' && decision.head === observed.head && ledgerReady
    ? { value: observed }
    : { reason: decision.kind === 'merge' ? 'ledger_head_or_approval_changed' : reason };
};

export function createCodingDaemonMergeSweep(
  database: () => Database,
  ledger: CodingPrLedgerRepository,
  events: CodingPrEventRepository,
  delivery: Pick<CodingSweepDeps, 'tell' | 'human'> & { attend: CodingAttend },
  spawn: SpawnFn = spawnProcess
) {
  const actor = 'daemon:coding-sweep';
  let holdRevision = 0;
  let rateLimitedUntil = 0;
  const signoffHolds = new Map<string, { key: string; at: number }>();
  const lastRead = new Map<string, { key: string; at: number; facts: Observed['facts'] }>();
  const remember = (
    url: string,
    key: string | undefined,
    facts: Observed['facts'],
    at: number,
    revision: number
  ) => {
    if (
      facts.ok &&
      facts.mergeable !== 'UNKNOWN' &&
      facts.files !== null &&
      key &&
      revision === holdRevision
    )
      lastRead.set(url, { key, at, facts });
    else lastRead.delete(url);
  };
  const record = (change: Parameters<CodingPrLedgerRepository['daemonMerge']>[0]) =>
    ledger.write('daemonMerge', change);
  const read = async (url: string, human = false) => {
    const facts = await readCodingDaemonMergeFacts(database(), url, spawn);
    if (!facts.ok)
      log.warn(human ? 'Human merge handoff held' : 'Daemon merge held', {
        url,
        reason: facts.reason,
      });
    return facts;
  };
  const attend = (...event: Parameters<typeof codingPrHeadEvent>) =>
    delivery.attend(codingPrHeadEvent(...event)).catch(() => false);
  const notify = async (receipt: Receipt, now: number) => {
    const { owner: org, repo, number } = parsePrUrl(receipt.url)!;
    const { owner } = await events.routeLater({ repo: `${org}/${repo}`, number: +number });
    const key = `coding-daemon-${receipt.mergeCommit ? 'merged' : 'held'}:${receipt.url}:${receipt.head}`;
    const text = receipt.mergeCommit
      ? `Merge confirmed: ${receipt.url} head ${receipt.head}, commit ${receipt.mergeCommit}. Receipt executor ${receipt.actor}; confirmation sweep ${new Date(receipt.mergedAt!).toISOString()}.`
      : `Daemon merge held: ${receipt.url} head ${receipt.head}. The daemon started a merge on this head and never confirmed it, and the pull request is no longer open.${receipt.error ? ` Last error: ${receipt.error}.` : ''} Check on GitHub how it closed before any manual action.`;
    const told = owner && (await delivery.tell(owner, key, text, receipt.url).catch(() => false));
    if (told && owner && receipt.mergeCommit) {
      const eventKey = codingDeliveryKey(
        `neo-pr-event:${org}/${repo}#${number}:${receipt.head}:merged`
      );
      await events.markReview(codingFailingReviewReceiptKey(eventKey, owner));
    }
    const notified =
      told ||
      (await attend(
        receipt.mergeCommit ? 'coding.merge_confirmed' : 'coding.merge_held',
        receipt,
        receipt.mergedAt ?? receipt.startedAt,
        text
      ));
    if (notified && receipt.mergeCommit) await record({ ...receipt, kind: 'notified', at: now });
    return notified;
  };
  const retryLimit = async (url: string, head: string, readySince?: number) => {
    const [failure] = await record({ kind: 'failures', url, head });
    if (!failure || (failure.failures ?? 0) < CODING_DAEMON_MERGE_MAX_ATTEMPTS) return false;
    const ready = readySince !== undefined && readySince > failure.startedAt;
    await attend(
      'coding.merge_failing',
      { url, head },
      ready ? readySince : failure.startedAt,
      ready
        ? `Fresh merge gates now pass for ${url} head ${head}, but the daemon merge budget is stopped. Last error: ${failure.error}. Inspect it, then use neo.coding.merge.retry on this exact head to reopen the budget; leave merging to the daemon.`
        : `Daemon merge stopped after ${failure.failures} failed attempts: ${url} head ${head}. Last error: ${failure.error}. Resolve the failure, then use neo.coding.merge.retry on this exact head once fresh gates pass.`
    );
    return true;
  };
  const finish = async (
    receipt: Receipt,
    pr: Observed['facts'],
    now: number,
    error: string | null = null
  ) => {
    const outcome = planCodingMergeAttempt(receipt.head, pr, error ?? receipt.error ?? null);
    if (!pr.ok && error)
      await record({ ...receipt, kind: 'uncertain', at: receipt.startedAt, error });
    if (error) log.warn('Daemon merge held', { url: receipt.url, reason: error });
    if (outcome.kind === 'not_ready') {
      await record({ ...receipt, kind: 'void', at: receipt.startedAt });
      return;
    }
    if (outcome.kind === 'retry') {
      if (!error) log.warn('Daemon merge held', { url: receipt.url, reason: outcome.error });
      await record({ ...receipt, kind: 'failed', at: receipt.startedAt, error: outcome.error });
      await record({ ...receipt, kind: 'void', at: receipt.startedAt });
      await retryLimit(receipt.url, receipt.head);
      return;
    }
    if (outcome.kind === 'confirmed') {
      const [merged] = await record({
        ...receipt,
        kind: 'finish',
        commit: outcome.commit,
        at: now,
      });
      log.info('Daemon merge confirmed', {
        url: receipt.url,
        head: receipt.head,
        commit: outcome.commit,
      });
      if (merged) await notify(merged, now);
    } else if (pr.ok && (await notify(receipt, now)) && pr.state !== 'OPEN') {
      await record({ ...receipt, kind: 'void', at: receipt.startedAt });
    }
  };
  const merge = (superpipe({})('coding.sweep-daemon-merge') as PipelineAPI)
    .input(['observed', 'now'])
    .pipe(admit, 'observed', 'result:result')
    .pipe(
      async (observed: Observed, now: number) => {
        const { url, head } = observed;
        if (Date.now() < rateLimitedUntil) return { reason: 'github_rate_limited' };
        const [receipt] = await record({ kind: 'begin', url, head, actor, at: now });
        return receipt
          ? { value: receipt }
          : {
              reason: (await retryLimit(
                url,
                head,
                observed.ledgerState === 'approved_green' ? observed.stateSince : undefined
              ))
                ? 'retry_limit_reached'
                : 'already_attempted',
            };
      },
      ['result', 'now'],
      'result:result'
    )
    .pipe(
      async (receipt: Receipt, observed: Observed, now: number) => {
        const { owner, repo, host } = parsePrUrl(receipt.url)!;
        let admitted = false;
        try {
          const revision = holdRevision;
          observed = { ...observed, facts: await read(receipt.url) };
          remember(receipt.url, observed.readKey, observed.facts, now, revision);
          const fresh = admit({ ...observed, policy: ledger.policy(`${owner}/${repo}`) });
          if ('reason' in fresh) return fresh.reason;
          admitted = true;
        } finally {
          if (!admitted) await record({ ...receipt, kind: 'void', at: receipt.startedAt });
        }
        // oxlint-disable-next-line no-warning-comments -- TODO(#9458): accepted final-read/in-flight-writer race.
        const error = await runCodingMergeAttempt(receipt.url, receipt.head, spawn);
        if (error && isRateLimitError(error)) {
          const reset = await fetchRateLimitResetEpoch(homedir(), spawn, 5_000, host);
          rateLimitedUntil = Date.now() + computeRateLimitRetryMs(reset);
          await record({ ...receipt, kind: 'void', at: receipt.startedAt });
          return 'github_rate_limited';
        }
        const facts = await read(receipt.url);
        await finish(receipt, facts, now, error);
        return facts.ok ? 'attempted' : 'read_failure';
      },
      ['result', 'observed', 'now'],
      'result'
    )
    .endAsync('result') as (observed: Observed, now: number) => Promise<unknown>;
  const sweep = async (now: number): Promise<void> => {
    const revision = holdRevision;
    const open = (await ledger.read('list')).filter((row) => row.closedAt === null);
    for (const { url, head } of await record({ kind: 'limits' })) {
      const row = open.find((row) => prUrl(row) === url && row.head === head);
      const health = row?.readAt === now && (await ledger.pollContextCurrent(row.repo)).health;
      if (health && health.reason === 'complete' && health.cycleAt === now)
        await retryLimit(url, head);
    }
    const budget = readGithubBudget();
    if (budget.level === 'critical')
      await delivery
        .attend({
          kind: 'coding.github_budget',
          subject: { type: 'github_budget', id: 'core' },
          since: budget.resetAt!,
          facts: {
            text: `GitHub REST budget is below 5% for the shared account; it resets at ${new Date(budget.resetAt!).toISOString()}. The daemon sweep now reads only PRs ready to merge. Hold GitHub-heavy work until the reset.`,
          },
        })
        .catch(() => false);
    const rows = open.filter((row) =>
      (budget.level === 'ok'
        ? ['approved_green', 'approved_pending', 'waiting_ci', 'waiting_human']
        : ['approved_green']
      ).includes(row.state)
    );
    const handedOff = await ledger.read('humanHandoffs');
    const observed = await Promise.all(
      rows.map(async (row) => {
        const { repo, number, head, state, stateSince } = row;
        const { policy, health } = await ledger.pollContextCurrent(repo);
        const url = prUrl(row);
        const reviewHolds = await new CodingAssignmentsRepository(database())
          .reviewHoldsCurrent(url, head)
          .catch(() => []);
        return {
          reviewHolds,
          url,
          head,
          readKey: JSON.stringify([
            head,
            state,
            stateSince,
            row.updatedAt ?? null,
            policy,
            reviewHolds,
          ]),
          holdKey: JSON.stringify([
            head,
            state,
            stateSince,
            row.ci,
            row.replyAt,
            policy,
            reviewHolds,
          ]),
          ledgerState: state,
          stateSince,
          policy,
          settled:
            codingNoChecksNeedsHuman(policy, 0) &&
            handedOff.some(
              (prior) => prior.repo === repo && prior.number === number && prior.head === head
            ),
          readable:
            !health ||
            (health.reason === 'complete' &&
              (health.quota?.remaining == null ||
                health.quota.remaining >=
                  (health.quota.resource === 'graphql' ? CODING_LEDGER_MIN_RATE : 1))),
        };
      })
    );
    for (const url of signoffHolds.keys())
      if (!observed.some((row) => row.url === url)) signoffHolds.delete(url);
    const candidates = observed.filter(
      (row) =>
        !(
          signoffHolds.get(row.url)?.key === row.holdKey &&
          now - signoffHolds.get(row.url)!.at < 600_000
        ) &&
        !row.settled &&
        row.readable &&
        (row.policy.mergeBy === 'daemon' || codingNoChecksNeedsHuman(row.policy, 0))
    );
    const receipts = await record({ kind: 'list' });
    const pending = [
      ...new Set(
        [...candidates.filter((row) => row.policy.mergeBy === 'daemon'), ...receipts].map(
          ({ url }) => url
        )
      ),
    ];
    for (const [url, prior] of lastRead)
      if (
        now - prior.at >= CODING_MERGE_REREAD_MS ||
        !candidates.some((row) => row.url === url && row.policy.mergeBy === 'daemon')
      )
        lastRead.delete(url);
    const observedAt = new Map<string, number>();
    const unchanged = (url: string) => {
      const prior = lastRead.get(url);
      const row = candidates.find((candidate) => candidate.url === url);
      return prior && row?.readKey === prior.key && now - prior.at < CODING_MERGE_REREAD_MS
        ? prior
        : null;
    };
    const facts = new Map(
      await Promise.all(
        pending.map(async (url) => {
          if (!receipts.some((receipt) => receipt.url === url)) {
            const cached = unchanged(url);
            if (cached) {
              observedAt.set(url, cached.at);
              const local = await readCodingLocalMergeFacts(database(), url, cached.facts).catch(
                () => codingMergeFactReadFailed
              );
              if (!local.ok) log.warn('Daemon merge held', { url, reason: local.reason });
              return [url, local] as const;
            }
          }
          const fresh = await read(url);
          observedAt.set(url, now);
          const key = candidates.find((candidate) => candidate.url === url)?.readKey;
          remember(url, key, fresh, now, revision);
          return [url, fresh] as const;
        })
      )
    );
    for (const receipt of receipts) {
      if (!facts.get(receipt.url)!.ok) continue;
      if (receipt.mergeCommit) await notify(receipt, now);
      else await finish(receipt, facts.get(receipt.url)!, now);
    }
    for (const candidate of candidates) {
      if (candidate.policy.mergeBy !== 'daemon' && !facts.has(candidate.url)) {
        const outcome = await readCodingRequiredChecks(candidate.url, spawn);
        const checks = codingMergeGithubSchemas.Checks.safeParse(outcome.ok ? outcome.data : null);
        if (!checks.success) {
          log.warn('Human merge handoff held', {
            url: candidate.url,
            reason: outcome.ok ? 'required_checks_unreadable' : outcome.error,
          });
          continue;
        }
        if (checks.data.length) continue;
        facts.set(candidate.url, await read(candidate.url, true));
      }
      if (!facts.get(candidate.url)!.ok) continue;
      const current = facts.get(candidate.url)!;
      if (decideCodingHumanHandoff(current, candidate.policy, candidate.head) === true) {
        const pr = parsePrUrl(candidate.url)!;
        await ledger.write(
          'holdForHuman',
          `${pr.owner}/${pr.repo}`,
          +pr.number,
          candidate.head,
          now
        );
        await delivery
          .human?.(
            `coding-no-checks:${candidate.url}:${candidate.head}`,
            `${candidate.url} — work finished, awaiting your manual merge. There are no required checks or review-bot gate, and this repository has not explicitly allowed zero-check merging. The daemon and workers will not merge it. Review the work and merge it on GitHub when you are ready. Head: ${candidate.head}.`
          )
          .catch(() => false);
        continue;
      }
      if (candidate.policy.mergeBy !== 'daemon') continue;
      const outcome = await merge({ ...candidate, facts: current }, now);
      if (outcome === 'attempted' || outcome === 'read_failure') lastRead.delete(candidate.url);
      signoffHolds.delete(candidate.url);
      if (outcome === 'needs_human_signoff' && revision === holdRevision)
        signoffHolds.set(candidate.url, {
          key: candidate.holdKey,
          at: observedAt.get(candidate.url) ?? now,
        });
      if (
        typeof outcome === 'string' &&
        !['attempted', 'read_failure', 'already_attempted'].includes(outcome)
      )
        log.warn('Daemon merge held', { url: candidate.url, reason: outcome });
      if (
        outcome === 'needs_human_signoff' &&
        !codingReviewCoversMergeHold(
          current,
          candidate.policy,
          candidate.head,
          candidate.reviewHolds
        )
      ) {
        const notified = await attend(
          'coding.merge_held',
          candidate,
          0,
          `${candidate.url} requires human sign-off or a resolved merge policy; daemon merge is held.`
        );
        if (!notified) signoffHolds.delete(candidate.url);
      }
    }
  };
  return Object.assign((now: number) => events.exclusive(() => sweep(now)), {
    invalidate: (url: string) => {
      holdRevision++;
      signoffHolds.delete(url.toLowerCase());
      lastRead.delete(url.toLowerCase());
    },
  });
}
