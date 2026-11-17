import type { NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { hostname } from 'node:os';
import {
  neoAskTopic,
  neoAskTopicAliases,
  neoTopicPickKey,
  type NeoAskTopicTodo,
} from '../../lib/neo/ask-topic.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoProjectMergeRepository } from './neo-project-merge-repository.ts';

const json = (ids: Iterable<string>) => JSON.stringify([...new Set(ids)]);

export function readNeoAskTopics(
  db: Database,
  asks: readonly NeoAsk[],
  parents: readonly NeoAsk[]
): NeoAsk[] {
  const known = new Map([...asks, ...parents].map((ask) => [ask.id, ask]));
  const todos = new Map<string, NeoAskTopicTodo[]>();
  for (const row of db
    .prepare(
      `SELECT t.ask_id AS askId, json_extract(t.named, '$.requestFrom') AS requestFrom,
        COALESCE(s.ref, json_extract(s.target, '$.ref')) AS ref, json_extract(s.target, '$.place') AS place
      FROM neo_todos t LEFT JOIN neo_todo_sessions s ON s.todo_id = t.id
      WHERE t.ask_id IN (SELECT value FROM json_each(?)) ORDER BY t.created_at, t.position`
    )
    .all(json(known.keys())) as {
    askId: string;
    requestFrom: unknown;
    ref: string | null;
    place: string | null;
  }[])
    todos.set(row.askId, [
      ...(todos.get(row.askId) ?? []),
      {
        ref: row.ref ? JSON.parse(row.ref) : null,
        place: row.place ? JSON.parse(row.place) : null,
        requestFrom: typeof row.requestFrom === 'string' ? row.requestFrom : null,
      },
    ]);
  const machine = hostname();
  const aliases = new Map(
    (
      db
        .prepare(
          'SELECT alias, project_id AS projectId FROM neo_project_workspaces WHERE alias IN (SELECT value FROM json_each(?))'
        )
        .all(
          json([...todos.values()].flat().flatMap((todo) => neoAskTopicAliases(todo, machine)))
        ) as { alias: string; projectId: string }[]
    ).map((row) => [row.alias, row.projectId])
  );
  const merges = new NeoProjectMergeRepository(db);
  const title = db.prepare('SELECT title FROM neo_concerns WHERE id = ?');
  const projects = new Map(
    [
      ...new Set([
        ...aliases.values(),
        ...[...known.values()].flatMap((ask) => ask.projectId ?? []),
      ]),
    ].flatMap((id) => {
      const resolved = merges.resolve(id);
      const row = resolved ? (title.get(resolved) as { title: string } | null) : null;
      return resolved && row ? [[id, { id: resolved, title: row.title }] as const] : [];
    })
  );
  return asks.map((ask) => {
    const parent = ask.parentId ? known.get(ask.parentId) : undefined;
    return {
      ...ask,
      ...neoAskTopic({
        ask,
        todos: todos.get(ask.id) ?? [],
        parent: parent ? { ask: parent, todos: todos.get(parent.id) ?? [] } : null,
        machine,
        aliases,
        projects,
      }),
    };
  });
}

export function readNeoTopicCounts(
  db: Database,
  since: number
): { topic: string; count: number }[] {
  return db
    .prepare(
      `SELECT topic, COUNT(*) AS count FROM neo_asks
      WHERE topic IS NOT NULL AND trim(topic) != '' AND created_at >= ? GROUP BY topic`
    )
    .all(since) as { topic: string; count: number }[];
}

export function rewriteNeoTopicPick(db: Database, from: string, to: string): number {
  const key = neoTopicPickKey(from);
  const names = (
    db.prepare('SELECT DISTINCT topic FROM neo_asks WHERE topic IS NOT NULL').all() as {
      topic: string;
    }[]
  )
    .map((row) => row.topic)
    .filter((topic) => neoTopicPickKey(topic) === key);
  return names.length
    ? db
        .prepare('UPDATE neo_asks SET topic = ? WHERE topic IN (SELECT value FROM json_each(?))')
        .run(to, json(names)).changes
    : 0;
}
