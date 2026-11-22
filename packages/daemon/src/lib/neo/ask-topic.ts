import {
  NEO_OTHER_TOPIC,
  NEO_TOPIC_CELLS,
  neoTopicFits,
  type NeoAsk,
  type NeoTopicLabel,
} from '@hyperneo/shared/types/neo-ask';
import { z } from 'zod';
import { placeKey } from '../drivers/places.ts';
import type { Place, WorkRef } from '../drivers/types.ts';
import { NEO_INBOX_ID } from './inbox.ts';
import { sessionWorkerRef } from './worker-identity.ts';

export type NeoAskTopicTodo = {
  ref: WorkRef | null;
  place: Place | null;
  requestFrom: string | null;
};

type TopicAsk = Pick<NeoAsk, 'projectId' | 'parentId' | 'topic'>;
type Project = { id: string; title: string; repositoryName?: boolean };

export type NeoAskTopicFacts = {
  ask: TopicAsk;
  todos: readonly NeoAskTopicTodo[];
  parent: { ask: TopicAsk; todos: readonly NeoAskTopicTodo[] } | null;
  machine: string;
  aliases: ReadonlyMap<string, string>;
  projects: ReadonlyMap<string, Project>;
};

const topicMessage = `Topic must fit within ${NEO_TOPIC_CELLS} display cells.`;
const topicText = z.string().trim().min(1);
export const NeoTopicPick = topicText.refine(neoTopicFits, topicMessage);
export const NeoTopicFrom = topicText.refine(
  (value) => value.length <= 12 || neoTopicFits(value),
  topicMessage
);
export const NeoTopicLabelSchema = z.object({
  topic: z.string(),
  topicKey: z.string(),
  topicSource: z.enum(['project', 'repository']).optional(),
});

const workAlias = (machine: string, adapter: string, id: string) =>
  `work:${machine}\u0000${adapter}\u0000${id}`;

function senderAlias(machine: string, sender: string): string[] {
  const ref = sessionWorkerRef(sender, false);
  if (ref.daemon) return [];
  if (ref.adapter === 'claude-code' || ref.adapter === 'claude-desktop') {
    const id = ref.adapter === 'claude-desktop' ? ref.id.replace(/^local_/, '') : ref.id;
    return [
      workAlias(machine, 'claude-code', id),
      workAlias(machine, 'claude-desktop', `local_${id}`),
    ];
  }
  return [workAlias(machine, ref.adapter, ref.id)];
}

const targetAliases = (todo: NeoAskTopicTodo, machine: string) => [
  ...(todo.ref && !todo.ref.daemon ? [workAlias(machine, todo.ref.adapter, todo.ref.id)] : []),
  ...(todo.place && !todo.place.daemon ? [`folder:${placeKey(todo.place)}`] : []),
];

export function neoAskTopicAliases(todo: NeoAskTopicTodo, machine: string): string[] {
  const sender = todo.requestFrom ? senderAlias(machine, todo.requestFrom) : [];
  return [...targetAliases(todo, machine), ...sender];
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

export const neoTopicPickKey = (topic: string) => `pick:${topic.toLowerCase().replace(/\s+/g, '')}`;

const pick = (topic: string): NeoTopicLabel => ({ topic, topicKey: neoTopicPickKey(topic) });

function stored(ask: TopicAsk) {
  const topic = ask.topic?.trim();
  return topic && neoTopicFits(topic) ? pick(topic) : null;
}

const fromProject = (found: Project | null): NeoTopicLabel | null =>
  found
    ? {
        topic: found.title,
        topicKey: found.id,
        topicSource: found.repositoryName ? 'repository' : 'project',
      }
    : null;

export function neoAskTopic(facts: NeoAskTopicFacts): NeoTopicLabel {
  const sender = facts.todos.find((todo) => todo.requestFrom)?.requestFrom;
  return (
    fromProject(ownProject(facts, facts.ask, facts.todos)) ??
    (facts.parent
      ? (fromProject(ownProject(facts, facts.parent.ask, facts.parent.todos)) ??
        stored(facts.parent.ask))
      : null) ??
    fromProject(
      sender
        ? (senderAlias(facts.machine, sender)
            .map((alias) => aliasProject(facts, alias))
            .find(Boolean) ?? null)
        : null
    ) ??
    stored(facts.ask) ??
    pick(NEO_OTHER_TOPIC)
  );
}
