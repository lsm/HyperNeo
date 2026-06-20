import type { ExternalEvent } from '../types';

export type GitHubEventKind =
  | 'issue_comment'
  | 'pull_request_review'
  | 'pull_request_review_comment'
  | 'pull_request'
  | 'reaction';

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

function parseTs(value: unknown): number {
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

export function normalizeGitHubWebhook(
  eventType: string,
  deliveryId: string,
  payload: unknown
): NormalizedGitHubEvent | null {
  if (
    eventType !== 'issue_comment' &&
    eventType !== 'pull_request_review' &&
    eventType !== 'pull_request_review_comment' &&
    eventType !== 'pull_request'
  ) {
    return null;
  }
  const root = asObject(payload);
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

  if (eventType === 'issue_comment') {
    const issue = asObject(root.issue);
    if (!asObject(issue.pull_request).url) return null;
    const comment = asObject(root.comment);
    actor = userFrom(comment.user ?? root.sender);
    prNumber = getNumber(issue.number);
    body = getString(comment.body);
    externalId = `issue_comment:${getNumber(comment.id) || deliveryId}:${action}`;
    externalUrl = getString(comment.html_url, prUrl(repo.owner, repo.repo, prNumber));
    occurredAt = parseTs(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} comment`;
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
    occurredAt = parseTs(review.submitted_at ?? review.updated_at);
    title = `PR #${prNumber} review ${getString(review.state, action)}`;
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
    occurredAt = parseTs(comment.updated_at ?? comment.created_at);
    title = `PR #${prNumber} inline review comment`;
  } else {
    const pr = asObject(root.pull_request);
    actor = userFrom(pr.user ?? root.sender);
    prNumber = getNumber(pr.number);
    body = getString(pr.body);
    externalId = `pull_request:${getNumber(pr.id) || prNumber}:${action}:${deliveryId}`;
    externalUrl = getString(pr.html_url, prUrl(repo.owner, repo.repo, prNumber));
    occurredAt = parseTs(pr.updated_at ?? pr.created_at);
    title = `PR #${prNumber} ${action}`;
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
  const id = getNumber(obj.id) || prNumber;
  const updatedAt = parseTs(obj.updated_at ?? obj.created_at);
  const dedupeVersion =
    endpointKey === 'pulls' ? String(updatedAt) : getString(obj.updated_at ?? obj.created_at);
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
    occurredAt: updatedAt,
    rawPayload: row,
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
  const occurredAt = parseTs(createdAt);
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
      rawPayload: event.rawPayload,
      ...event.payload,
    },
    dedupeKey: event.dedupeKey,
  };
}
