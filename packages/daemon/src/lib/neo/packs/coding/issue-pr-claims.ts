import superpipe, { type PipelineAPI } from 'superpipe';

type IssueTodo = { id: string; issue: string };

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
        .filter((todo) => issues.includes(todo.issue.toLowerCase()))
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
