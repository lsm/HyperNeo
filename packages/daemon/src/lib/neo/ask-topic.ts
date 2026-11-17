import { NEO_OTHER_TOPIC, type NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { placeKey } from '../drivers/places.ts';
import type { Place, WorkRef } from '../drivers/types.ts';
import { NEO_INBOX_ID } from './inbox.ts';

export type NeoAskTopicTodo = {
  ref: WorkRef | null;
  place: Place | null;
  requestFrom: string | null;
};

type TopicAsk = Pick<NeoAsk, 'projectId' | 'parentId' | 'topic'>;
type Project = { id: string; title: string };

export type NeoAskTopicFacts = {
  ask: TopicAsk;
  todos: readonly NeoAskTopicTodo[];
  parent: { ask: TopicAsk; todos: readonly NeoAskTopicTodo[] } | null;
  machine: string;
  aliases: ReadonlyMap<string, string>;
  projects: ReadonlyMap<string, Project>;
};

export type NeoAskTopic = { topic: string; topicKey: string };

const workAlias = (machine: string, adapter: string, id: string) =>
  `work:${machine}\u0000${adapter}\u0000${id}`;

function senderAlias(machine: string, sender: string): string | null {
  if (sender.startsWith('daemon:')) return null;
  const split = sender.indexOf(':');
  return split < 0
    ? workAlias(machine, 'hyperneo', sender)
    : workAlias(machine, sender.slice(0, split), sender.slice(split + 1));
}

const targetAliases = (todo: NeoAskTopicTodo, machine: string) => [
  ...(todo.ref && !todo.ref.daemon ? [workAlias(machine, todo.ref.adapter, todo.ref.id)] : []),
  ...(todo.place && !todo.place.daemon ? [`folder:${placeKey(todo.place)}`] : []),
];

export function neoAskTopicAliases(todo: NeoAskTopicTodo, machine: string): string[] {
  const sender = todo.requestFrom ? senderAlias(machine, todo.requestFrom) : null;
  return [...targetAliases(todo, machine), ...(sender ? [sender] : [])];
}

function project(facts: NeoAskTopicFacts, id: string | null | undefined): Project | null {
  const found = id ? facts.projects.get(id) : undefined;
  return found && found.id !== NEO_INBOX_ID ? found : null;
}

function aliasProject(facts: NeoAskTopicFacts, alias: string | null): Project | null {
  return alias ? project(facts, facts.aliases.get(alias)) : null;
}

function ownProject(
  facts: NeoAskTopicFacts,
  ask: TopicAsk,
  todos: readonly NeoAskTopicTodo[]
): Project | null {
  const own = project(facts, ask.projectId);
  if (own) return own;
  const counts = new Map<string, { project: Project; count: number; first: number }>();
  todos.forEach((todo, index) => {
    const found = targetAliases(todo, facts.machine)
      .map((alias) => aliasProject(facts, alias))
      .find(Boolean);
    if (!found) return;
    const seen = counts.get(found.id) ?? { project: found, count: 0, first: index };
    counts.set(found.id, { ...seen, count: seen.count + 1 });
  });
  return (
    [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]?.project ?? null
  );
}

const pick = (topic: string): NeoAskTopic => ({
  topic,
  topicKey: `pick:${topic.toLowerCase().replace(/\s+/g, '')}`,
});

const stored = (ask: TopicAsk) => (ask.topic?.trim() ? pick(ask.topic) : null);

const fromProject = (found: Project | null) =>
  found ? { topic: found.title, topicKey: found.id } : null;

export function neoAskTopic(facts: NeoAskTopicFacts): NeoAskTopic {
  const sender = facts.todos.find((todo) => todo.requestFrom)?.requestFrom;
  return (
    fromProject(ownProject(facts, facts.ask, facts.todos)) ??
    (facts.parent
      ? (fromProject(ownProject(facts, facts.parent.ask, facts.parent.todos)) ??
        stored(facts.parent.ask))
      : null) ??
    fromProject(sender ? aliasProject(facts, senderAlias(facts.machine, sender)) : null) ??
    stored(facts.ask) ??
    pick(NEO_OTHER_TOPIC)
  );
}
