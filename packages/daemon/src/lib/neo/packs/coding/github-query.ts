import { homedir } from 'node:os';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';

type Failure = { ok: false; reason: string };

const When = z.string().datetime({ offset: true });

export const NeoGithubQuery = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[\w.-]+\/[\w.-]+$/, 'repo is owner/name'),
  kind: z.enum(['pr', 'issue']).default('pr'),
  state: z.enum(['open', 'merged', 'closed', 'all']).default('all'),
  by: z.enum(['created', 'updated', 'merged', 'closed']).optional(),
  since: When.optional(),
  until: When.optional(),
  withinHours: z.number().int().min(1).max(720).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type NeoGithubQuery = z.infer<typeof NeoGithubQuery>;

const Item = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().nullable().default(null),
  closedAt: z.string().nullable().default(null),
});

export const NeoGithubQueryItems = z.array(Item);

type By = 'created' | 'updated' | 'merged' | 'closed';
export type NeoGithubCollection = Omit<NeoGithubQuery, 'by'> & { by: By };
type Plan = { query: NeoGithubQuery; by: By; search: string; args: string[] };

export function planNeoGithubQuery(
  input: NeoGithubQuery,
  now = Date.now()
): { value: Plan } | { reason: Failure } {
  if (input.withinHours && (input.since || input.until))
    return {
      reason: {
        ok: false,
        reason: 'one_window: pass withinHours alone, or since and until, not both.',
      },
    };
  const query = input.withinHours
    ? { ...input, since: new Date(now - input.withinHours * 3_600_000).toISOString() }
    : input;
  const by: By =
    query.by ??
    (query.state === 'merged' ? 'merged' : query.state === 'closed' ? 'closed' : 'created');
  if (query.kind === 'issue' && (query.state === 'merged' || by === 'merged'))
    return {
      reason: {
        ok: false,
        reason: 'issues_do_not_merge: list issues by created, updated or closed.',
      },
    };
  if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until))
    return { reason: { ok: false, reason: 'empty_window: since is after until.' } };
  const window =
    query.since && query.until
      ? `${by}:${query.since}..${query.until}`
      : query.since
        ? `${by}:>=${query.since}`
        : query.until
          ? `${by}:<=${query.until}`
          : '';
  const fields =
    query.kind === 'pr'
      ? 'number,title,url,state,createdAt,updatedAt,mergedAt,closedAt'
      : 'number,title,url,state,createdAt,updatedAt,closedAt';
  return {
    value: {
      query,
      by,
      search: window,
      args: [
        'gh',
        query.kind,
        'list',
        '--repo',
        query.repo,
        '--state',
        query.state,
        '--limit',
        String(query.limit + 1),
        '--json',
        fields,
        ...(window ? ['--search', window] : []),
      ],
    },
  };
}

export async function listNeoGithub(
  args: string[],
  spawnImpl: SpawnFn = spawnProcess
): Promise<unknown | null> {
  const outcome = await runGhJson(args, homedir(), spawnImpl);
  return outcome.ok ? outcome.data : null;
}
