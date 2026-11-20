import { GoalJournal, goalMandateLink } from './SessionGoalJournal.tsx';
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
import { NeoWorkEmpty } from '../neo/NeoWorkEmpty.tsx';

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
export function GoalDefinition({
  ownerSessionId,
  goalId,
  explicit,
}: {
  ownerSessionId: string;
  goalId: string;
  explicit?: boolean;
}) {
  const [goal, setGoal] = useState<SessionGoal | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    setGoal(null);
    setError('');
    setRemote(null);
    void call<{ accepted: true; goal: SessionGoal } | { accepted: false; reason: string }>(
      'goal.session.get',
      { ownerSessionId, goalId }
    )
      .then(async (result) => {
        if (!alive) return;
        if (!result.accepted) throw new Error(result.reason);
        setGoal(result.goal);
        if (result.goal.mandateRef) {
          const home = await call<{ ok: boolean; remoteUrl?: string | null; reason?: string }>(
            'neo.home.read',
            {
              path: result.goal.mandateRef.split('#')[0],
              includeRemote: true,
            }
          ).catch(() => null);
          if (alive && home?.ok) setRemote(home.remoteUrl ?? null);
        }
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [ownerSessionId, goalId]);
  const mandate = goal && remote ? goalMandateLink(remote, goal) : undefined;
  return (
    <div class="mt-2 space-y-3 break-words border-l-2 border-line pl-3">
      {error && (
        <p role="alert" class="text-danger">
          {error}
        </p>
      )}
      {!goal ? (
        !error && t('schedules.loading')
      ) : (
        <>
          <p class="whitespace-pre-wrap">{goal.description}</p>
          {Object.entries(goal.metrics).map(([name, value]) => (
            <p key={name}>
              {name}: {String(value ?? '—')}
            </p>
          ))}
          {goal.doneTest && (
            <p class="mt-1">
              <span class="font-medium">{t('schedules.doneTest')}: </span>
              {goal.doneTest}
            </p>
          )}
          {goal.mandateRef && (
            <p>
              {mandate ? (
                <a
                  href={mandate}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-accent hover:underline"
                >
                  {goal.mandateRef}
                </a>
              ) : (
                goal.mandateRef
              )}
            </p>
          )}
          {!!goal.nextSteps.length && (
            <section>
              <h4 class="font-medium">{t('goalDetails.nextSteps')}</h4>
              <ul>
                {goal.nextSteps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 class="font-medium">{t('goalDetails.works')}</h4>
            <p class="whitespace-pre-wrap">{goal.worksNote ?? t('goalDetails.noNote')}</p>
          </section>
          <GoalJournal
            key={`${ownerSessionId}:${goalId}`}
            ownerSessionId={ownerSessionId}
            goalId={goalId}
            explicit={explicit}
          />
        </>
      )}
    </div>
  );
}
function everyText(ms: number) {
  const minutes = Math.round(ms / 60000);
  if (minutes % 10080 === 0)
    return minutes === 10080
      ? t('schedules.weekly')
      : t('schedules.everyWeeks', { n: minutes / 10080 });
  if (minutes % 1440 === 0)
    return minutes === 1440
      ? t('schedules.daily')
      : t('schedules.everyDays', { n: minutes / 1440 });
  if (minutes % 60 === 0)
    return minutes === 60 ? t('schedules.hourly') : t('schedules.everyHours', { n: minutes / 60 });
  return t('schedules.every', { minutes });
}
function cadenceText(row: SessionScheduleView) {
  return row.cadence.kind === 'every' ? (
    everyText(row.cadence.everyMs)
  ) : row.cadence.kind === 'once' ? (
    <>
      {t('schedules.once')}: <RunTime at={row.cadence.at} />
    </>
  ) : (
    `${row.cadence.cron} · ${row.cadence.timezone}`
  );
}
function ScheduleStrip({
  sessionId,
  readonly,
  inline,
}: {
  sessionId: string;
  readonly?: boolean;
  inline?: boolean;
}) {
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
  if (inline)
    return (
      <section
        aria-label={t('schedules.title')}
        class="mt-2 text-sm"
        data-session-schedules={sessionId}
      >
        {error && (
          <p role="alert" class="py-3 text-danger">
            {error}{' '}
            <button
              type="button"
              class="text-accent hover:underline"
              onClick={() => setVersion((value) => value + 1)}
            >
              {t('schedules.refresh')}
            </button>
          </p>
        )}
        {loading && !rows.length && (
          <p role="status" class="py-3 text-fg-muted">
            {t('schedules.loading')}
          </p>
        )}
        {!loading && !error && !rows.length && (
          <NeoWorkEmpty icon="clock" title={t('schedules.empty')} hint={t('schedules.emptyHint')} />
        )}
        <ul>
          {rows.map((row) => (
            <li key={row.id} data-schedule={row.id} class="border-b border-line py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 break-words font-medium text-fg">
                  {row.sourceKind === 'goal' && row.sourceLabel ? (
                    <button
                      type="button"
                      class="text-left hover:underline"
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
                  <button
                    type="button"
                    class="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
                    disabled={readonly || loading || !!busy}
                    onClick={() => void change(row)}
                  >
                    {row.status === 'active' ? t('schedules.pause') : t('schedules.resume')}
                  </button>
                )}
              </div>
              <p class="mt-1 text-xs text-fg-muted">
                {isMessageKey(`schedules.kind.${row.sourceKind}`) && (
                  <>{factLabel('kind', row.sourceKind)} · </>
                )}
                {cadenceText(row)}
                {row.status !== 'active' && <> · {factLabel('status', row.status)}</>}
              </p>
              <p class="text-xs text-fg-muted">
                {t('schedules.next')} <RunTime at={row.nextRunAt} /> · {t('schedules.last')}{' '}
                <RunTime at={row.lastRunAt} />
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
              {goal === row.id && (
                <GoalDefinition ownerSessionId={sessionId} goalId={row.sourceId} />
              )}
            </li>
          ))}
        </ul>
      </section>
    );
  return (
    <details
      class="mx-4 my-2 shrink-0 rounded-lg border border-line text-xs text-fg-muted"
      data-session-schedules={sessionId}
    >
      <summary class="cursor-pointer px-3 py-2">
        <span class="font-medium text-fg">{t('schedules.title')}</span>
        {!loading && !error && <> · {rows.length}</>}
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
            <p>{cadenceText(row)}</p>
            <p>{factLabel('status', row.status)}</p>
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
  inline,
}: {
  sessionId: string | null;
  readonly?: boolean;
  inline?: boolean;
}) {
  return sessionId ? (
    <ScheduleStrip key={sessionId} sessionId={sessionId} readonly={readonly} inline={inline} />
  ) : null;
}
