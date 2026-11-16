import type { NeoAskEntry, NeoQuestionAnswer } from '@hyperneo/shared/types/neo-ask';
import type {
  NeoHumanQueue as Queue,
  NeoHumanQueueItem,
  NeoHumanQueueState,
} from '@hyperneo/shared/types/neo-snapshot';
import { useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';
import { QuestionBox } from './NeoAskTodos.tsx';
import { neoPlainClass } from './NeoCardParts.tsx';

const STATES: NeoHumanQueueState[] = ['waiting', 'held', 'progress'];
const SHOWN_ASKS = 3;
const chip = 'rounded-full border px-3 py-1 text-sm';
const tone = (on: boolean) =>
  on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:text-fg';

export function NeoHumanQueue({
  queue,
  entries,
  disabled,
  onAnswer,
  onHold,
}: {
  queue: Queue;
  entries: readonly NeoAskEntry[];
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
}) {
  const [state, setState] = useState<NeoHumanQueueState>('waiting');
  const [ask, setAsk] = useState<string | null>(null);
  const title = (id: string) => entries.find((entry) => entry.ask.id === id)?.ask.title ?? id;
  const count = (s: NeoHumanQueueState, a: string | null) =>
    Object.entries(queue.counts).reduce(
      (total, [id, counts]) => total + (a === null || a === id ? counts[s] : 0),
      0
    );
  const asks = Object.keys(queue.counts).filter((id) => id === ask || queue.counts[id][state] > 0);
  const items = queue.items.filter(
    (item) => item.state === state && (ask === null || item.askId === ask)
  );
  const groups = [...new Set(items.map((item) => item.askId))];
  if (!queue.items.length) return null;
  return (
    <div data-human-queue class="mt-6 space-y-3">
      <div role="group" aria-label={t('queue.state')} class="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            class={`${chip} ${tone(state === s)}`}
            aria-pressed={state === s}
            onClick={() => setState(s)}
          >
            {t(`queue.state.${s}`)} {count(s, ask)}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t('queue.ask')} class="flex flex-wrap gap-2">
        <button
          type="button"
          class={`${chip} ${tone(ask === null)}`}
          aria-pressed={ask === null}
          onClick={() => setAsk(null)}
        >
          {t('queue.allAsks')} {count(state, null)}
        </button>
        {asks.slice(0, SHOWN_ASKS).map((id) => (
          <button
            key={id}
            type="button"
            class={`${chip} ${tone(ask === id)} max-w-[12rem] truncate`}
            aria-pressed={ask === id}
            onClick={() => setAsk(id)}
          >
            {title(id)} {queue.counts[id][state]}
          </button>
        ))}
        {asks.length > SHOWN_ASKS && (
          <select
            aria-label={t('queue.more')}
            class={`${chip} ${tone(asks.slice(SHOWN_ASKS).includes(ask ?? ''))} max-w-[10rem] bg-transparent`}
            value={asks.slice(SHOWN_ASKS).includes(ask ?? '') ? ask! : ''}
            onChange={(event) => setAsk((event.target as HTMLSelectElement).value || null)}
          >
            <option value="">{t('queue.more')}</option>
            {asks.slice(SHOWN_ASKS).map((id) => (
              <option key={id} value={id}>
                {title(id)} {queue.counts[id][state]}
              </option>
            ))}
          </select>
        )}
      </div>
      {groups.map((id) => (
        <section key={id} aria-label={title(id)} class="rounded-2xl border border-line p-4">
          <h3 class="text-sm font-medium">{title(id)}</h3>
          {items
            .filter((item) => item.askId === id)
            .map((item) => (
              <QueueItem
                key={'questionId' in item ? item.questionId : item.todoId}
                item={item}
                entries={entries}
                disabled={disabled}
                onAnswer={onAnswer}
                onHold={onHold}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function QueueItem({
  item,
  entries,
  disabled,
  onAnswer,
  onHold,
}: {
  item: NeoHumanQueueItem;
  entries: readonly NeoAskEntry[];
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
}) {
  if (item.state === 'progress')
    return (
      <p class="mt-2 flex flex-wrap justify-between gap-2 text-sm">
        <span>{item.title}</span>
        {item.owner && <span class="text-fg-muted">{t(`queue.owner.${item.owner}`)}</span>}
      </p>
    );
  const held = item.state === 'held';
  const hold = { held, toggle: () => onHold(item.questionId, !held) };
  const question = entries
    .find((entry) => entry.ask.id === item.askId)
    ?.questions.find((card) => card.id === item.questionId);
  return (
    <div data-queue-card={item.questionId}>
      <p class="mt-2 flex flex-wrap gap-x-2 text-xs text-fg-muted">
        {item.todos.length ? (
          item.todos.map((todo) => <span key={todo.id}>{todo.title}</span>)
        ) : (
          <span>{t('queue.wholeAsk')}</span>
        )}
      </p>
      {question ? (
        <QuestionBox
          question={question}
          disabled={disabled}
          onAnswer={(answer) => onAnswer(item.questionId, answer)}
          hold={hold}
        />
      ) : (
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{item.text}</span>
          <button type="button" class={neoPlainClass} disabled={disabled} onClick={hold.toggle}>
            {t(held ? 'queue.takeBack' : 'queue.hold')}
          </button>
        </div>
      )}
    </div>
  );
}
