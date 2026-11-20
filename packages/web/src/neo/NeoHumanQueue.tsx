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
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n/index.ts';
import { QuestionBox } from './NeoAskTodos.tsx';
import { FORM_CHECKBOX_CLASS } from '../components/ui/FormField.tsx';
import { neoPlainClass } from './NeoCardParts.tsx';
import type { NeoWorkFocus } from './neo-work-reference.ts';

const STATES: NeoHumanQueueState[] = ['waiting', 'held', 'progress'];
const SHOWN_ASKS = 3;
const chip = 'rounded-full border px-3 py-1 text-sm';
const holds = (item: NeoHumanQueueItem, focus: NeoWorkFocus) =>
  focus.questionId
    ? 'questionId' in item && item.questionId === focus.questionId
    : focus.todoId
      ? 'todoId' in item
        ? item.todoId === focus.todoId
        : item.askId === focus.askId && item.todos.some((todo) => todo.id === focus.todoId)
      : item.askId === focus.askId;

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
  reveal = 0,
  onStale,
  onDesktopControl,
  onDesktopAllow,
  renderAsk,
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
  reveal?: number;
  onStale?: () => Promise<unknown>;
  onDesktopControl?: (todoId: string, on: boolean) => void;
  onDesktopAllow?: (question: NeoQuestionEntry) => void;
  renderAsk?: (entry: NeoAskEntry, refreshing?: boolean) => ComponentChildren;
}) {
  const [state, setState] = useState<NeoHumanQueueState>('waiting');
  const [ask, setAsk] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, NeoAskEntry>>({});
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const shown = useRef<Record<string, NeoAskEntry>>({});
  const [settled, setSettled] = useState(0);
  const requests = useRef(
    new Map<string, { pending: boolean; queue: Queue; known: string; attempt: number }>()
  );
  const known = entries.map((entry) => `${entry.ask.id}:${entry.ask.updatedAt}`).join();
  const current = (request: { queue: Queue; known: string; attempt: number }) =>
    request.queue === queue && request.known === known && request.attempt === attempt;
  const covers = (loaded: NeoAskEntry, askId: string) =>
    queue.items.every(
      (item) =>
        item.askId !== askId ||
        !('questionId' in item) ||
        loaded.questions.some((question) => question.id === item.questionId)
    );
  const card = (askId: string): NeoAskEntry | undefined => {
    const entry = entries.find((candidate) => candidate.ask.id === askId);
    if (entry && !entry.summary) return entry;
    const loaded = details[askId];
    if (!loaded || !covers(loaded, askId)) return undefined;
    return !entry || loaded.ask.updatedAt >= entry.ask.updatedAt ? loaded : undefined;
  };
  const failed = (askId: string) => {
    const request = requests.current.get(askId);
    return !!request && !request.pending && current(request) && !card(askId);
  };
  const focused = focus && queue.items.find((item) => holds(item, focus));
  const focusReady = !!focused && !!card(focused.askId);
  const outside = focus && !focused ? focus.askId : null;
  useEffect(() => {
    if (ask !== null && !queue.counts[ask]) setAsk(null);
  }, [queue, ask]);
  const revealed = useRef<{ reveal: number; done: boolean } | null>(null);
  useEffect(() => {
    if (!focused || revealed.current?.reveal === reveal) return;
    revealed.current = { reveal, done: false };
    setState(focused.state);
    setAsk(null);
  }, [reveal, focused]);
  useEffect(() => {
    const request = revealed.current;
    if (!focus || !focused || !request || request.reveal !== reveal || request.done) return;
    if (focused.state !== state || ask !== null) return;
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
      if (focusReady || failed(focused.askId)) request.done = true;
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
  }, [focus, focused?.state, state, ask, focusReady, reveal]);
  const title = (id: string) =>
    entries.find((entry) => entry.ask.id === id)?.ask.title ??
    details[id]?.ask.title ??
    queue.items
      .filter((item) => item.askId === id)
      .map((item) => ('questionId' in item ? item.text : item.title))[0] ??
    id;
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
  const runs: { id: string; first: boolean; items: NeoHumanQueueItem[] }[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if (last?.id === item.askId) last.items.push(item);
    else
      runs.push({
        id: item.askId,
        first: !runs.some((run) => run.id === item.askId),
        items: [item],
      });
  }
  const stale = groups.filter((id) => !card(id));
  useEffect(() => {
    if (!onLoadDetails) return;
    for (const id of stale) {
      const previous = requests.current.get(id);
      if (previous && (previous.pending || current(previous))) continue;
      const request = { pending: true, queue, known, attempt };
      requests.current.set(id, request);
      void onLoadDetails(id)
        .then(
          (value) => setDetails((loaded) => ({ ...loaded, [id]: value })),
          () => {}
        )
        .finally(() => {
          request.pending = false;
          setSettled((value) => value + 1);
        });
    }
  }, [stale.join(), onLoadDetails, known, queue, attempt, settled]);
  const closed = queue.items.some(
    (item) =>
      'questionId' in item &&
      !!card(item.askId)?.questions.some(
        (question) => question.id === item.questionId && question.state !== 'open'
      )
  );
  const staleQueue = useRef<Queue | null>(null);
  const [staleFailed, setStaleFailed] = useState(false);
  useEffect(() => {
    if (!closed || !onStale || staleFailed || staleQueue.current === queue) return;
    staleQueue.current = queue;
    Promise.resolve()
      .then(onStale)
      .catch(() => setStaleFailed(true));
  }, [closed, queue, onStale, staleFailed]);
  const anchored = new Set<string>();
  const anchor = (todoId: string, askId?: string) => {
    const elsewhere = entries.some(
      (entry) => entry.ask.id !== askId && entry.todos.some((todo) => todo.id === todoId)
    );
    if ((askId && elsewhere) || anchored.has(todoId)) return undefined;
    anchored.add(todoId);
    return `neo-ref-todo-${todoId}`;
  };
  if (!queue.items.length) return null;
  return (
    <div data-human-queue class="mt-6 space-y-3">
      {staleFailed && (
        <p role="alert" class="text-sm text-danger">
          {t('queue.refreshFailed')}{' '}
          <button
            type="button"
            class={neoPlainClass}
            onClick={() => {
              staleQueue.current = null;
              setStaleFailed(false);
            }}
          >
            {t('chat.retry')}
          </button>
        </p>
      )}
      <div role="group" aria-label={t('queue.state')} class="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            data-queue-state={s}
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
      {runs.map(({ id, first, items: run }) => {
        const validated = renderAsk && id !== outside ? card(id) : undefined;
        if (validated) shown.current[id] = validated;
        const full =
          renderAsk &&
          id !== outside &&
          (validated ?? (opened.has(id) ? shown.current[id] : undefined));
        const showFull = !!full && opened.has(id);
        if (showFull && !first) return null;
        return (
          <section
            key={first ? id : `${id}:${'questionId' in run[0] ? run[0].questionId : run[0].todoId}`}
            id={id === outside || showFull || !first ? undefined : `neo-ref-ask-${id}`}
            data-queue-ask={id}
            aria-label={title(id)}
            class="rounded-2xl border border-line p-4"
          >
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-medium">{title(id)}</h3>
              {full && first && (
                <button
                  type="button"
                  data-queue-open
                  class={neoPlainClass}
                  aria-expanded={showFull}
                  onClick={() =>
                    setOpened((current) => {
                      const next = new Set(current);
                      if (!next.delete(id)) next.add(id);
                      return next;
                    })
                  }
                >
                  {t('queue.openAsk')}
                </button>
              )}
            </div>
            {showFull && failed(id) && (
              <p role="alert" class="mt-2 text-sm text-danger">
                {t('queue.loadFailed')}{' '}
                <button
                  type="button"
                  class={neoPlainClass}
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {t('chat.retry')}
                </button>
              </p>
            )}
            {showFull
              ? renderAsk(full, !validated)
              : run.map((item) => (
                  <QueueItem
                    key={'questionId' in item ? item.questionId : item.todoId}
                    item={item}
                    entry={card(id) ?? details[id]}
                    listed={entries.find((candidate) => candidate.ask.id === id)}
                    refreshing={!card(id)}
                    onDesktopControl={onDesktopControl}
                    onDesktopAllow={onDesktopAllow}
                    failed={failed(id)}
                    onRetry={() => setAttempt((value) => value + 1)}
                    anchor={anchor}
                    disabled={disabled}
                    onAnswer={onAnswer}
                    onHold={onHold}
                    onReply={onReply}
                    onOpen={onOpen}
                  />
                ))}
          </section>
        );
      })}
    </div>
  );
}

function QueueItem({
  item,
  entry,
  listed,
  failed,
  refreshing,
  onRetry,
  anchor,
  disabled,
  onAnswer,
  onHold,
  onReply,
  onOpen,
  onDesktopControl,
  onDesktopAllow,
}: {
  item: NeoHumanQueueItem;
  entry?: NeoAskEntry;
  listed?: NeoAskEntry;
  failed?: boolean;
  refreshing?: boolean;
  onDesktopControl?: (todoId: string, on: boolean) => void;
  onDesktopAllow?: (question: NeoQuestionEntry) => void;
  onRetry: () => void;
  anchor: (todoId: string, askId?: string) => string | undefined;
  disabled?: boolean;
  onAnswer: (questionId: string, answer: NeoQuestionAnswer) => void;
  onHold: (questionId: string, held: boolean) => void;
  onReply?: (question: NeoQuestionEntry) => void;
  onOpen?: (link: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if ('todoId' in item) {
    const todo = [...(entry?.todos ?? []), ...(listed?.todos ?? [])].find(
      (candidate) => candidate.id === item.todoId
    );
    const desktop =
      onDesktopControl &&
      todo &&
      !todo.worker?.daemon &&
      ['todo', 'doing', 'blocked'].includes(todo.state)
        ? todo
        : undefined;
    return (
      <div id={anchor(item.todoId)} data-ask-todo={item.todoId} class="mt-2 text-sm">
        <p class="flex flex-wrap justify-between gap-2">
          {desktop ? (
            <button
              type="button"
              class="text-left hover:underline"
              aria-expanded={open}
              aria-label={t(open ? 'todo.hideDetails' : 'todo.showDetails', { title: item.title })}
              onClick={() => setOpen(!open)}
            >
              {item.title}
            </button>
          ) : (
            <span>{item.title}</span>
          )}
          {item.owner && <span class="text-fg-muted">{t(`queue.owner.${item.owner}`)}</span>}
        </p>
        {desktop && open && (
          <label class="mt-1 flex w-fit items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              class={`${FORM_CHECKBOX_CLASS} accent-accent`}
              disabled={disabled || refreshing}
              checked={desktop.named?.desktopControl === true}
              onChange={(event) =>
                onDesktopControl?.(item.todoId, (event.target as HTMLInputElement).checked)
              }
            />
            {t('todo.desktopControl')}
          </label>
        )}
        {failed && (
          <p role="alert" class="mt-1 text-xs text-danger">
            {t('queue.stepFailed')}{' '}
            <button type="button" class={neoPlainClass} onClick={onRetry}>
              {t('chat.retry')}
            </button>
          </p>
        )}
      </div>
    );
  }
  const held = item.state === 'held';
  const hold = { held, toggle: () => onHold(item.questionId, !held) };
  const known = entry?.questions.find((card) => card.id === item.questionId);
  const question = known?.state === 'open' ? known : undefined;
  return (
    <div data-queue-card={item.questionId}>
      <p class="mt-2 flex flex-wrap gap-x-2 text-xs text-fg-muted">
        {item.todos.length ? (
          item.todos.map((todo) => (
            <span key={todo.id} id={anchor(todo.id, item.askId)}>
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
          disabled={disabled || refreshing}
          onAnswer={(answer) => onAnswer(item.questionId, answer)}
          onDesktopAllow={onDesktopAllow}
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
          {!known && (
            <button type="button" class={neoPlainClass} disabled={disabled} onClick={hold.toggle}>
              {t(held ? 'queue.takeBack' : 'queue.hold')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
