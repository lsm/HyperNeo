import { homedir } from 'node:os';
import { z } from 'zod';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTrackerAdapter, NeoTrackerOwner } from '../../pack-contract.ts';
import { neoRepositoryIdentity } from '../../project-mirror.ts';
import { readNeoTrackerMarker } from '../../tracker-mirror-plan.ts';
import { codingTodoRepository } from './todo-prs.ts';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn, type SpawnProcess } from '../../../runtime-spawn/index.ts';

const Issue = z.object({
  id: z.number(),
  number: z.number(),
  body: z.string().nullable().optional(),
  pull_request: z.unknown().optional(),
});
const githubRepo = (repo: string | null) => {
  const path = neoRepositoryIdentity(repo ?? undefined)
    ?.slice('repository:'.length)
    .replace(/^github\.com\//, '');
  return path && /^[\w.-]+\/[\w.-]+$/.test(path) ? path : null;
};
export const planCodingIssueHome = (todos: readonly Pick<NeoTodo, 'repo'>[]) =>
  todos.map((todo) => githubRepo(todo.repo)).find(Boolean) ?? null;
const issuePath = (ref: string) => {
  const match = ref.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);
  if (!match) throw new Error('Invalid tracker issue ref');
  return `repos/${match[1]}/issues/${match[2]}`;
};
type Api = (args: string[]) => Promise<unknown>;
async function operation<T>(spawn: SpawnFn, action: (api: Api) => Promise<T>): Promise<T> {
  let active: SpawnProcess | null = null;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    try {
      active?.kill('SIGKILL');
    } catch {}
  }, 30_000);
  const controlled: SpawnFn = (args, options) => {
    if (expired) throw new Error('Tracker GitHub operation timed out');
    active = spawn(args, options);
    return active;
  };
  try {
    return await action(async (args) => {
      const result = await runGhJson(
        ['gh', 'api', '--hostname', 'github.com', ...args],
        homedir(),
        controlled,
        { stripGHRepo: true }
      );
      if (!result.ok) throw new Error(result.error);
      return result.data;
    });
  } finally {
    clearTimeout(timer);
  }
}

export function createCodingIssueTracker(deps: {
  todos: (askId: string) => readonly NeoTodo[];
  createdAt: (marker: string) => number | null;
  enabled: (repo: string) => boolean;
  spawn?: SpawnFn;
}): NeoTrackerAdapter {
  const spawn = deps.spawn ?? spawnProcess;
  const home = (owner: NeoTrackerOwner) =>
    planCodingIssueHome(
      (owner.todo ? [owner.todo] : deps.todos(owner.ask.id))
        .map((todo) => ({ repo: codingTodoRepository(todo, [], { todo, ask: owner.ask }) }))
        .filter((todo) => {
          const repo = githubRepo(todo.repo);
          return repo !== null && deps.enabled(repo);
        })
    );
  return {
    id: 'github-issues',
    enabled: (owner) => home(owner) !== null,
    home,
    create: (item) =>
      operation(spawn, async (api) => {
        const issue = Issue.parse(
          await api([
            `repos/${item.home}/issues`,
            '--method',
            'POST',
            '-f',
            `title=${item.title}`,
            '-f',
            `body=${item.body}`,
          ])
        );
        return { ref: `${item.home}#${issue.number}` };
      }),
    find: (marker, home) =>
      operation(spawn, async (api) => {
        const createdAt = deps.createdAt(marker);
        if (createdAt === null) throw new Error('Tracker owner is unavailable');
        const since = new Date(Math.floor(createdAt / 1000) * 1000 - 1000)
          .toISOString()
          .replace('.000Z', 'Z');
        for (let page = 1; ; page++) {
          const issues = z
            .array(Issue)
            .parse(
              await api([
                `repos/${home}/issues`,
                '--method',
                'GET',
                '-f',
                'state=all',
                '-f',
                `since=${since}`,
                '-f',
                'per_page=100',
                '-f',
                `page=${page}`,
              ])
            );
          const found = issues.find(
            (issue) => !issue.pull_request && readNeoTrackerMarker(issue.body ?? '') === marker
          );
          if (found) return `${home}#${found.number}`;
          if (issues.length < 100) return null;
        }
      }),
    link: (parent, child) =>
      operation(spawn, async (api) => {
        const issue = Issue.parse(await api([issuePath(child)]));
        const endpoint = `${issuePath(parent)}/sub_issues`;
        const pages = z
          .array(z.array(Issue))
          .parse(
            await api([endpoint, '--paginate', '--slurp', '-f', 'per_page=100', '--method', 'GET'])
          );
        if (!pages.flat().some((linked) => linked.id === issue.id))
          await api([endpoint, '--method', 'POST', '-F', `sub_issue_id=${issue.id}`]);
        return true as const;
      }),
    close: (ref, outcome) =>
      operation(spawn, async (api) => {
        await api([
          issuePath(ref),
          '--method',
          'PATCH',
          '-f',
          'state=closed',
          '-f',
          `state_reason=${outcome}`,
        ]);
        return true as const;
      }),
  };
}
