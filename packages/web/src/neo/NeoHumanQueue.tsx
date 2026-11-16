import type {
  NeoAskEntry,
  NeoQuestionAnswer,
  NeoQuestionEntry,
} from '@hyperneo/shared/types/neo-ask';
import type {
  NeoHumanQueue as Queue,
  NeoHumanQueueItem,
  NeoHumanQueueState,
} from '@hyperneo/shared/types/neo-snapshot';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';
import { QuestionBox } from './NeoAskTodos.tsx';
import { neoPlainClass } from './NeoCardParts.tsx';
import type { NeoWorkFocus } from './neo-work-reference.ts';

const STATES: NeoHumanQueueState[] = ['waiting', 'held', 'progress'];
const SHOWN_ASKS = 3;
const chip = 'rounded-full border px-3 py-1 text-sm';
const holds = (item: NeoHumanQueueItem, focus: NeoWorkFocus) =>
  item.askId === focus.askId &&
  (focus.questionId
    ? 'questionId' in item && item.questionId === focus.questionId
    : focus.todoId
      ? 'todoId' in item
        ? item.todoId === focus.todoId
        : item.todos.some((todo) => todo.id === focus.todoId)
      : true);

export const neoHumanQueueHolds = (queue: Queue, focus: NeoWorkFocus) =>
  queue.items.some((item) => holds(item, focus));

const tone = (on: boolean) =>
  on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-fg-muted hover:text-fg';

export function NeoHumanQueue({
  queue,
  entries,
  disabled,
  onAnswer,
  onHold,
  onLoadDetails,
  onReply,
  onOpen,
  focus,
}: {
  queue: Queue;
  entries: readonly NeoAskEntry[];
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
  onLoadDetails?: (askId: string) => Promise<NeoAskEntry>;
  onReply?: (question: NeoQuestionEntry) => void;
  onOpen?: (link: string, title: string) => void;
  focus?: NeoWorkFocus | null;
}) {
  const [state, setState] = useState<NeoHumanQueueState>('waiting');
  const [ask, setAsk] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, NeoAskEntry>>({});
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const [attempt, setAttempt] = useState(0);
  const loading = useRef(new Set<string>());
  const focused = focus && queue.items.find((item) => holds(item, focus));
  useEffect(() => {
    if (!focused) return;
    setState(focused.state);
    setAsk(null);
  }, [focus, focused?.state]);
  useEffect(() => {
    if (!focus || !focused || focused.state !== state || ask !== null) return;
    let restore = () => {};
    const frame = requestAnimationFrame(() => {
      const target = [
        focus.questionId && `neo-ref-question-${focus.questionId}`,
        focus.todoId && `neo-ref-todo-${focus.todoId}`,
        `neo-ref-ask-${focus.askId}`,
      ]
        .map((id) => id && document.getElementById(id))
        .find((node): node is HTMLElement => !!node);
      if (!target) return;
      const prior = target.getAttribute('tabindex');
      target.tabIndex = -1;
      target.classList.add('ring-2', 'ring-accent');
      target.focus({ preventScroll: true });
      target.scrollIntoView?.({ block: 'center' });
      restore = () => {
        target.classList.remove('ring-2', 'ring-accent');
        if (prior === null) target.removeAttribute('tabindex');
        else target.setAttribute('tabindex', prior);
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      restore();
    };
  }, [focus, focused?.state, state, ask]);
  const title = (id: string) =>
    entries.find((entry) => entry.ask.id === id)?.ask.title ?? details[id]?.ask.title ?? id;
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
  const card = (askId: string): NeoAskEntry | undefined => {
    const entry = entries.find((candidate) => candidate.ask.id === askId);
    const loaded = details[askId];
    if (!entry) return loaded;
    if (!entry.summary) return entry;
    return loaded && loaded.ask.updatedAt >= entry.ask.updatedAt ? loaded : undefined;
  };
  const stale = groups.filter((id) => !card(id));
  useEffect(() => {
    if (!onLoadDetails) return;
    for (const id of stale) {
      if (loading.current.has(id)) continue;
      loading.current.add(id);
      void onLoadDetails(id)
        .then(
          (value) => {
            setDetails((current) => ({ ...current, [id]: value }));
            setFailed((current) => ({ ...current, [id]: false }));
          },
          () => setFailed((current) => ({ ...current, [id]: true }))
        )
        .finally(() => loading.current.delete(id));
    }
  }, [stale.join(), onLoadDetails, entries, attempt]);
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
        <section
          key={id}
          id={`neo-ref-ask-${id}`}
          aria-label={title(id)}
          class="rounded-2xl border border-line p-4"
        >
          <h3 class="text-sm font-medium">{title(id)}</h3>
          {items
            .filter((item) => item.askId === id)
            .map((item) => (
              <QueueItem
                key={'questionId' in item ? item.questionId : item.todoId}
                item={item}
                entry={card(id)}
                failed={failed[id]}
                onRetry={() => {
                  setFailed((current) => ({ ...current, [id]: false }));
                  setAttempt((value) => value + 1);
                }}
                disabled={disabled}
                onAnswer={onAnswer}
                onHold={onHold}
                onReply={onReply}
                onOpen={onOpen}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function QueueItem({
  item,
  entry,
  failed,
  onRetry,
  disabled,
  onAnswer,
  onHold,
  onReply,
  onOpen,
}: {
  item: NeoHumanQueueItem;
  entry?: NeoAskEntry;
  failed?: boolean;
  onRetry: () => void;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
  onReply?: (question: NeoQuestionEntry) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  if (item.state === 'progress')
    return (
      <p
        id={`neo-ref-todo-${item.todoId}`}
        class="mt-2 flex flex-wrap justify-between gap-2 text-sm"
      >
        <span>{item.title}</span>
        {item.owner && <span class="text-fg-muted">{t(`queue.owner.${item.owner}`)}</span>}
      </p>
    );
  const held = item.state === 'held';
  const hold = { held, toggle: () => onHold(item.questionId, !held) };
  const question = entry?.questions.find((card) => card.id === item.questionId);
  return (
    <div data-queue-card={item.questionId}>
      <p class="mt-2 flex flex-wrap gap-x-2 text-xs text-fg-muted">
        {item.todos.length ? (
          item.todos.map((todo) => (
            <span key={todo.id} id={`neo-ref-todo-${todo.id}`}>
              {todo.title}
            </span>
          ))
        ) : (
          <span>{t('queue.wholeAsk')}</span>
        )}
      </p>
      {question ? (
        <QuestionBox
          question={question}
          disabled={disabled}
          onAnswer={(answer) => onAnswer(item.questionId, answer)}
          onReply={onReply && (() => onReply(question))}
          onOpen={onOpen}
          hold={hold}
        />
      ) : (
        <div
          id={`neo-ref-question-${item.questionId}`}
          class="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span>{item.text}</span>
          {failed && (
            <span role="alert" class="text-danger">
              {t('queue.loadFailed')}{' '}
              <button type="button" class={neoPlainClass} onClick={onRetry}>
                {t('chat.retry')}
              </button>
            </span>
          )}
          <button type="button" class={neoPlainClass} disabled={disabled} onClick={hold.toggle}>
            {t(held ? 'queue.takeBack' : 'queue.hold')}
          </button>
        </div>
      )}
    </div>
  );
}
