import type { NeoAskEntry, NeoQuestionAnswer } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoHumanQueue as Queue,
  NeoHumanQueueItem,
  NeoHumanQueueState,
} from '@hyperneo/shared/types/neo-snapshot';
import { useState } from 'preact/hooks';
import { Dropdown } from '../components/ui/Dropdown.tsx';
import { t } from '../lib/i18n/index.ts';
import { QuestionBox } from './NeoAskTodos.tsx';
import { neoPlainClass } from './NeoCardParts.tsx';

const STATES: NeoHumanQueueState[] = ['waiting', 'held', 'progress'];
const chip =
  'flex min-w-0 max-w-[12rem] items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium';
const tone = (on: boolean) =>
  on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:text-fg';

export function NeoHumanQueue({
  queue,
  entries,
  disabled,
  onAnswer,
  onHold,
  onReply,
}: {
  queue: Queue;
  entries: readonly Pick<NeoAskEntry, 'ask' | 'questions'>[];
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
  onReply?: (questionId: string) => void;
}) {
  const [state, setState] = useState<NeoHumanQueueState>('waiting');
  const [askId, setAskId] = useState<string | null>(null);
  const asks = [...new Set(queue.items.map((item) => item.askId))];
  const title = (id: string) =>
    entries.find((entry) => entry.ask.id === id)?.ask.title ?? t('queue.ask');
  const count = (id: string | null, of: NeoHumanQueueState) =>
    (id ? [id] : asks).reduce((total, ask) => total + (queue.counts[ask]?.[of] ?? 0), 0);
  const shown = asks.length > 3 ? asks.slice(0, 2) : asks;
  if (askId && !shown.includes(askId)) shown.push(askId);
  const more = asks.filter((ask) => !shown.includes(ask));
  const items = queue.items.filter(
    (item) => item.state === state && (!askId || item.askId === askId)
  );
  const groups = asks
    .map((ask) => ({ ask, items: items.filter((item) => item.askId === ask) }))
    .filter((group) => group.items.length);
  const label = (id: string) => `${title(id)} ${count(id, state)}`;

  return (
    <section class="mt-4" data-human-queue>
      <div role="group" aria-label={t('queue.state')} class="flex flex-wrap gap-2">
        {STATES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={state === value}
            class={`${chip} ${tone(state === value)}`}
            onClick={() => setState(value)}
          >
            {t(`queue.${value}`)} {count(askId, value)}
          </button>
        ))}
      </div>
      {asks.length > 0 && (
        <div role="group" aria-label={t('queue.askFilter')} class="mt-2 flex gap-2">
          <button
            type="button"
            aria-pressed={askId === null}
            class={`${chip} shrink-0 ${tone(askId === null)}`}
            onClick={() => setAskId(null)}
          >
            {t('live.allTopics')} {count(null, state)}
          </button>
          {shown.map((ask) => (
            <button
              key={ask}
              type="button"
              aria-pressed={askId === ask}
              aria-label={label(ask)}
              class={`${chip} ${tone(askId === ask)}`}
              onClick={() => setAskId(ask)}
            >
              <span class="truncate">{title(ask)}</span> {count(ask, state)}
            </button>
          ))}
          {more.length > 0 && (
            <Dropdown
              class="shrink-0"
              items={more.map((ask) => ({ label: label(ask), onClick: () => setAskId(ask) }))}
              trigger={
                <button type="button" class={`${chip} shrink-0 ${tone(false)}`}>
                  {t('queue.more')}
                </button>
              }
            />
          )}
        </div>
      )}
      {groups.length === 0 && (
        <p role="status" class="mt-4 text-sm text-fg-muted">
          {t(`queue.empty.${state}`)}
        </p>
      )}
      {groups.map((group) => (
        <section
          key={group.ask}
          aria-label={title(group.ask)}
          class="mt-4 rounded-2xl border border-line bg-surface p-4"
        >
          <h3 class="line-clamp-2 break-words text-sm font-semibold">{title(group.ask)}</h3>
          {group.items.map((item) => (
            <QueueItem
              key={item.state === 'progress' ? item.todoId : item.questionId}
              item={item}
              question={
                item.state === 'progress'
                  ? undefined
                  : entries
                      .find((entry) => entry.ask.id === item.askId)
                      ?.questions.find((question) => question.id === item.questionId)
              }
              disabled={disabled}
              onAnswer={onAnswer}
              onHold={onHold}
              onReply={onReply}
            />
          ))}
        </section>
      ))}
    </section>
  );
}

function QueueItem({
  item,
  question,
  disabled,
  onAnswer,
  onHold,
  onReply,
}: {
  item: NeoHumanQueueItem;
  question: NeoAskEntry['questions'][number] | undefined;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
  onReply?: (questionId: string) => void;
}) {
  if (item.state === 'progress')
    return (
      <div class="mt-3 flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span class="min-w-0 break-words">{item.title}</span>
        {item.owner && <span class="text-xs text-fg-muted">{t(`queue.owner.${item.owner}`)}</span>}
      </div>
    );
  const held = item.state === 'held';
  const hold = (
    <button
      type="button"
      class={neoPlainClass}
      disabled={disabled}
      onClick={() => onHold(item.questionId, !held)}
    >
      {t(held ? 'queue.takeBack' : 'queue.hold')}
    </button>
  );
  return (
    <div class="mt-3">
      <p class="text-xs text-fg-muted">
        {item.todos.length
          ? t('queue.about', { todos: item.todos.map((todo) => todo.title).join(', ') })
          : t('queue.wholeAsk')}
      </p>
      {question ? (
        <QuestionBox
          question={question}
          disabled={disabled}
          extra={hold}
          onAnswer={(answer) => onAnswer(item.questionId, answer)}
          onReply={onReply && (() => onReply(item.questionId))}
        />
      ) : (
        <div class="mt-1 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="min-w-0 break-words">{item.text}</span>
          {hold}
        </div>
      )}
    </div>
  );
}
