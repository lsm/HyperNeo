import type { ExternalEvent } from '../types';

export type GitHubEventKind =
  | 'issue_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request'
  | 'check_run'
  | 'reaction';

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
 *   own id (issue comments are not threaded). Populated for issue-comment and
 *   review-comment events; empty for reviews, PRs, check runs, and reactions.
 * - `nodeId`: the GraphQL `node_id` of the event's primary entity (the comment,
 *   review, or pull request).
 *
 * The review-THREAD node id that `resolveReviewThread`
 * (`ResolveReviewThreadInput.threadId` = `PullRequestReviewThread.id`) and
 * `addPullRequestReviewThreadReply` (`pullRequestReviewThreadId`) require is
 * intentionally NOT captured: a comment's `node_id` is NOT its thread's node id,
 * and GitHub does not include the thread node id in webhook payloads or the REST
 * `/pulls/comments` response. It must be resolved at runtime by querying the PR's
 * `reviewThreads` connection, so it belongs to the consumer, not the normalizer.
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

function repoFromPayload(payload: Record<string, unknown>): { owner: string; repo: string } {
  const repository = asObject(payload.repository);
  const owner = asObject(repository.owner);
  const fullName = getString(repository.full_name);
  const [fullOwner, fullRepo] = fullName.split('/');
  return {
    owner: getString(owner.login, fullOwner ?? ''),
    repo: getString(repository.name, fullRepo ?? ''),
  };
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
  if (
    eventType !== 'issue_comment' &&
    eventType !== 'pull_request_review' &&
    eventType !== 'pull_request_review_comment' &&
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

  if (eventType === 'issue_comment') {
    const issue = asObject(root.issue);
    if (!asObject(issue.pull_request).url) return null;
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(issue.number);
    body = getString(comment.body);
    externalId = `issue_comment:${getNumber(comment.id) || deliveryId}:${action}`;
    externalUrl = getString(comment.html_url, prUrl(repo.owner, repo.repo, prNumber));
    occurredAt = parseGitHubTimestamp(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} comment`;
    commentId = idString(comment.id);
    nodeId = getString(comment.node_id);
  } else if (eventType === 'pull_request_review') {
    const pr = asObject(root.pull_request);
    const review = asObject(root.review);
    actor = userFrom(review.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(review.body);
    externalId = `review:${getNumber(review.id) || deliveryId}:${action}`;
    externalUrl = getString(
      review.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
    occurredAt = parseGitHubTimestamp(review.submitted_at ?? review.updated_at);
    title = `PR #${prNumber} review ${getString(review.state, action)}`;
    nodeId = getString(review.node_id);
  } else if (eventType === 'pull_request_review_comment') {
    const pr = asObject(root.pull_request);
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(comment.body);
    externalId = `review_comment:${getNumber(comment.id) || deliveryId}:${action}`;
    externalUrl = getString(
      comment.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
    occurredAt = parseGitHubTimestamp(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} inline review comment`;
    // REST reply endpoint requires the ROOT review comment id, not the reply's
    // own id (docs: "This must be the ID of a top-level review comment, not a
    // reply to that comment."). Review threads are flat, so `in_reply_to_id`
    // points at the root when present; fall back to the comment's own id for
    // top-level comments. See https://docs.github.com/rest/pulls/comments.
    commentId = idString(comment.in_reply_to_id ?? comment.id);
    nodeId = getString(comment.node_id);
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
  const canonicalOwner = watched.owner.toLowerCase();
  const canonicalRepo = watched.repo.toLowerCase();
  return {
    deliveryId: `poll:${eventType}:${id}${dedupeSuffix}`,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${eventType}:${id}${dedupeSuffix}`,
    source: 'polling',
    eventType,
    action: 'polled',
    repoOwner: watched.owner,
    repoName: watched.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(watched.owner, watched.repo, prNumber),
    actor: user.login,
    actorType: user.type,
    body: getString(obj.body),
    summary: `PR #${prNumber} ${eventType} by ${user.login}: ${truncateBody(getString(obj.body, getString(obj.title)))}`,
    externalUrl: htmlUrl || prUrl(watched.owner, watched.repo, prNumber),
    externalId: `${eventType}:${id}${dedupeSuffix}`,
    commentId,
    nodeId,
    occurredAt: updatedAt,
    rawPayload: row,
  };
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
    case 'reaction':
      return { resource: 'pull_request', entityId, action: `reaction_${action}` };
    case 'check_run':
      return { resource: 'pull_request', entityId, action: 'check_failed' };
    case 'pull_request':
      return { resource: 'pull_request', entityId, action };
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
