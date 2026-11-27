import { ContentDisclosureControl } from '../components/ui/ContentDisclosureControl.tsx';
import { GoalDefinition } from '../components/SessionSchedules.tsx';
import type { GoalJournalEntry, SessionGoal } from '@hyperneo/shared/types/session-goal';
import type { SessionScheduleListResult } from '@hyperneo/shared/types/session-schedule';
import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { useEffect, useState } from 'preact/hooks';
import { useVisibleTick } from '../hooks/useVisibleTick.ts';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation, requireAccepted, type OperationRejection } from '../lib/operations.ts';
import { locale, t } from '../lib/i18n/index.ts';
import { NeoWorkEmpty } from './NeoWorkEmpty.tsx';

type GoalRow = { goal: SessionGoal; effect: string | null; nextWake: number | null };
const types = {
  one_shot: 'goals.oneShot',
  measurable: 'goals.measurable',
  recurring: 'goals.recurring',
} as const;
async function read<T>(name: OperationName, input: unknown): Promise<T> {
  return requireAccepted(
    await invokeOperation<T | OperationRejection>(await connectionManager.getHub(), name, input)
  );
}
function GoalList({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<GoalRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useVisibleTick(30_000, true, () => setVersion((value) => value + 1));
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    async function load() {
      const { goals } = await read<{ goals: SessionGoal[] }>('goal.session.list', {
        ownerSessionId: sessionId,
        includeClosed: false,
      });
      if (!alive) return;
      const schedules = (
        await Promise.all(
          [...new Set([sessionId, ...goals.map((goal) => goal.ownerSessionId)])].map(async (id) => {
            const result = await read<SessionScheduleListResult>('schedule.session.list', {
              target: { adapter: 'hyperneo', id },
            });
            if (!result.ok) throw new Error(result.reason);
            return result.schedules;
          })
        )
      ).flat();
      const next = await Promise.all(
        goals.map(async (goal) => {
          const { entries } = await read<{ entries: GoalJournalEntry[] }>('goal.journal.list', {
            ownerSessionId: sessionId,
            goalId: goal.id,
            limit: 1,
          });
          const schedule = schedules.find(
            (row) => row.sourceKind === 'goal' && row.sourceId === goal.id
          );
          return {
            goal,
            effect: entries[0]?.effect ?? null,
            nextWake: schedule?.status === 'active' ? schedule.nextRunAt : null,
          };
        })
      );
      if (alive) setRows(next);
    }
    void load()
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : t('goals.failed'));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const refresh = () => setVersion((value) => value + 1);
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
    };
  }, [sessionId, version]);
  return (
    <section aria-label={t('goals.title')} class="mt-2 text-sm" data-neo-goals={sessionId}>
      {loading && !rows.length && (
        <p role="status" class="py-3 text-fg-muted">
          {t('goals.loading')}
        </p>
      )}
      {error && (
        <p role="alert" class="py-3 text-danger">
          {error}{' '}
          <button
            type="button"
            class="text-accent hover:underline"
            onClick={() => setVersion((value) => value + 1)}
          >
            {t('goals.refresh')}
          </button>
        </p>
      )}
      {!loading && !error && !rows.length && (
        <NeoWorkEmpty icon="spark" title={t('goals.empty')} hint={t('goals.emptyHint')} />
      )}
      {rows.map(({ goal, effect, nextWake }) => (
        <article key={goal.id} data-neo-goal={goal.id} class="space-y-2 border-b border-line py-3">
          <h3 class="break-words font-medium">{goal.title}</h3>
          <p class="text-xs text-fg-muted">
            <span>{t(types[goal.type])}</span>
            {goal.status === 'paused' && (
              <>
                {' '}
                · <span>{t('goals.paused')}</span>
              </>
            )}
          </p>
          {Object.keys(goal.metrics).length ? (
            <div
              role="progressbar"
              aria-label={goal.title}
              aria-valuenow={goal.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              class="h-1.5 overflow-hidden rounded-full bg-fg-faint/20"
            >
              <div style={{ width: `${goal.progress}%` }} class="h-full bg-accent" />
            </div>
          ) : (
            goal.doneTest && (
              <p class="rounded bg-accent/10 px-2 py-1 text-xs">
                <span class="font-medium">{t('goals.doneTest')}: </span>
                {goal.doneTest}
              </p>
            )
          )}
          <p class="text-xs text-fg-muted">
            {t('goals.nextWake')}:{' '}
            {nextWake === null ? (
              <span>{t('goals.noWake')}</span>
            ) : (
              <time dateTime={new Date(nextWake).toISOString()}>
                {new Date(nextWake).toLocaleString(locale.value, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            )}
          </p>
          <div class="flow-root">
            <span class="break-words text-xs text-fg-muted">
              {effect === null ? t('goals.noJournal') : effect}
            </span>
            {selected === goal.id && (
              <GoalDefinition ownerSessionId={sessionId} goalId={goal.id} explicit />
            )}
            <ContentDisclosureControl
              expanded={selected === goal.id}
              onToggle={() => setSelected(selected === goal.id ? null : goal.id)}
              aria-label={goal.title}
            />
          </div>
        </article>
      ))}
    </section>
  );
}
export function NeoGoals({ sessionId }: { sessionId: string | null }) {
  return sessionId ? <GoalList key={sessionId} sessionId={sessionId} /> : null;
}
