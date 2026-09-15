import { runGhJson } from '../gh-lookup-helpers.ts';
import type { SpawnFn } from '../../runtime-spawn/index.ts';
import type { ConnectorContext, ConnectorOutcome } from './connector.ts';

interface ReviewThreadsPage {
  nodes: Array<{ id?: string; isResolved: boolean; comments: { nodes: Array<{ url: string }> } }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

export async function fetchUnresolvedReviewThreads(
  meta: { host: string; owner: string; repo: string; number: string },
  ctx: ConnectorContext,
  spawnImpl: SpawnFn
): Promise<ConnectorOutcome> {
  const urls: string[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 50; page++) {
    const query = cursor
      ? 'query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}'
      : 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url}}} pageInfo{hasNextPage endCursor}}}}}';
    const args = [
      'gh',
      'api',
      'graphql',
      '--hostname',
      meta.host,
      '-f',
      `owner=${meta.owner}`,
      '-f',
      `name=${meta.repo}`,
      '-F',
      `number=${meta.number}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    args.push('-f', `query=${query}`);
    const outcome = await runGhJson(args, ctx.workspacePath || '/tmp', spawnImpl, {
      hostHint: meta.host,
      resourceHint: 'graphql',
    });
    if (!outcome.ok) return outcome;

    const threads = (
      outcome.data as {
        data?: { repository?: { pullRequest?: { reviewThreads?: ReviewThreadsPage } } };
      }
    )?.data?.repository?.pullRequest?.reviewThreads;
    if (!threads) {
      return { ok: false, error: 'Incomplete GraphQL response — reviewThreads missing' };
    }
    for (const node of threads.nodes) {
      if (!node.isResolved) {
        urls.push(node.comments.nodes[0]?.url ?? node.id ?? '<unknown>');
      }
    }
    if (!threads.pageInfo.hasNextPage) break;
    cursor = threads.pageInfo.endCursor;
    if (!cursor) {
      return { ok: false, error: 'Incomplete pagination: hasNextPage true but endCursor missing' };
    }
  }

  return { ok: true, data: { unresolvedThreadUrls: urls } };
}
