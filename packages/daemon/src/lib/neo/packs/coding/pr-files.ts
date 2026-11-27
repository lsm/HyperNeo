import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import type { ParsedPrUrl } from '../../../github/parse-pr-url.ts';
import type { SpawnFn } from '../../../runtime-spawn/index.ts';

const Head = z.string().regex(/^[a-f\d]{40}$/i);
const FilePage = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        headRefOid: Head,
        baseRefOid: Head,
        files: z.object({
          nodes: z.array(z.object({ path: z.string() })),
          pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        }),
      }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

export const CodingPrFilePages = z.array(FilePage).min(1);

export function readCodingPrFilePages(meta: ParsedPrUrl, cwd: string, spawn: SpawnFn) {
  return runGhJson(
    [
      'gh',
      'api',
      'graphql',
      '--hostname',
      meta.host,
      '--paginate',
      '--slurp',
      '-f',
      `owner=${meta.owner}`,
      '-f',
      `name=${meta.repo}`,
      '-F',
      `number=${meta.number}`,
      '-f',
      'query=query CodingMergeFiles($owner:String!,$name:String!,$number:Int!,$endCursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid files(first:100,after:$endCursor){nodes{path} pageInfo{hasNextPage endCursor}}}}}',
    ],
    cwd,
    spawn,
    { firstPage: true }
  );
}

export function codingPrFilePagesMatch(
  pages: z.infer<typeof CodingPrFilePages>,
  revision: { headRefOid: string; baseRefOid: string }
): boolean {
  return pages.every((page, index) => {
    const snapshot = page.data.repository.pullRequest;
    return (
      !page.errors?.length &&
      snapshot.headRefOid === revision.headRefOid &&
      snapshot.baseRefOid === revision.baseRefOid &&
      snapshot.files.pageInfo.hasNextPage === index < pages.length - 1 &&
      (!snapshot.files.pageInfo.hasNextPage || !!snapshot.files.pageInfo.endCursor)
    );
  });
}
