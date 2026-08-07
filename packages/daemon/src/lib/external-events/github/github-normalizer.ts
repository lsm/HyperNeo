import type { ExternalEvent } from '../types';
import { Logger } from '../../logger';

const log = new Logger('github-normalizer');

export type GitHubEventKind =
  | 'issue_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request_review_thread'
  | 'pull_request'
  | 'check_run'
  | 'status'
  | 'check_suite'
  | 'reaction'
  | 'deployment'
  | 'deployment_status';

/**
 * Handles an agent needs to reply to / resolve this event's comment or thread.
 *
 * Verified against the official GitHub REST + GraphQL reference:
 * - `commentId`: the REST numeric id (as a string) of the comment this event
 *   targets. It is the handle `POST /repos/{o}/{r}/pulls/{n}/comments/{comment_id}/replies`
 *   (and the `in_reply_to` body param of `POST .../pulls/{n}/comments`) needs
 *   to reply to a review comment. For review comments this is the ROOT comment
 *   id (resolved via `in_reply_to_id`, since the reply endpoint rejects a reply's
 *   own id and review threads are flat); for issue comments it is the comment's
 *   own id (issue comments are not threaded); for review-thread events it is the
 *   thread's root comment id. Populated for issue-comment, review-comment, and
 *   review-thread events; empty for reviews, PRs, check runs, and reactions.
 * - `nodeId`: the GraphQL `node_id` of the event's primary entity (the comment,
 *   review, pull request, or thread).
 *
 * The review-THREAD node id that `resolveReviewThread`
 * (`ResolveReviewThreadInput.threadId` = `PullRequestReviewThread.id`) and
 * `addPullRequestReviewThreadReply` (`pullRequestReviewThreadId`) require:
 * - For `pull_request_review_thread` webhooks (resolved/unresolved) it IS
 *   captured directly from `thread.node_id` — GitHub includes it on this event,
 *   so no runtime lookup is needed.
 * - For comment events (`pull_request_review_comment`) it is NOT captured: a
 *   comment's `node_id` is NOT its thread's node id, and GitHub does not include
 *   the thread node id in those webhook payloads or the REST `/pulls/comments`
 *   response. It must be resolved at runtime by querying the PR's `reviewThreads`
 *   connection, so it belongs to the consumer, not the normalizer.
 */
export interface NormalizedGitHubEvent {
  deliveryId: string;
  dedupeKey: string;
  source: 'webhook' | 'polling';
  eventType: GitHubEventKind;
  action: string;
  repoOwner: string;
  repoName: string;
  entityId: string;
  prNumber: number;
  prUrl: string;
  actor: string;
  actorType: string;
  body: string;
  summary: string;
  externalUrl: string;
  externalId: string;
  /** REST numeric id (as a string) of the target comment, when applicable. See type doc. */
  commentId: string;
  /** GraphQL `node_id` of the event's primary entity (comment / review / PR). */
  nodeId: string;
  occurredAt: number;
  rawPayload: unknown;
  payload?: Record<string, unknown>;
}

export interface GitHubPollingRepo {
  owner: string;
  repo: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function getString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function getNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}

/**
 * Renders a numeric REST id (e.g. comment.id) as a string, or '' when the id is
 * absent/zero. REST ids are numbers; GraphQL node ids are strings (use getString).
 */
function idString(value: unknown): string {
  const id = getNumber(value);
  return id ? String(id) : '';
}

export function parseGitHubTimestamp(value: unknown): number {
  const raw = getString(value);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function repoFromPayload(payload: Record<string, unknown>): { owner: string; repo: string } {
  const repository = asObject(payload.repository);
  const owner = asObject(repository.owner);
  const fullName = getString(repository.full_name);
  const [fullOwner, fullRepo] = fullName.split('/');
  return {
    owner: getString(owner.login, fullOwner ?? ''),
    repo: getString(repository.name, fullRepo ?? ''),
  };
}

function parseRepoFromUrl(url: string): GitHubPollingRepo | null {
  // API URLs have the form https://api.github.com/repos/{owner}/{repo}/...
  // HTML URLs have the form https://github.com/{owner}/{repo}/...
  // A renamed repo's payload URL carries the current canonical name, which may
  // differ from the watched repo config cached at setup time.
  const apiMatch = url.match(/\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (apiMatch) {
    const [, owner, repo] = apiMatch;
    if (owner && repo) return { owner, repo };
  }
  // Negative lookahead avoids matching github.com/repos/{owner}/{repo} (an API URL
  // where the domain was already consumed by a prior /repos/ match attempt).
  const htmlMatch = url.match(/github\.com\/(?!repos\/)([^/]+)\/([^/]+)(?:\/|$)/);
  if (htmlMatch) {
    const [, owner, repo] = htmlMatch;
    if (owner && repo) return { owner, repo };
  }
  return null;
}

function resolvePollingRepo(
  watched: GitHubPollingRepo,
  obj: Record<string, unknown>
): GitHubPollingRepo {
  const apiUrl = getString(obj.url);
  const htmlUrl = getString(obj.html_url);
  const payloadRepo = parseRepoFromUrl(apiUrl) ?? parseRepoFromUrl(htmlUrl);
  if (!payloadRepo) return watched;

  const differs =
    payloadRepo.owner.toLowerCase() !== watched.owner.toLowerCase() ||
    payloadRepo.repo.toLowerCase() !== watched.repo.toLowerCase();
  if (differs) {
    log.warn('Payload repo differs from watched repo; using payload repo', {
      watched: `${watched.owner}/${watched.repo}`,
      payload: `${payloadRepo.owner}/${payloadRepo.repo}`,
    });
  }
  return payloadRepo;
}

function userFrom(value: unknown): { login: string; type: string } {
  const user = asObject(value);
  return { login: getString(user.login, 'unknown'), type: getString(user.type, 'User') };
}

function truncateBody(body: string): string {
  const singleLine = body.replace(/\s+/g, ' ').trim();
  return singleLine.length > 240 ? `${singleLine.slice(0, 237)}...` : singleLine;
}

function prUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${owner}/${repo}/pull/${number}`;
}

function isFailedCheckConclusion(conclusion: string): boolean {
  return (
    conclusion !== '' &&
    conclusion !== 'success' &&
    conclusion !== 'skipped' &&
    conclusion !== 'neutral'
  );
}

export function normalizeGitHubWebhook(
  eventType: string,
  deliveryId: string,
  payload: unknown
): NormalizedGitHubEvent | null {
  const root = asObject(payload);
  if (eventType === 'check_run') {
    return normalizeGitHubCheckRun({
      repo: repoFromPayload(root),
      checkRun: root.check_run,
      source: 'webhook',
      deliveryId,
      rawPayload: payload,
      sender: root.sender,
    });
  }
  if (eventType === 'check_suite') {
    return normalizeGitHubCheckSuite({
      repo: repoFromPayload(root),
      checkSuite: root.check_suite,
      deliveryId,
      rawPayload: payload,
      sender: root.sender,
    });
  }
  if (
    eventType !== 'issue_comment' &&
    eventType !== 'pull_request_review' &&
    eventType !== 'pull_request_review_comment' &&
    eventType !== 'pull_request_review_thread' &&
    eventType !== 'pull_request'
  ) {
    return null;
  }
  const action = getString(root.action, 'unknown');
  const repo = repoFromPayload(root);
  const sender = userFrom(root.sender);
  let prNumber = 0;
  let actor = sender;
  let body = '';
  let externalUrl = '';
  let externalId = `${eventType}:${deliveryId}`;
  let occurredAt = Date.now();
  let title = '';
  let commentId = '';
  let nodeId = '';
  let extraPayload: Record<string, unknown> = {};

  if (eventType === 'issue_comment') {
    const issue = asObject(root.issue);
    if (!asObject(issue.pull_request).url) return null;
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(issue.number);
    body = getString(comment.body);
    commentId = idString(comment.id);
    nodeId = getString(comment.node_id);
    externalId = `issue_comment:${commentId || deliveryId}:${action}`;
    externalUrl = getString(comment.html_url, prUrl(repo.owner, repo.repo, prNumber));
    occurredAt = parseGitHubTimestamp(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} comment`;
    extraPayload = {
      title,
      commentId,
      commentNodeId: nodeId,
      replyHandle: commentId ? { kind: 'issue_comment', commentId } : undefined,
    };
  } else if (eventType === 'pull_request_review') {
    const pr = asObject(root.pull_request);
    const review = asObject(root.review);
    actor = userFrom(review.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(review.body);
    const reviewId = idString(review.id);
    nodeId = getString(review.node_id);
    externalId = `review:${reviewId || deliveryId}:${action}`;
    externalUrl = getString(
      review.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
    occurredAt = parseGitHubTimestamp(review.submitted_at ?? review.updated_at);
    title = `PR #${prNumber} review ${getString(review.state, action)}`;
    extraPayload = {
      title,
      reviewId,
      reviewNodeId: nodeId,
      state: getString(review.state),
      submittedAt: getString(review.submitted_at),
    };
  } else if (eventType === 'pull_request_review_comment') {
    const pr = asObject(root.pull_request);
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(comment.body);
    // REST reply endpoint requires the ROOT review comment id, not the reply's
    // own id (docs: "This must be the ID of a top-level review comment, not a
    // reply to that comment."). Review threads are flat, so `in_reply_to_id`
    // points at the root when present; fall back to the comment's own id for
    // top-level comments. See https://docs.github.com/rest/pulls/comments.
    commentId = idString(comment.in_reply_to_id ?? comment.id);
    nodeId = getString(comment.node_id);
    const eventCommentId = idString(comment.id);
    externalId = `review_comment:${eventCommentId || deliveryId}:${action}`;
    externalUrl = getString(
      comment.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
    occurredAt = parseGitHubTimestamp(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} inline review comment`;
    extraPayload = {
      title,
      commentId,
      commentNodeId: nodeId,
      replyHandle: commentId ? { kind: 'pull_request_review_comment', commentId } : undefined,
      path: getString(comment.path),
      line: getNumber(comment.line) || undefined,
      side: getString(comment.side),
      startLine: getNumber(comment.start_line) || undefined,
      startSide: getString(comment.start_side),
      originalLine: getNumber(comment.original_line) || undefined,
      originalSide: getString(comment.original_side),
      inReplyToId: getNumber(comment.in_reply_to_id) || undefined,
      pullRequestReviewId: getNumber(comment.pull_request_review_id) || undefined,
    };
  } else if (eventType === 'pull_request_review_thread') {
    const pr = asObject(root.pull_request);
    const thread = asObject(root.thread);
    // This is the one payload that carries the review-THREAD node id directly
    // (thread.node_id = `PullRequestReviewThread.id`), so the resolve/reply
    // mutations can act on it without a runtime GraphQL `reviewThreads` lookup.
    nodeId = getString(thread.node_id);
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const rootComment = asObject(comments[0]);
    actor = userFrom(root.sender);
    prNumber = getNumber(pr.number);
    body = getString(rootComment.body);
    // The thread's root (top-level) comment REST id powers the reply endpoint.
    commentId = idString(rootComment.id);
    // Resolution toggles recur (resolve → unresolved → resolve again), so the
    // delivery id must be part of the identity or a later resolve would dedupe
    // against an earlier one (mirrors the `pull_request` action dedupe key).
    externalId = `pull_request_review_thread:${nodeId || deliveryId}:${action}:${deliveryId}`;
    externalUrl = getString(
      rootComment.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
    // `pr.updated_at` is bumped by the resolution action itself, so it is the
    // closest available proxy for when the thread was resolved/unresolved. The
    // root comment's timestamps only move when its body is edited (unrelated to
    // resolution), so they are fallbacks for thin payloads only.
    occurredAt = parseGitHubTimestamp(
      pr.updated_at ?? rootComment.updated_at ?? rootComment.created_at
    );
    title = `PR #${prNumber} review thread ${action}`;
    extraPayload = {
      title,
      threadId: nodeId,
      resolveHandle: nodeId ? { kind: 'pull_request_review_thread', threadId: nodeId } : undefined,
      commentNodeId: getString(rootComment.node_id),
      replyHandle: commentId ? { kind: 'pull_request_review_comment', commentId } : undefined,
      // Mirror the review-comment location projection. For OUTDATED threads
      // GitHub returns `line`/`side` (and `start_line`/`start_side`) as null but
      // retains the last-valid range in `original_line`/`original_side`/
      // `original_start_line`; carrying all of them keeps the resolved/unresolved
      // event actionable (e.g. the conversation-resolution rule can still locate
      // the full thread range) instead of dropping line context entirely.
      path: getString(rootComment.path),
      line: getNumber(rootComment.line) || undefined,
      side: getString(rootComment.side),
      startLine: getNumber(rootComment.start_line) || undefined,
      startSide: getString(rootComment.start_side),
      originalLine: getNumber(rootComment.original_line) || undefined,
      originalSide: getString(rootComment.original_side),
      originalStartLine: getNumber(rootComment.original_start_line) || undefined,
    };
  } else {
    const pr = asObject(root.pull_request);
    actor = userFrom(pr.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(pr.body);
    externalId = `pull_request:${getNumber(pr.id) || prNumber}:${action}:${deliveryId}`;
    externalUrl = getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber));
    occurredAt = parseGitHubTimestamp(pr.updated_at ?? pr.created_at);
    title = `PR #${prNumber} ${action}`;
    nodeId = getString(pr.node_id);
    extraPayload = {
      title: getString(pr.title, title),
      state: getString(pr.state),
      headSha: getString(asObject(pr.head).sha),
      merged: typeof pr.merged === 'boolean' ? pr.merged : undefined,
      draft: typeof pr.draft === 'boolean' ? pr.draft : undefined,
    };
  }
  if (!repo.owner || !repo.repo || !prNumber) return null;
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  return {
    deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: 'webhook',
    eventType,
    action,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: actor.login,
    actorType: actor.type,
    body,
    summary: `${title} by ${actor.login}${body ? `: ${truncateBody(body)}` : ''}`,
    externalUrl,
    externalId,
    commentId,
    nodeId,
    occurredAt,
    rawPayload: payload,
    payload: extraPayload,
  };
}

export function normalizeGitHubPollingRow(
  watched: GitHubPollingRepo,
  row: unknown,
  endpointKey: string
): NormalizedGitHubEvent | null {
  const obj = asObject(row);
  const apiUrl = getString(obj.url);
  const htmlUrl = getString(obj.html_url);
  let prNumber = 0;
  if (endpointKey === 'issue_comments') {
    const issue = asObject(obj.issue);
    const issuePullRequest = asObject(issue.pull_request);
    const issueUrl = getString(obj.issue_url);
    if (!issuePullRequest.url && !htmlUrl.includes('/pull/')) return null;
    const issueMatch = issueUrl.match(/\/issues\/(\d+)/);
    prNumber = getNumber(issue.number, issueMatch ? Number(issueMatch[1]) : 0);
  } else {
    const prMatch = htmlUrl.match(/\/pull\/(\d+)/) ?? apiUrl.match(/\/pulls\/(\d+)/);
    prNumber = prMatch ? Number(prMatch[1]) : getNumber(obj.number);
  }
  if (!prNumber) return null;
  const repo = resolvePollingRepo(watched, obj);
  const user = userFrom(obj.user);
  let eventType: GitHubEventKind = 'pull_request';
  if (endpointKey === 'issue_comments') eventType = 'issue_comment';
  if (endpointKey === 'review_comments') eventType = 'pull_request_review_comment';
  // REST numeric comment id is present on issue-comment and review-comment rows
  // (the handle `POST .../pulls/{n}/comments/{comment_id}/replies` needs). It is
  // absent on /pulls rows (a PR is not a comment). For review comments, resolve
  // to the ROOT comment id via `in_reply_to_id` (the reply endpoint rejects a
  // reply's own id; review threads are flat so it always points at the root).
  // Issue comments are not threaded, so their own id is correct. The GraphQL
  // `node_id` is present on all three row shapes.
  const commentId =
    endpointKey === 'review_comments'
      ? idString(obj.in_reply_to_id ?? obj.id)
      : endpointKey === 'issue_comments'
        ? idString(obj.id)
        : '';
  const nodeId = getString(obj.node_id);
  const id = getNumber(obj.id) || prNumber;
  const updatedAt = parseGitHubTimestamp(obj.updated_at ?? obj.created_at);
  // `pulls` rows bump updated_at on every comment/check/push, so keying the
  // dedupe on updated_at re-fires the same PR metadata every cycle. Re-emit
  // only when the head actually changes (a real push); comments/checks already
  // arrive via their own dedicated events. Fall back to updatedAt only when the
  // head is missing (deleted-head PRs) so the row still dedupes within a cycle.
  const headSha = endpointKey === 'pulls' ? getString(asObject(obj.head).sha) : '';
  const dedupeVersion =
    endpointKey === 'pulls'
      ? headSha || String(updatedAt)
      : getString(obj.updated_at ?? obj.created_at);
  const dedupeSuffix = dedupeVersion ? `:${dedupeVersion}` : '';
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  return {
    deliveryId: `poll:${eventType}:${id}${dedupeSuffix}`,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${eventType}:${id}${dedupeSuffix}`,
    source: 'polling',
    eventType,
    action: 'polled',
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: user.login,
    actorType: user.type,
    body: getString(obj.body),
    summary: `PR #${prNumber} ${eventType} by ${user.login}: ${truncateBody(getString(obj.body, getString(obj.title)))}`,
    externalUrl: htmlUrl || prUrl(repo.owner, repo.repo, prNumber),
    externalId: `${eventType}:${id}${dedupeSuffix}`,
    commentId,
    nodeId,
    occurredAt: updatedAt,
    rawPayload: row,
    payload: buildPollingPayload(eventType, obj),
  };
}

function buildPollingPayload(
  eventType: GitHubEventKind,
  obj: Record<string, unknown>
): Record<string, unknown> {
  if (eventType === 'issue_comment') {
    const commentId = idString(obj.id);
    return {
      title: `PR comment`,
      commentId,
      commentNodeId: getString(obj.node_id),
      replyHandle: commentId ? { kind: 'issue_comment', commentId } : undefined,
    };
  }
  if (eventType === 'pull_request_review_comment') {
    const commentId = idString(obj.in_reply_to_id ?? obj.id);
    const nodeId = getString(obj.node_id);
    return {
      title: `Inline review comment`,
      commentId,
      commentNodeId: nodeId,
      replyHandle: commentId ? { kind: 'pull_request_review_comment', commentId } : undefined,
      path: getString(obj.path),
      line: getNumber(obj.line) || undefined,
      side: getString(obj.side),
      startLine: getNumber(obj.start_line) || undefined,
      startSide: getString(obj.start_side),
      originalLine: getNumber(obj.original_line) || undefined,
      originalSide: getString(obj.original_side),
      inReplyToId: getNumber(obj.in_reply_to_id) || undefined,
      pullRequestReviewId: getNumber(obj.pull_request_review_id) || undefined,
    };
  }
  if (eventType === 'pull_request') {
    return {
      title: getString(obj.title),
      state: getString(obj.state),
      headSha: getString(asObject(obj.head).sha),
      merged:
        typeof obj.merged === 'boolean'
          ? obj.merged
          : typeof obj.merged_at === 'string' && obj.merged_at !== '',
      mergedAt: getString(obj.merged_at) || undefined,
      draft: typeof obj.draft === 'boolean' ? obj.draft : undefined,
    };
  }
  return {};
}

export function normalizeGitHubCheckRun(params: {
  repo: GitHubPollingRepo;
  checkRun: unknown;
  source: 'webhook' | 'polling';
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
  prNumber?: number;
  prScopedDedupe?: boolean;
}): NormalizedGitHubEvent | null {
  const checkRun = asObject(params.checkRun);
  if (params.source === 'webhook') {
    const action = getString(asObject(params.rawPayload).action);
    if (action !== 'completed') return null;
  }
  const status = getString(checkRun.status, params.source === 'webhook' ? 'completed' : '');
  if (status !== 'completed') return null;
  const conclusion = getString(checkRun.conclusion);
  if (!isFailedCheckConclusion(conclusion)) return null;
  const prs = Array.isArray(checkRun.pull_requests) ? checkRun.pull_requests : [];
  const pr = asObject(prs[0]);
  const prNumber = params.prNumber ?? getNumber(pr.number);
  const repo = params.repo;
  if (!repo.owner || !repo.repo || !prNumber) return null;
  const id = getNumber(checkRun.id);
  if (!id) return null;
  const sender = userFrom(params.sender);
  const actor = params.source === 'webhook' ? sender : userFrom(checkRun.app ?? params.sender);
  const name = getString(checkRun.name, 'check run');
  const headSha = getString(checkRun.head_sha);
  const htmlUrl = getString(checkRun.html_url, prUrl(repo.owner, repo.repo, prNumber));
  const occurredAt = parseGitHubTimestamp(
    checkRun.completed_at ?? checkRun.updated_at ?? checkRun.started_at
  );
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = params.prScopedDedupe
    ? `check_run:${id}:${conclusion}:${prNumber}`
    : `check_run:${id}:${conclusion}`;
  if (params.source === 'webhook') {
    const body = `${name} concluded with ${conclusion}`;
    return {
      deliveryId: params.deliveryId,
      dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
      source: params.source,
      eventType: 'check_run',
      action: 'completed',
      repoOwner: repo.owner,
      repoName: repo.repo,
      entityId: String(prNumber),
      prNumber,
      prUrl: prUrl(repo.owner, repo.repo, prNumber),
      actor: actor.login,
      actorType: actor.type,
      body,
      summary: `PR #${prNumber} check failed by ${actor.login}: ${truncateBody(body)}`,
      externalUrl: htmlUrl,
      externalId,
      commentId: '',
      nodeId: '',
      occurredAt,
      rawPayload: params.rawPayload,
      payload: { checkName: name, conclusion, runUrl: htmlUrl },
    };
  }
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: params.source,
    eventType: 'check_run',
    action: 'failed',
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: actor.login,
    actorType: actor.type,
    body: conclusion,
    summary: `PR #${prNumber} check ${name} ${conclusion}`,
    externalUrl: htmlUrl,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      checkRunId: id,
      name,
      checkName: name,
      conclusion,
      status,
      headSha,
      runUrl: htmlUrl,
    },
  };
}

/**
 * Normalizes a GitHub `status` webhook payload (the commit-status API used by
 * external/legacy CI — Jenkins, Travis, custom) into a PR-scoped event.
 *
 * Unlike `check_run`, the `status` payload carries a commit SHA but NO
 * `pull_request` reference, so the PR number must be resolved by the caller
 * (the SHA's open PR head) and passed in. One SHA can be the head of multiple
 * PRs, so the identity is scoped by PR — each PR tracks the status
 * independently and a re-delivery of the same status dedupes.
 *
 * The commit-status `state` (pending / success / failure / error) is carried
 * as the event `action` and re-expressed by {@link mapEventType} as
 * `pull_request/<id>.status_<state>`. All four states surface, including
 * `pending` (blocked-waiting-on-check).
 */
export function normalizeGitHubStatus(params: {
  repo: GitHubPollingRepo;
  status: unknown;
  prNumber: number;
  source: 'webhook' | 'polling';
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
}): NormalizedGitHubEvent | null {
  const status = asObject(params.status);
  const state = getString(status.state);
  if (!state) return null;
  const prNumber = params.prNumber;
  const repo = params.repo;
  if (!repo.owner || !repo.repo || !prNumber) return null;
  const id = getNumber(status.id);
  // `name` is the legacy field; `context` is the documented alias. Both carry
  // the CI label (e.g. "continuous-integration/jenkins").
  const context = getString(status.name, getString(status.context));
  const description = getString(status.description);
  const targetUrl = getString(status.target_url);
  const sha = getString(status.sha, getString(asObject(status.commit).sha));
  const sender = userFrom(params.sender);
  const occurredAt = parseGitHubTimestamp(status.updated_at ?? status.created_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  // The status `id` is globally unique per (context, sha, state), so it alone
  // disambiguates CI systems. When it is absent (a malformed payload — real
  // GitHub deliveries always include it), fall back to sha+context so two CI
  // systems posting the same state on the same SHA do not collide and silently
  // dedupe each other.
  const identity = id ? String(id) : `${sha}:${context}`;
  const externalId = `status:${identity}:${state}:${prNumber}`;
  const label = context || 'status';
  const body = `${label} ${state}${description ? `: ${description}` : ''}`;
  const htmlUrl = targetUrl || prUrl(repo.owner, repo.repo, prNumber);
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: params.source,
    eventType: 'status',
    action: state,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: sender.login,
    actorType: sender.type,
    body,
    summary: `PR #${prNumber} status ${state}${context ? ` (${context})` : ''} by ${sender.login}`,
    externalUrl: htmlUrl,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      state,
      description,
      targetUrl,
      context,
      sha,
      statusId: id || undefined,
    },
  };
}

/**
 * Normalize a `check_suite` webhook into a failed-only `.suite_failed` event,
 * mirroring `normalizeGitHubCheckRun`. Webhook-only: check suites have no
 * dedicated polling endpoint and are usually redundant with the finer-grained
 * check_run signal, so a polling path is not warranted.
 *
 * GitHub fires `action: 'completed'` once a suite finishes; we keep only
 * failed conclusions (via `isFailedCheckConclusion`, identical to check_run)
 * and drop success/skipped/neutral. A suite carries no `html_url` (it is not a
 * browsable entity) and no `completed_at`, so we link to the PR and resolve the
 * timestamp from `updated_at`/`created_at`.
 */
export function normalizeGitHubCheckSuite(params: {
  repo: GitHubPollingRepo;
  checkSuite: unknown;
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
}): NormalizedGitHubEvent | null {
  const checkSuite = asObject(params.checkSuite);
  const action = getString(asObject(params.rawPayload).action);
  if (action !== 'completed') return null;
  const status = getString(checkSuite.status, 'completed');
  if (status !== 'completed') return null;
  const conclusion = getString(checkSuite.conclusion);
  if (!isFailedCheckConclusion(conclusion)) return null;
  const prs = Array.isArray(checkSuite.pull_requests) ? checkSuite.pull_requests : [];
  const pr = asObject(prs[0]);
  const prNumber = getNumber(pr.number);
  const repo = params.repo;
  if (!repo.owner || !repo.repo || !prNumber) return null;
  const id = getNumber(checkSuite.id);
  if (!id) return null;
  const sender = userFrom(params.sender);
  const headSha = getString(checkSuite.head_sha);
  const appName = getString(asObject(checkSuite.app).name);
  const htmlUrl = prUrl(repo.owner, repo.repo, prNumber);
  const occurredAt = parseGitHubTimestamp(checkSuite.updated_at ?? checkSuite.created_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = `check_suite:${id}:${conclusion}`;
  const body = `check suite concluded with ${conclusion}`;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: 'webhook',
    eventType: 'check_suite',
    action: 'completed',
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: htmlUrl,
    actor: sender.login,
    actorType: sender.type,
    body,
    summary: `PR #${prNumber} check suite failed by ${sender.login}: ${truncateBody(body)}`,
    externalUrl: htmlUrl,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: { suiteId: id, conclusion, headSha, app: appName },
  };
}

export function normalizeGitHubDeployment(params: {
  repo: GitHubPollingRepo;
  deployment: unknown;
  source: 'webhook' | 'polling';
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
  prNumber?: number;
}): NormalizedGitHubEvent | null {
  const deployment = asObject(params.deployment);
  const repo = params.repo;
  const prNumber = params.prNumber ?? 0;
  const id = getNumber(deployment.id);
  // GitHub deployment/deployment_status payloads carry no pull_requests array,
  // so the PR is resolved out-of-band (commit/branch lookup) before this runs.
  // An unresolvable deployment (e.g. to the default branch) is intentionally
  // dropped — it is not attributable to a tracked PR.
  if (!repo.owner || !repo.repo || !prNumber || !id) return null;
  const action = getString(asObject(params.rawPayload).action, 'created');
  const environment = getString(deployment.environment);
  const ref = getString(deployment.ref);
  const sha = getString(deployment.sha);
  const task = getString(deployment.task);
  const description = getString(deployment.description);
  const creator = userFrom(deployment.creator ?? params.sender);
  const occurredAt = parseGitHubTimestamp(deployment.created_at ?? deployment.updated_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = `deployment:${id}:${action}`;
  const body = description || `deployment${environment ? ` to ${environment}` : ''}`;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: params.source,
    eventType: 'deployment',
    action,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: creator.login,
    actorType: creator.type,
    body,
    summary: `PR #${prNumber} deployment${environment ? ` to ${environment}` : ''} ${action} by ${creator.login}`,
    externalUrl: prUrl(repo.owner, repo.repo, prNumber),
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      deploymentId: id,
      environment,
      ref,
      sha,
      task,
      description,
      creator: creator.login,
    },
  };
}

export function normalizeGitHubDeploymentStatus(params: {
  repo: GitHubPollingRepo;
  deploymentStatus: unknown;
  /** The top-level `deployment` object (sibling of `deployment_status` in the
   * webhook payload), passed in by the handler so ref/sha/deploymentId survive
   * — GitHub does NOT nest `deployment` under `deployment_status`. Falls back to
   * `status.deployment` for defensive compatibility. */
  deployment?: unknown;
  source: 'webhook' | 'polling';
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
  prNumber?: number;
}): NormalizedGitHubEvent | null {
  const status = asObject(params.deploymentStatus);
  const repo = params.repo;
  const prNumber = params.prNumber ?? 0;
  const id = getNumber(status.id);
  if (!repo.owner || !repo.repo || !prNumber || !id) return null;
  // The deployment_status webhook action is always `created`; the meaningful
  // dimension is `state` (success/error/failure/inactive/in_progress/queued/
  // pending). Carry `state` as the topic action so the suffix reflects it
  // (`.deployment_status_success`); preserve the raw webhook action separately.
  const state = getString(status.state);
  if (!state) return null;
  const deployment = asObject(params.deployment ?? status.deployment);
  const environment = getString(status.environment, getString(deployment.environment));
  const ref = getString(deployment.ref);
  const sha = getString(deployment.sha);
  const deploymentId = getNumber(deployment.id);
  const description = getString(status.description);
  const targetUrl = getString(status.target_url);
  const logUrl = getString(status.log_url);
  const creator = userFrom(status.creator ?? params.sender);
  const occurredAt = parseGitHubTimestamp(status.created_at ?? status.updated_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = `deployment_status:${id}:${state}`;
  const externalUrl = targetUrl || logUrl || prUrl(repo.owner, repo.repo, prNumber);
  const body = description || `deployment ${state}`;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: params.source,
    eventType: 'deployment_status',
    action: state,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: creator.login,
    actorType: creator.type,
    body,
    summary: `PR #${prNumber} deployment_status ${state}${
      environment ? ` (${environment})` : ''
    } by ${creator.login}`,
    externalUrl,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      deploymentStatusId: id,
      state,
      webhookAction: getString(asObject(params.rawPayload).action, 'created'),
      environment,
      description,
      targetUrl,
      logUrl,
      ref,
      sha,
      deploymentId: deploymentId || undefined,
      creator: creator.login,
    },
  };
}

export function normalizeGitHubReaction(
  watched: GitHubPollingRepo,
  prNumber: number,
  reaction: unknown
): NormalizedGitHubEvent | null {
  const obj = asObject(reaction);
  const id = getNumber(obj.id);
  if (!id || !prNumber) return null;
  const user = userFrom(obj.user);
  const createdAt = getString(obj.created_at);
  const occurredAt = parseGitHubTimestamp(createdAt);
  const canonicalOwner = watched.owner.toLowerCase();
  const canonicalRepo = watched.repo.toLowerCase();
  const repoFullName = `${watched.owner}/${watched.repo}`;
  const content = getString(obj.content);
  return {
    deliveryId: `poll:reaction:${id}`,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:reaction:${id}`,
    source: 'polling',
    eventType: 'reaction',
    action: 'added',
    repoOwner: watched.owner,
    repoName: watched.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(watched.owner, watched.repo, prNumber),
    actor: user.login,
    actorType: user.type,
    body: content,
    summary: `PR #${prNumber} reaction ${content} by ${user.login}`,
    externalUrl: prUrl(watched.owner, watched.repo, prNumber),
    externalId: `reaction:${id}`,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: reaction,
    payload: {
      type: 'reaction',
      content,
      user: user.login,
      userType: user.type,
      createdAt,
      prNumber,
      repo: repoFullName,
    },
  };
}

export interface GitHubTopicParts {
  resource: string;
  entityId: string;
  action: string;
}

export function mapEventType(
  kind: GitHubEventKind,
  action: string,
  entityId: string
): GitHubTopicParts {
  switch (kind) {
    case 'issue_comment':
      return { resource: 'pull_request', entityId, action: `comment_${action}` };
    case 'pull_request_review':
      return { resource: 'pull_request', entityId, action: `review_${action}` };
    case 'pull_request_review_comment':
      return { resource: 'pull_request', entityId, action: `review_comment_${action}` };
    case 'pull_request_review_thread':
      return { resource: 'pull_request', entityId, action: `thread_${action}` };
    case 'reaction':
      return { resource: 'pull_request', entityId, action: `reaction_${action}` };
    case 'check_run':
      return { resource: 'pull_request', entityId, action: 'check_failed' };
    case 'status':
      // `action` carries the commit-status state (pending/success/failure/error),
      // re-expressed as pull_request/<id>.status_<state>.
      return { resource: 'pull_request', entityId, action: `status_${action}` };
    case 'check_suite':
      return { resource: 'pull_request', entityId, action: 'suite_failed' };
    case 'pull_request':
      return { resource: 'pull_request', entityId, action };
    case 'deployment':
      // A deployment webhook only fires `created`; the topic suffix reflects it.
      return { resource: 'pull_request', entityId, action: `deployment_${action}` };
    case 'deployment_status':
      // `action` here is the deployment_status state (success/failure/...); the
      // webhook action is always `created` and is preserved separately in payload.
      return { resource: 'pull_request', entityId, action: `deployment_status_${action}` };
  }
}

export function toExternalEvent(spaceId: string, event: NormalizedGitHubEvent): ExternalEvent {
  const repoOwner = event.repoOwner.toLowerCase();
  const repoName = event.repoName.toLowerCase();
  const { resource, entityId, action } = mapEventType(
    event.eventType,
    event.action,
    event.entityId
  );

  return {
    id: crypto.randomUUID(),
    spaceId,
    topic: `github/${repoOwner}/${repoName}/${resource}/${entityId}.${action}`,
    occurredAt: event.occurredAt,
    ingestedAt: Date.now(),
    source: 'github',
    sourceEventId: event.deliveryId,
    summary: event.summary,
    externalUrl: event.externalUrl || event.prUrl,
    payload: {
      eventType: event.eventType,
      action: event.action,
      source: event.source,
      prUrl: event.prUrl,
      prNumber: event.prNumber,
      entityId: event.entityId,
      repoOwner,
      repoName,
      deliveryId: event.deliveryId,
      externalId: event.externalId,
      actor: event.actor,
      actorType: event.actorType,
      body: event.body,
      commentId: event.commentId,
      nodeId: event.nodeId,
      rawPayload: event.rawPayload,
      ...event.payload,
    },
    dedupeKey: event.dedupeKey,
  };
}
