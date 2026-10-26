#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const control = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'));
const { phase, scenario, now } = control;
const repo = 'synthetic/ledger';
const url = `https://github.com/${repo}/pull/7`;
const head = (phase === 'changed' ? 'b' : 'a').repeat(40);
const merged = scenario !== 'head';
const when = new Date(now - 60_000).toISOString();
const createdAt = new Date(now - 7200_000).toISOString();
const state = merged ? 'MERGED' : 'OPEN';
const pr = { url, number: 7, title: 'Synthetic shared fact', state, headRefOid: head,
  headRefName: 'synthetic-branch', baseRefName: 'dev', mergeStateStatus: merged ? 'CLEAN' : 'BLOCKED',
  createdAt, updatedAt: when, mergedAt: merged ? when : null, closedAt: merged ? when : null,
  mergeCommit: merged ? { oid: 'c'.repeat(40) } : null,
  reviews: [{ state: 'APPROVED', commit: { oid: 'a'.repeat(40) }, author: { login: 'synthetic-reviewer' } }],
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], body: 'Closes #3', closingIssuesReferences: [{ number: 3 }] };
const query = args.find(arg => arg.startsWith('query=')) ?? '';
let family = '', body: unknown;
if (args[0] === 'api' && args[1].startsWith(`repos/${repo}/pulls?`)) {
  family = 'ledger-discovery';
  const closed = args[1].includes('state=closed');
  body = phase === 'partial' ? {} : phase === 'empty' || closed !== merged ? [] : [{ number: 7, title: pr.title, head: { ref: pr.headRefName, sha: head }, updated_at: when, created_at: createdAt, closed_at: pr.closedAt, merged_at: pr.mergedAt, draft: false, base: { repo: { full_name: repo } } }];
} else if (args[0] === 'pr' && args[1] === 'view') {
  family = args.includes('state,mergeCommit') ? 'deploy-merge' : 'work-detail'; body = pr;
} else if (args[0] === 'pr' && args[1] === 'list') {
  family = args.includes('--head') ? 'branch-membership' : 'query-window'; body = phase === 'empty' ? [] : [pr];
} else if (args[0] === 'api' && args.includes('graphql')) {
  if (query.includes('rateLimit')) {
    family = 'ledger-reconcile';
    const node = { ...pr, isDraft: false, mergeable: 'MERGEABLE', reviewDecision: null,
      reviews: { nodes: pr.reviews }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } };
    body = { data: { rateLimit: { cost: 7, remaining: 4900, resetAt: new Date(now + 3600_000).toISOString() },
      repository: { nameWithOwner: repo, p7: node } } };
  } else if (query.includes('issueOrPullRequest')) {
    const issue = args.includes('p=3');
    family = issue ? 'issue-reference' : 'ask-reference';
    body = { data: { repository: { defaultBranchRef: { name: 'dev' }, issueOrPullRequest: issue
      ? { __typename: 'Issue', url: `https://github.com/${repo}/issues/3`, state: 'CLOSED', stateReason: 'COMPLETED', closedAt: when, parent: { url: `https://github.com/${repo}/issues/1` }, closedByPullRequestsReferences: { nodes: [{ url, merged: true, baseRefName: 'dev', mergedAt: when }] } }
      : { ...pr, __typename: 'PullRequest' } } } };
  } else {
    family = 'work-blockers'; body = { data: { repository: { pullRequest: { commits: { nodes: [{ commit: { oid: head, signature: { isValid: true } } }] }, reviewThreads: { nodes: [{ isResolved: false }] } } } } };
  }
} else if (args[0] === 'api' && args.some(arg => arg.includes('/compare/'))) {
  family = 'deploy-ancestry'; body = { status: 'ahead' };
} else if (args[0] === 'api' && args.some(arg => arg.includes('/rules/branches/'))) {
  family = 'work-rules'; body = [{ type: 'pull_request', parameters: { required_review_thread_resolution: true } }];
} else {
  process.stderr.write('unsupported synthetic request'); process.exit(2);
}
appendFileSync(join(root, 'evidence', 'requests.jsonl'), `${JSON.stringify({ phase, family, graphqlCost: family === 'ledger-reconcile' ? 7 : null })}\n`);
if (phase === 'failed') { process.stderr.write('HTTP 404: synthetic fixture unavailable'); process.exit(1); }
if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n');
process.stdout.write(JSON.stringify(body));
