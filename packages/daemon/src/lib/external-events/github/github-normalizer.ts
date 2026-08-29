import type { ExternalEvent } from '../types.ts';
import { Logger } from '../../logger.ts';
import { checkRunTopicAction } from './github-check-run-fields.ts';

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
  | 'deployment_status'
  | 'branch_protection_rule'
  | 'merge_group';

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
  commentId: string;
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
  const apiMatch = url.match(/\/repos\/([^/]+)\/([^/]+)(?:\/|$)/);
  if (apiMatch) {
    const [, owner, repo] = apiMatch;
    if (owner && repo) return { owner, repo };
  }
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

function isBotActor(login: string, type: string): boolean {
  return type === 'Bot' || login.endsWith('[bot]');
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
  if (eventType === 'branch_protection_rule') {
    return normalizeGitHubBranchProtectionRule({
      repo: repoFromPayload(root),
      rule: root.rule,
      action: getString(root.action),
      sender: root.sender,
      deliveryId,
      rawPayload: payload,
    });
  }
  if (eventType === 'merge_group') {
    return normalizeGitHubMergeGroup({
      repo: repoFromPayload(root),
      mergeGroup: root.merge_group,
      action: getString(root.action),
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
      state: getString(review.state).toUpperCase(),
      reviewer: actor.login,
      reviewerBot: isBotActor(actor.login, actor.type),
      submittedAt: getString(review.submitted_at),
      commitId: getString(review.commit_id) || undefined,
    };
  } else if (eventType === 'pull_request_review_comment') {
    const pr = asObject(root.pull_request);
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(comment.body);
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
    nodeId = getString(thread.node_id);
    const comments = Array.isArray(thread.comments) ? thread.comments : [];
    const rootComment = asObject(comments[0]);
    actor = userFrom(root.sender);
    prNumber = getNumber(pr.number);
    body = getString(rootComment.body);
    commentId = idString(rootComment.id);
    externalId = `pull_request_review_thread:${nodeId || deliveryId}:${action}:${deliveryId}`;
    externalUrl = getString(
      rootComment.html_url,
      getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber))
    );
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
    actor = userFrom(root.sender ?? pr.user);
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
  const commentId =
    endpointKey === 'review_comments'
      ? idString(obj.in_reply_to_id ?? obj.id)
      : endpointKey === 'issue_comments'
        ? idString(obj.id)
        : '';
  const nodeId = getString(obj.node_id);
  const id = getNumber(obj.id) || prNumber;
  const updatedAt = parseGitHubTimestamp(obj.updated_at ?? obj.created_at);
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
  const topicAction = checkRunTopicAction(conclusion);
  if (!topicAction) return null;
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
      action: topicAction,
      repoOwner: repo.owner,
      repoName: repo.repo,
      entityId: String(prNumber),
      prNumber,
      prUrl: prUrl(repo.owner, repo.repo, prNumber),
      actor: actor.login,
      actorType: actor.type,
      body,
      summary: `PR #${prNumber} check ${topicAction} by ${actor.login}: ${truncateBody(body)}`,
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
    action: topicAction,
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
  const context = getString(status.name, getString(status.context));
  const description = getString(status.description);
  const targetUrl = getString(status.target_url);
  const sha = getString(status.sha, getString(asObject(status.commit).sha));
  const sender = userFrom(params.sender);
  const occurredAt = parseGitHubTimestamp(status.updated_at ?? status.created_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
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
  const topicAction = checkRunTopicAction(conclusion);
  if (!topicAction || topicAction === 'skipped') return null;
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
    action: topicAction,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: htmlUrl,
    actor: sender.login,
    actorType: sender.type,
    body,
    summary: `PR #${prNumber} check suite ${topicAction} by ${sender.login}: ${truncateBody(body)}`,
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
  const externalId = `deployment:${id}:${action}:${prNumber}`;
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
  const state = getString(status.state);
  if (!state) return null;
  if (state === 'inactive') return null;
  const deployment = asObject(params.deployment ?? status.deployment);
  const environment = getString(status.environment, getString(deployment.environment));
  const ref = getString(deployment.ref);
  const sha = getString(deployment.sha);
  const deploymentId = getNumber(deployment.id);
  const description = getString(status.description);
  const targetUrl = getString(status.target_url);
  const environmentUrl = getString(status.environment_url);
  const logUrl = getString(status.log_url);
  const creator = userFrom(status.creator ?? params.sender);
  const occurredAt = parseGitHubTimestamp(status.created_at ?? status.updated_at);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = `deployment_status:${id}:${state}:${prNumber}`;
  const externalUrl =
    targetUrl || environmentUrl || logUrl || prUrl(repo.owner, repo.repo, prNumber);
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
      environmentUrl,
      logUrl,
      ref,
      sha,
      deploymentId: deploymentId || undefined,
      creator: creator.login,
    },
  };
}

function sanitizeBranchTopicSegment(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export function normalizeGitHubBranchProtectionRule(params: {
  repo: { owner: string; repo: string };
  rule: unknown;
  action: string;
  sender?: unknown;
  deliveryId: string;
  rawPayload: unknown;
}): NormalizedGitHubEvent | null {
  const rule = asObject(params.rule);
  const repo = params.repo;
  if (!repo.owner || !repo.repo) return null;
  const branchName = getString(rule.name);
  if (!branchName) return null;
  const ruleId = getNumber(rule.id);
  const action = params.action || 'unknown';
  const sender = userFrom(params.sender);
  const title = `Branch protection rule "${branchName}" ${action}`;
  const changedFields = Object.keys(asObject(asObject(params.rawPayload).changes));
  const body = changedFields.length ? changedFields.join(', ') : '';
  const entityId = sanitizeBranchTopicSegment(branchName);
  const externalId = `branch_protection_rule:${branchName}:${action}:${params.deliveryId}`;
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const repoUrl = `https://github.com/${repo.owner}/${repo.repo}`;
  const externalUrl = `${repoUrl}/settings/branches`;
  const occurredAt = parseGitHubTimestamp(rule.updated_at ?? rule.created_at);
  const requiredChecks = Array.isArray(rule.required_status_checks)
    ? (rule.required_status_checks as unknown[])
        .map((check) => {
          const ctx = asObject(check).context;
          return typeof ctx === 'string' ? ctx : typeof check === 'string' ? check : '';
        })
        .filter((check): check is string => check !== '')
    : undefined;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: 'webhook',
    eventType: 'branch_protection_rule',
    action,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId,
    prNumber: 0,
    prUrl: repoUrl,
    actor: sender.login,
    actorType: sender.type,
    body,
    summary: `${title} by ${sender.login}${body ? `: ${truncateBody(body)}` : ''}`,
    externalUrl,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      title,
      ruleId: ruleId ? String(ruleId) : undefined,
      ruleName: branchName,
      adminEnforced: typeof rule.admin_enforced === 'boolean' ? rule.admin_enforced : undefined,
      requiredStatusChecksEnforcementLevel:
        getString(rule.required_status_checks_enforcement_level) || undefined,
      pullRequestReviewsEnforcementLevel:
        getString(rule.pull_request_reviews_enforcement_level) || undefined,
      requiredApprovingReviewCount:
        typeof rule.required_approving_review_count === 'number'
          ? rule.required_approving_review_count
          : undefined,
      requireCodeOwnerReview:
        typeof rule.require_code_owner_review === 'boolean'
          ? rule.require_code_owner_review
          : undefined,
      requiredConversationResolutionLevel:
        getString(rule.required_conversation_resolution_level) || undefined,
      linearHistoryRequirementEnforcementLevel:
        getString(rule.linear_history_requirement_enforcement_level) || undefined,
      strictRequiredStatusChecksPolicy:
        typeof rule.strict_required_status_checks_policy === 'boolean'
          ? rule.strict_required_status_checks_policy
          : undefined,
      requiredStatusChecks: requiredChecks?.length ? requiredChecks : undefined,
      changedFields: changedFields.length ? changedFields : undefined,
    },
  };
}

function parseMergeQueuePrNumber(headRef: string): number {
  const match = headRef.match(/\/pr-(\d+)-[^/]+$/);
  return match ? Number(match[1]) : 0;
}

export function normalizeGitHubMergeGroup(params: {
  repo: GitHubPollingRepo;
  mergeGroup: unknown;
  action: string;
  source: 'webhook' | 'polling';
  deliveryId: string;
  rawPayload: unknown;
  sender?: unknown;
}): NormalizedGitHubEvent | null {
  if (params.action !== 'checks_requested' && params.action !== 'destroyed') return null;
  const group = asObject(params.mergeGroup);
  const headSha = getString(group.head_sha);
  if (!headSha) return null;
  const repo = params.repo;
  if (!repo.owner || !repo.repo) return null;
  const headRef = getString(group.head_ref);
  const prNumber = parseMergeQueuePrNumber(headRef);
  if (!prNumber) return null;
  const sender = userFrom(params.sender);
  const headCommit = asObject(group.head_commit);
  const baseRef = getString(group.base_ref);
  const baseSha = getString(group.base_sha);
  const occurredAt = parseGitHubTimestamp(headCommit.timestamp);
  const externalId = `merge_group:${prNumber}:${headSha}:${params.action}`;
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const prLink = prUrl(repo.owner, repo.repo, prNumber);
  const summary =
    params.action === 'checks_requested'
      ? `PR #${prNumber} entered the merge queue`
      : `PR #${prNumber} merge group destroyed`;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: params.source,
    eventType: 'merge_group',
    action: params.action,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prLink,
    actor: sender.login,
    actorType: sender.type,
    body: '',
    summary,
    externalUrl: prLink,
    externalId,
    commentId: '',
    nodeId: '',
    occurredAt,
    rawPayload: params.rawPayload,
    payload: {
      headSha,
      headRef,
      baseRef,
      baseSha,
      headCommitId: getString(headCommit.id),
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

export function normalizeGitHubMergeConflict(params: {
  repo: GitHubPollingRepo;
  pullRequest: unknown;
  prNumber: number;
  conflicting: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  sequence: number;
  deliveryId: string;
}): NormalizedGitHubEvent | null {
  const watched = params.repo;
  const prNumber = params.prNumber;
  if (!watched.owner || !watched.repo || !prNumber) return null;
  const pr = asObject(params.pullRequest);
  const repo = resolvePollingRepo(watched, pr);
  const author = userFrom(pr.user);
  const occurredAt = Date.now();
  const action = params.conflicting ? 'merge_conflict' : 'merge_conflict_resolved';
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  const externalId = `merge_conflict:${prNumber}:${params.conflicting ? 'conflict' : 'resolved'}:${params.sequence}`;
  const summary = params.conflicting
    ? `PR #${prNumber} has merge conflicts with the base branch`
    : `PR #${prNumber} merge conflicts with the base branch resolved`;
  return {
    deliveryId: params.deliveryId,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:${externalId}`,
    source: 'polling',
    eventType: 'pull_request',
    action,
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: author.login,
    actorType: author.type,
    body: '',
    summary,
    externalUrl: getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber)),
    externalId,
    commentId: '',
    nodeId: getString(pr.node_id),
    occurredAt,
    rawPayload: params.pullRequest,
    payload: {
      title: summary,
      state: params.conflicting ? 'conflicting' : 'clean',
      mergeable: params.mergeable,
      mergeableState: params.mergeableState,
      headSha: getString(asObject(pr.head).sha),
    },
  };
}

const REVIEW_VERDICT_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED']);

export function normalizeGitHubReview(
  watched: GitHubPollingRepo,
  prNumber: number,
  review: unknown
): NormalizedGitHubEvent | null {
  const obj = asObject(review);
  const id = getNumber(obj.id);
  if (!id || !prNumber) return null;
  const state = getString(obj.state).toUpperCase();
  if (!REVIEW_VERDICT_STATES.has(state)) return null;
  const repo = resolvePollingRepo(watched, obj);
  if (!repo.owner || !repo.repo) return null;
  const user = userFrom(obj.user);
  const submittedAt = getString(obj.submitted_at);
  const body = getString(obj.body);
  const title = `PR #${prNumber} review ${state}`;
  const nodeId = getString(obj.node_id);
  const commitId = getString(obj.commit_id);
  const canonicalOwner = repo.owner.toLowerCase();
  const canonicalRepo = repo.repo.toLowerCase();
  return {
    deliveryId: `poll:review:${id}`,
    dedupeKey: `${canonicalOwner}/${canonicalRepo}:review:${id}:submitted`,
    source: 'polling',
    eventType: 'pull_request_review',
    action: 'submitted',
    repoOwner: repo.owner,
    repoName: repo.repo,
    entityId: String(prNumber),
    prNumber,
    prUrl: prUrl(repo.owner, repo.repo, prNumber),
    actor: user.login,
    actorType: user.type,
    body,
    summary: `${title} by ${user.login}${body ? `: ${truncateBody(body)}` : ''}`,
    externalUrl: getString(obj.html_url, prUrl(repo.owner, repo.repo, prNumber)),
    externalId: `review:${id}:submitted`,
    commentId: '',
    nodeId,
    occurredAt: parseGitHubTimestamp(submittedAt),
    rawPayload: review,
    payload: {
      title,
      reviewId: String(id),
      reviewNodeId: nodeId,
      state,
      reviewer: user.login,
      reviewerType: user.type,
      reviewerBot: isBotActor(user.login, user.type),
      submittedAt,
      commitId: commitId || undefined,
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
      return { resource: 'pull_request', entityId, action: `check_${action}` };
    case 'status':
      return { resource: 'pull_request', entityId, action: `status_${action}` };
    case 'check_suite':
      return { resource: 'pull_request', entityId, action: `suite_${action}` };
    case 'pull_request':
      return {
        resource: 'pull_request',
        entityId,
        action: PR_TRANSITION_TOPIC[action] ?? action,
      };
    case 'deployment':
      return { resource: 'pull_request', entityId, action: `deployment_${action}` };
    case 'deployment_status':
      return { resource: 'pull_request', entityId, action: `deployment_status_${action}` };
    case 'branch_protection_rule':
      return { resource: 'repo', entityId, action: `branch_protection_${action}` };
    case 'merge_group':
      return { resource: 'pull_request', entityId, action: `merge_group_${action}` };
  }
}

const PR_TRANSITION_TOPIC: Record<string, string> = {
  converted_to_draft: 'draft_opened',
  ready_for_review: 'ready_for_review',
  enqueued: 'enqueued',
  dequeued: 'dequeued',
};

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
