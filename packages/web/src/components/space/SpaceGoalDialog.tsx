import type {
  SpaceGoal,
  SpaceGoalMetrics,
  SpaceGoalType,
  SpaceTaskPriority,
} from '@hyperneo/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';

interface SpaceGoalDialogProps {
  isOpen: boolean;
  goal?: SpaceGoal | null;
  onClose: () => void;
  onSaved?: (goal: SpaceGoal) => void;
}

const TYPE_OPTIONS: { value: SpaceGoalType; label: string }[] = [
  { value: 'one_shot', label: 'One-shot' },
  { value: 'measurable', label: 'Measurable' },
  { value: 'recurring', label: 'Recurring' },
];

const PRIORITY_OPTIONS: { value: SpaceTaskPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const COMMON_TIMEZONES = [
  'UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/Chicago',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
];

function parseLines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseLabels(value: string): string[] {
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

function formatMetricValue(value: SpaceGoalMetrics[string]): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value ?? '');
}

function isMetricScalar(value: unknown): value is SpaceGoalMetrics[string] {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function parseMetrics(value: string): SpaceGoalMetrics {
  const metrics: SpaceGoalMetrics = {};
  for (const line of parseLines(value)) {
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey?.trim();
    if (!key) continue;
    const rawValue = rest.join(':').trim();
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      metrics[key] = isMetricScalar(parsed) ? parsed : rawValue;
    } catch {
      metrics[key] = rawValue;
    }
  }
  return metrics;
}

function formatMetrics(metrics: SpaceGoalMetrics): string {
  return Object.entries(metrics)
    .map(([key, value]) => `${key}: ${formatMetricValue(value)}`)
    .join('\n');
}

export function SpaceGoalDialog({ isOpen, goal, onClose, onSaved }: SpaceGoalDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SpaceGoalType>('one_shot');
  const [priority, setPriority] = useState<SpaceTaskPriority>('normal');
  const [summary, setSummary] = useState('');
  const [progress, setProgress] = useState('0');
  const [labels, setLabels] = useState('');
  const [metrics, setMetrics] = useState('');
  const [nextSteps, setNextSteps] = useState('');
  const [preferredWorkflowId, setPreferredWorkflowId] = useState('');
  const [autoTriggerNext, setAutoTriggerNext] = useState(false);
  const [checkInCronExpression, setCheckInCronExpression] = useState('');
  const [checkInTimezone, setCheckInTimezone] = useState('UTC');
  const [originalCron, setOriginalCron] = useState('');
  const [originalTimezone, setOriginalTimezone] = useState('UTC');
  const [triggerImmediately, setTriggerImmediately] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const cronDirtyRef = useRef(false);
  const timezoneDirtyRef = useRef(false);

  const isEditing = Boolean(goal);
  const workflows = spaceStore.workflows.value.filter((workflow) => !workflow.disabled);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setTitle(goal?.title ?? '');
    setDescription(goal?.description ?? '');
    setType(goal?.type ?? 'one_shot');
    setPriority(goal?.priority ?? 'normal');
    setSummary(goal?.summary ?? '');
    setProgress(String(goal?.progress ?? 0));
    setLabels(goal?.labels.join(', ') ?? '');
    setMetrics(goal ? formatMetrics(goal.metrics) : '');
    setNextSteps(goal?.nextSteps.join('\n') ?? '');
    setPreferredWorkflowId(goal?.preferredWorkflowId ?? '');
    setAutoTriggerNext(goal?.autoTriggerNext ?? false);
    setCheckInCronExpression('');
    setCheckInTimezone('UTC');
    setOriginalCron('');
    setOriginalTimezone('UTC');
    setTriggerImmediately(false);
    setError(null);
    cronDirtyRef.current = false;
    timezoneDirtyRef.current = false;
    setScheduleLoading(Boolean(goal?.taskScheduleId));

    if (goal?.taskScheduleId) {
      spaceStore
        .getSchedule(goal.taskScheduleId)
        .then((schedule) => {
          if (cancelled) return;
          setScheduleLoading(false);
          if (!schedule) return;
          const cron = schedule.cronExpression ?? '';
          const tz = schedule.timezone ?? 'UTC';
          setOriginalCron(cron);
          setOriginalTimezone(tz);
          if (!cronDirtyRef.current) setCheckInCronExpression(cron);
          if (!timezoneDirtyRef.current) setCheckInTimezone(tz);
        })
        .catch(() => {
          if (cancelled) return;
          setError('Could not load the check-in schedule. Close and reopen the dialog to retry.');
        });
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, goal?.id, goal?.taskScheduleId]);

  const parsedProgress = useMemo(() => {
    const next = Number(progress);
    if (!Number.isFinite(next)) return null;
    return Math.max(0, Math.min(100, Math.round(next)));
  }, [progress]);

  const handleSubmit = async (event: Event) => {
    event.preventDefault();
    if (!title.trim()) {
      setError('Goal title is required');
      return;
    }
    if (type !== 'recurring' && parsedProgress === null) {
      setError('Progress must be a number');
      return;
    }

    const nextCron = checkInCronExpression.trim();

    try {
      setSubmitting(true);
      setError(null);
      const payload = {
        title: title.trim(),
        description: description.trim(),
        type,
        priority,
        labels: parseLabels(labels),
        metrics: parseMetrics(metrics),
        summary: summary.trim(),
        ...(type !== 'recurring' ? { progress: parsedProgress ?? 0 } : {}),
        nextSteps: parseLines(nextSteps),
        preferredWorkflowId: preferredWorkflowId || null,
        autoTriggerNext,
      };
      const saved = goal
        ? await spaceStore.updateGoal(goal.id, {
            ...payload,
            ...(nextCron !== originalCron ? { checkInCronExpression: nextCron || null } : {}),
            ...(nextCron !== '' && checkInTimezone !== originalTimezone ? { checkInTimezone } : {}),
          })
        : await spaceStore.createGoal({
            ...payload,
            checkInCronExpression: nextCron || null,
            checkInTimezone,
            triggerImmediately,
          });
      toast.success(`Goal "${saved.title}" ${goal ? 'updated' : 'created'}`);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save goal');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditing ? 'Edit Goal' : 'Create Goal'}
      size="lg"
    >
      <form onSubmit={handleSubmit} class="space-y-4">
        {error && (
          <div class="rounded-lg border border-danger bg-danger/20 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        )}

        <div>
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">
              Title<span class="ml-1 text-danger">*</span>
            </span>
            <input
              type="text"
              value={title}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              placeholder="Keep release train healthy"
              class="w-full rounded-lg border border-line-strong bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-600 focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <div>
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">Description</span>
            <textarea
              value={description}
              onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
              rows={3}
              placeholder="What should agents keep driving toward?"
              class="w-full resize-none rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">Type</span>
            <select
              value={type}
              onChange={(e) => setType((e.target as HTMLSelectElement).value as SpaceGoalType)}
              class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">Priority</span>
            <select
              value={priority}
              onChange={(e) =>
                setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)
              }
              class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {type !== 'recurring' ? (
            <label class="block">
              <span class="mb-1.5 block text-sm font-medium text-fg-soft">Progress</span>
              <input
                type="number"
                min={0}
                max={100}
                value={progress}
                onInput={(e) => setProgress((e.target as HTMLInputElement).value)}
                class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              />
            </label>
          ) : (
            <div class="rounded-lg border border-line bg-surface-raised/60 px-3 py-2 text-xs text-fg-faint">
              Recurring goals use activity and metrics instead of progress.
            </div>
          )}
        </div>

        <label class="block">
          <span class="mb-1.5 block text-sm font-medium text-fg-soft">Preferred workflow</span>
          <select
            value={preferredWorkflowId}
            onChange={(e) => setPreferredWorkflowId((e.target as HTMLSelectElement).value)}
            class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            <option value="">Auto-select workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </label>

        <label class="block">
          <span class="mb-1.5 block text-sm font-medium text-fg-soft">Summary</span>
          <textarea
            value={summary}
            onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
            rows={2}
            placeholder="Rolling state summary"
            class="w-full resize-none rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
          />
        </label>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">Labels</span>
            <input
              value={labels}
              onInput={(e) => setLabels((e.target as HTMLInputElement).value)}
              placeholder="release, health"
              class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
            />
          </label>
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-fg-soft">Metrics</span>
            <textarea
              value={metrics}
              onInput={(e) => setMetrics((e.target as HTMLTextAreaElement).value)}
              rows={2}
              placeholder={'build_health: green\nopen_bugs: 3'}
              class="w-full resize-none rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
            />
          </label>
        </div>

        <label class="block">
          <span class="mb-1.5 block text-sm font-medium text-fg-soft">Next steps</span>
          <textarea
            value={nextSteps}
            onInput={(e) => setNextSteps((e.target as HTMLTextAreaElement).value)}
            rows={3}
            placeholder="One next step per line"
            class="w-full resize-none rounded-lg border border-line bg-surface-raised px-4 py-2.5 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
          />
        </label>

        <label class="flex items-center gap-2 text-sm text-fg-soft">
          <input
            type="checkbox"
            checked={autoTriggerNext}
            onChange={(e) => setAutoTriggerNext((e.target as HTMLInputElement).checked)}
            class="h-4 w-4 rounded border-line-strong bg-surface-raised text-accent"
          />
          Auto-trigger next task when current task finishes
        </label>

        <div class="space-y-3 rounded-lg border border-line bg-surface-raised/50 p-4">
          <p class="text-xs font-semibold uppercase tracking-wider text-fg-muted">Check-in</p>
          <p class="text-xs text-fg-faint">
            {isEditing
              ? 'Edit the recurring check-in schedule. Clearing the cron removes it; changing it reschedules in place without affecting the active task.'
              : 'Schedule recurring check-in tasks for this goal.'}
          </p>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label class="block">
              <span class="mb-1.5 block text-sm font-medium text-fg-soft">Cron expression</span>
              <input
                value={checkInCronExpression}
                onInput={(e) => {
                  cronDirtyRef.current = true;
                  setCheckInCronExpression((e.target as HTMLInputElement).value);
                }}
                placeholder="@daily or 0 9 * * 1"
                class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg placeholder-gray-500 focus:border-accent focus:outline-none"
              />
            </label>
            <label class="block">
              <span class="mb-1.5 block text-sm font-medium text-fg-soft">Timezone</span>
              <select
                value={checkInTimezone}
                onChange={(e) => {
                  timezoneDirtyRef.current = true;
                  setCheckInTimezone((e.target as HTMLSelectElement).value);
                }}
                class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
              >
                {Array.from(
                  new Set(
                    checkInTimezone && !COMMON_TIMEZONES.includes(checkInTimezone)
                      ? [...COMMON_TIMEZONES, checkInTimezone]
                      : COMMON_TIMEZONES
                  )
                ).map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!isEditing && (
            <label class="flex items-center gap-2 text-sm text-fg-soft">
              <input
                type="checkbox"
                checked={triggerImmediately}
                onChange={(e) => setTriggerImmediately((e.target as HTMLInputElement).checked)}
                class="h-4 w-4 rounded border-line-strong bg-surface-raised text-accent"
              />
              Create first task immediately
            </label>
          )}
        </div>

        <div class="flex gap-3 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} fullWidth>
            Cancel
          </Button>
          <Button type="submit" loading={submitting} disabled={scheduleLoading} fullWidth>
            {isEditing ? 'Save Goal' : 'Create Goal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
