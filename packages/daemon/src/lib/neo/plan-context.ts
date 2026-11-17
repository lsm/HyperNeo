import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoTopicPickKey } from './ask-topic.ts';
import { neoTodoDependencyNodes, neoTodoFinished, neoTodoReady } from './todo-dependencies.ts';
import { neoTodoWaitReason } from './todo-start-gate.ts';

export type NeoPlanLine = {
  kind: 'topics' | 'ask' | 'todo';
  id: string;
  askId: string;
  text: string;
  omitted?: boolean;
};

export type NeoUnansweredInput = {
  id: string;
  text: string;
};

export function neoInputText(ask: { content?: unknown }): string {
  const content = ask.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? [(block as { text?: unknown }).text]
        : []
    )
    .filter((text): text is string => typeof text === 'string' && !!text)
    .join(' ');
}

export type NeoTopicCount = { topic: string; count: number };

export function neoTopicList(topics: readonly NeoTopicCount[]): string[] {
  const folded = new Map<string, { label: string; best: number; count: number }>();
  for (const { topic, count } of topics) {
    const key = neoTopicPickKey(topic);
    const known = folded.get(key) ?? { label: topic, best: 0, count: 0 };
    folded.set(key, {
      label: count > known.best ? topic : known.label,
      best: Math.max(count, known.best),
      count: known.count + count,
    });
  }
  return [...folded.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((entry) => `${entry.label} ${entry.count}`);
}

function neoTopicListLine(topics: readonly NeoTopicCount[]): NeoPlanLine {
  return {
    kind: 'topics',
    id: 'topics',
    askId: '',
    text: `Topics used in the last 30 days (asks open or settled): ${neoTopicList(topics).join(', ') || 'none'}`,
  };
}

export function neoPlanLines(
  asks: readonly NeoAsk[],
  todos: readonly NeoTodo[],
  questions: readonly NeoQuestion[],
  topics: readonly NeoTopicCount[] = []
): NeoPlanLine[] {
  const nodes = neoTodoDependencyNodes(todos);
  return [
    neoTopicListLine(topics),
    ...asks
      .filter((ask) => ask.status === 'open')
      .flatMap((ask) => {
        const open = questions.filter((q) => q.askId === ask.id && q.state === 'open');
        return [
          {
            kind: 'ask' as const,
            id: ask.id,
            askId: ask.id,
            text: `Ask ${ask.id} [${ask.status}] topic=${ask.topic ?? 'none'} ${ask.title} questions=${open.length}`.replace(
              /\s+/g,
              ' '
            ),
          },
          ...todos
            .filter((todo) => todo.askId === ask.id && !['done', 'removed'].includes(todo.state))
            .map((todo) => {
              const waits =
                nodes
                  .find((node) => node.id === todo.id)
                  ?.dependsOn?.filter(
                    (id) => !neoTodoFinished(todos.find((other) => other.id === id))
                  ) ?? [];
              const wait = neoTodoWaitReason(todo, todos, open);
              const ready =
                todo.state === 'todo' &&
                todo.approvedAt !== null &&
                neoTodoReady(todos, todo.id) &&
                !wait;
              return {
                kind: 'todo' as const,
                id: todo.id,
                askId: ask.id,
                text: `  Todo ${todo.id} [${todo.state}] ${todo.title}; waits=${waits.join(',') || 'none'}; reason=${todo.blockedReason ?? wait ?? todo.reason ?? 'not recorded'}; ready=${ready}; questions=${open.filter((q) => q.todos.includes(todo.id)).length}`.replace(
                  /\s+/g,
                  ' '
                ),
              };
            }),
        ];
      }),
  ];
}

export function fitNeoPlanLines(lines: readonly NeoPlanLine[], budget: number): NeoPlanLine[] {
  if (Buffer.byteLength(lines.map((line) => line.text).join('\n'), 'utf8') <= budget)
    return [...lines];
  return lines
    .filter((line) => line.kind !== 'todo')
    .map((line) => {
      const omitted = lines.some((detail) => detail.kind === 'todo' && detail.askId === line.askId);
      return {
        ...line,
        omitted,
        text: omitted ? `${line.text} (Steps omitted; use neo.ask.read ${line.askId}.)` : line.text,
      };
    });
}

const UNANSWERED_TEXT_LIMIT = 2_048;
const UNANSWERED_SECTION_BUDGET = 8_192;

function unansweredText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const bytes = new TextEncoder().encode(flat);
  if (bytes.length <= UNANSWERED_TEXT_LIMIT) return flat;
  const cut = new TextDecoder().decode(bytes.slice(0, UNANSWERED_TEXT_LIMIT));
  return `${cut.replace(/�+$/, '')}… (truncated; read the full message with neo.conversation.read.)`;
}

function overflowLine(more: number): string {
  return `${more} more pending; newest first. Read them with neo.conversation.read.`;
}

function unansweredSection(unanswered: readonly NeoUnansweredInput[]): string {
  const heading = 'Unanswered messages';
  const kept: string[] = [];
  let used = Buffer.byteLength(`${heading}\n`, 'utf8');
  for (const [index, input] of unanswered.entries()) {
    const line = `Message ${input.id} (full id; reply with replyTo: ["${input.id}"]): ${unansweredText(input.text)}`;
    const more = unanswered.length - index;
    const reserve = Buffer.byteLength(`${overflowLine(more)}\n`, 'utf8');
    const bytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (used + bytes + reserve > UNANSWERED_SECTION_BUDGET) {
      kept.push(overflowLine(more));
      break;
    }
    kept.push(line);
    used += bytes;
  }
  return [heading, ...kept].join('\n');
}

export function planNeoPlanContext(
  previous: readonly NeoPlanLine[] | null,
  lines: readonly NeoPlanLine[],
  source: 'startup' | 'resume' | 'compact' | 'prompt',
  unanswered: readonly NeoUnansweredInput[] = []
): string {
  if (source !== 'prompt' || previous === null) {
    const plans = `Open plans\n${lines.map((line) => line.text).join('\n') || '(none)'}`;
    if (!unanswered.length) return plans;
    return [plans, unansweredSection(unanswered)].join('\n');
  }
  const changed = lines.filter(
    (line) =>
      !previous.some(
        (old) => old.kind === line.kind && old.id === line.id && old.text === line.text
      )
  );
  const removed = previous.filter(
    (old) =>
      !lines.some(
        (line) =>
          (line.kind === old.kind && line.id === old.id) ||
          (old.kind === 'todo' && line.kind === 'ask' && line.id === old.askId && line.omitted)
      )
  );
  return [
    ...changed.map((line) => line.text),
    ...removed.map((line) => `${line.kind} ${line.id}: no longer open or pending.`),
  ].join('\n');
}
