import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';

type IssueTodo = Pick<NeoTodo, 'id' | 'state' | 'check'>;

export const planCodingIssuePrClaims = (superpipe({})('coding.issue-pr-claims') as PipelineAPI)
  .input(['repo', 'number', 'body', 'todos'])
  .pipe(
    (repo: string, body: string) =>
      [
        ...body.matchAll(
          /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/|([\w.-]+\/[\w.-]+)?#)([1-9]\d*)\b/gi
        ),
      ].map((match) => `${match[1] ?? match[2] ?? repo}#${match[3]}`.toLowerCase()),
    ['repo', 'body'],
    'issues'
  )
  .pipe(
    (repo: string, number: number, issues: string[], todos: readonly IssueTodo[]) =>
      todos
        .filter(
          (todo) =>
            ['todo', 'doing', 'blocked'].includes(todo.state) &&
            todo.check?.pack === 'coding' &&
            todo.check.kind === 'issue_closed' &&
            typeof todo.check.params.issue === 'string' &&
            issues.includes(todo.check.params.issue.toLowerCase())
        )
        .map((todo) => ({
          todoId: todo.id,
          url: `https://github.com/${repo.toLowerCase()}/pull/${number}`,
        })),
    ['repo', 'number', 'issues', 'todos'],
    'claims'
  )
  .end('claims') as (
  repo: string,
  number: number,
  body: string,
  todos: readonly IssueTodo[]
) => { todoId: string; url: string }[];
