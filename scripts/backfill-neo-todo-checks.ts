#!/usr/bin/env bun

import { readFileSync } from 'node:fs';
import type { NeoTodo, NeoTodoCheck } from '../packages/shared/src/types/neo-ask.ts';
import { parseGitHubRefUrl } from '../packages/daemon/src/lib/github/parse-pr-url.ts';

type Todo = Pick<NeoTodo, 'id' | 'askId' | 'title' | 'report' | 'repo' | 'state' | 'check'>;
type Reference = { kind: 'pr' | 'issue'; owner: string; repo: string; number: number };
type ReferenceKinds = Readonly<Record<string, Reference['kind']>>;
type Edit = { todoId: string; check: NeoTodoCheck };
type Unresolved = { todoId: string; title: string; reason: string };
const TOKENS =
  /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/[1-9]\d*\b|(?<![\w./#-])(?:[\w.-]+\/[\w.-]+)?#[1-9]\d*\b/gi;

function reference(
  token: string,
  prefix: string,
  repository: string | null,
  kinds: ReferenceKinds
): Reference | null {
  if (/^https?:/i.test(token)) {
    const parsed = parseGitHubRefUrl(token.toLowerCase());
    const kind =
      parsed &&
      (kinds[`${parsed.owner}/${parsed.repo}#${parsed.number}`] ??
        (token.toLowerCase().includes('/pull/') ? 'pr' : 'issue'));
    return parsed && Number.isSafeInteger(parsed.number) && (kind === 'pr' || kind === 'issue')
      ? { ...parsed, kind }
      : null;
  }
  const label = /\b(PRs?|pull requests?|issues?)\s*$/i.exec(prefix)?.[1];
  const named = /^(?:([\w.-]+)\/([\w.-]+))?#([1-9]\d*)$/.exec(token);
  const context = /^(?:github\.com\/)?([\w.-]+)\/([\w.-]+)$/i.exec(repository ?? '');
  const owner = named?.[1] ?? context?.[1];
  const repo = named?.[2] ?? context?.[2];
  const number = Number(named?.[3]);
  const kind =
    kinds[`${owner}/${repo}#${number}`.toLowerCase()] ??
    (label ? (/^issue/i.test(label) ? 'issue' : 'pr') : null);
  return (kind === 'pr' || kind === 'issue') && owner && repo && Number.isSafeInteger(number)
    ? {
        owner: owner.toLowerCase(),
        repo: repo.toLowerCase(),
        number,
        kind,
      }
    : null;
}

export function planNeoTodoCheckBackfill(todos: readonly Todo[], kinds: ReferenceKinds = {}) {
  const edits: Edit[] = [];
  const unresolved: Unresolved[] = [];
  for (const todo of todos) {
    if (todo.check || !['todo', 'doing', 'blocked', 'failed'].includes(todo.state)) continue;
    const text = [todo.title, todo.report].filter(Boolean).join('\n');
    const tokens = [...text.matchAll(TOKENS)];
    const repos = new Set(
      tokens.flatMap(([token]) => {
        const named =
          /^(?:https?:\/\/(?:www\.)?github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/(?:pull|issues)\/)/i.exec(
            token
          )?.[1];
        return named ? [named.toLowerCase()] : [];
      })
    );
    const repository = todo.repo ?? (repos.size === 1 ? [...repos][0] : null);
    const parsed = tokens.map((token) =>
      reference(token[0], text.slice(Math.max(0, token.index - 20), token.index), repository, kinds)
    );
    const refs = [
      ...new Map(
        parsed
          .filter((ref) => ref !== null)
          .map((ref) => [`${ref.kind}:${ref.owner}/${ref.repo}#${ref.number}`, ref])
      ).values(),
    ];
    const prs = refs.filter((ref) => ref.kind === 'pr');
    const issues = refs.filter((ref) => ref.kind === 'issue');
    const reason = !tokens.length
      ? 'no_reference'
      : parsed.some((ref) => ref === null)
        ? 'ambiguous_reference'
        : prs.length && issues.length
          ? 'mixed_reference_kinds'
          : issues.length > 1
            ? 'multiple_issues'
            : null;
    if (reason) {
      unresolved.push({ todoId: todo.id, title: todo.title, reason });
      continue;
    }
    const issue = issues[0];
    edits.push({
      todoId: todo.id,
      check: issue
        ? {
            pack: 'coding',
            kind: 'issue_closed',
            params: { issue: `${issue.owner}/${issue.repo}#${issue.number}` },
          }
        : {
            pack: 'coding',
            kind: 'pr_merged',
            params: {
              urls: prs.map((pr) => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`),
            },
          },
    });
  }
  return { edits, unresolved };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path)
    throw new Error(
      'Usage: bun scripts/backfill-neo-todo-checks.ts <exported-todos.json> [ref-kinds.json]'
    );
  const rows: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Expected an exported todo array.');
  const kinds: ReferenceKinds = process.argv[3]
    ? JSON.parse(readFileSync(process.argv[3], 'utf8'))
    : {};
  console.log(JSON.stringify(planNeoTodoCheckBackfill(rows, kinds), null, 2));
}
