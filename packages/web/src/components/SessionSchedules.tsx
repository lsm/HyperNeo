import type {
  SessionScheduleListResult,
  SessionScheduleView,
} from '@hyperneo/shared/types/session-schedule';
import type { SessionGoal } from '@hyperneo/shared/types/session-goal';
import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { invokeOperation } from '../lib/operations.ts';
import { isMessageKey, locale, t } from '../lib/i18n/index.ts';
import { useVisibleTick } from '../hooks/useVisibleTick.ts';
import { Button } from './ui/Button.tsx';

async function call<T>(name: OperationName, input: unknown): Promise<T> {
  return invokeOperation<T>(await connectionManager.getHub(), name, input);
}
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : t('schedules.failed');
function factLabel(group: string, value: string) {
  const key = `schedules.${group}.${value}`;
  return isMessageKey(key) ? t(key) : value;
}
function RunTime({ at }: { at: number | null }) {
  return at === null ? (
    <span>{t('schedules.none')}</span>
  ) : (
    <time dateTime={new Date(at).toISOString()}>
      {new Date(at).toLocaleString(locale.value, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })}
    </time>
  );
}
function GoalDefinition({ ownerSessionId, goalId }: { ownerSessionId: string; goalId: string }) {
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void call<{ accepted: true; goal: SessionGoal } | { accepted: false; reason: string }>(
      'goal.session.get',
      { ownerSessionId, goalId }
    )
      .then((result) => {
        if (!alive) return;
        if (!result.accepted) throw new Error(result.reason);
        setGoal(result.goal);
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [ownerSessionId, goalId]);
  return (
    <div class="mt-2 border-l-2 border-line pl-3">
      {error ? (
        <p role="alert">{error}</p>
      ) : !goal ? (
        t('schedules.loading')
      ) : (
        <>
          <p class="whitespace-pre-wrap">{goal.description}</p>
          {goal.doneTest && (
            <p class="mt-1">
              <span class="font-medium">{t('schedules.doneTest')}: </span>
              {goal.doneTest}
            </p>
          )}
        </>
      )}
    </div>
  );
}
function ScheduleStrip({ sessionId, readonly }: { sessionId: string; readonly?: boolean }) {
  const [rows, setRows] = useState<SessionScheduleView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [version, setVersion] = useState(0);
  const [goal, setGoal] = useState<string | null>(null);
  useVisibleTick(30_000, true, () => setVersion((value) => value + 1));
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void call<SessionScheduleListResult>('schedule.session.list', {
      target: { adapter: 'hyperneo', id: sessionId },
    })
      .then((result) => {
        if (!alive) return;
        if (!result.ok) throw new Error(result.reason);
        setRows(result.schedules);
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
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
  async function change(row: SessionScheduleView) {
    setBusy(row.id);
    setError('');
    try {
      const result = await call<{ ok: boolean; reason?: string }>(
        row.status === 'active' ? 'schedule.session.pause' : 'schedule.session.resume',
        { scheduleId: row.id }
      );
      if (!result.ok) throw new Error(result.reason);
      setVersion((value) => value + 1);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy('');
    }
  }
  return (
    <details
      class="mx-4 my-2 shrink-0 rounded-lg border border-line text-xs text-fg-muted"
      data-session-schedules={sessionId}
    >
      <summary class="cursor-pointer px-3 py-2">
        <span class="font-medium text-fg">{t('schedules.title')}</span> · {rows.length}
      </summary>
      <div class="max-h-64 space-y-2 overflow-y-auto px-3 pb-3">
        <Button
          variant="ghost"
          size="xs"
          disabled={loading || !!busy}
          onClick={() => setVersion((value) => value + 1)}
        >
          {t('schedules.refresh')}
        </Button>
        {error && (
          <p role="alert" class="text-danger">
            {error}
          </p>
        )}
        {loading && <p role="status">{t('schedules.loading')}</p>}
        {!loading && !error && !rows.length && <p>{t('schedules.empty')}</p>}
        {rows.map((row) => (
          <article key={row.id} data-schedule={row.id} class="border-t border-line py-2">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 break-words font-medium text-fg">
                {row.sourceKind === 'goal' && row.sourceLabel ? (
                  <button
                    type="button"
                    class="text-left text-accent hover:underline"
                    aria-expanded={goal === row.id}
                    onClick={() => setGoal(goal === row.id ? null : row.id)}
                  >
                    {row.sourceLabel}
                  </button>
                ) : (
                  (row.sourceLabel ?? t('schedules.unavailable'))
                )}
              </div>
              {row.status !== 'done' && (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={readonly || loading || !!busy}
                  onClick={() => void change(row)}
                >
                  {row.status === 'active' ? t('schedules.pause') : t('schedules.resume')}
                </Button>
              )}
            </div>
            <p>
              {row.cadence.kind === 'every'
                ? t('schedules.every', { minutes: row.cadence.everyMs / 60000 })
                : `${row.cadence.cron} · ${row.cadence.timezone}`}
            </p>
            <p>
              {factLabel('status', row.status)} ·{' '}
              {row.dueCount >= row.nudgeEvery
                ? t('schedules.nudgeDue')
                : t('schedules.nudge', { count: row.nudgeEvery - row.dueCount })}
            </p>
            <p>
              {t('schedules.next')}: <RunTime at={row.nextRunAt} />
            </p>
            <p>
              {t('schedules.last')}: <RunTime at={row.lastRunAt} />
              {row.lastOutcome && (
                <>
                  {' '}
                  ·{' '}
                  {row.lastOutcome.startsWith('skipped_')
                    ? t('schedules.skipped')
                    : factLabel('outcome', row.lastOutcome)}
                  {row.lastSkipReason && <> · {factLabel('reason', row.lastSkipReason)}</>}
                </>
              )}
            </p>
            {goal === row.id && <GoalDefinition ownerSessionId={sessionId} goalId={row.sourceId} />}
          </article>
        ))}
      </div>
    </details>
  );
}
export function SessionSchedules({
  sessionId,
  readonly,
}: {
  sessionId: string | null;
  readonly?: boolean;
}) {
  return sessionId ? (
    <ScheduleStrip key={sessionId} sessionId={sessionId} readonly={readonly} />
  ) : null;
}
