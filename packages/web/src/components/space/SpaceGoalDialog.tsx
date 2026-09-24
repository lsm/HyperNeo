import type {
  SpaceGoal,
  SpaceGoalMetrics,
  SpaceGoalType,
  SpaceTaskPriority,
} from '@hyperneo/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import {
  FORM_CHECKBOX_CLASS,
  FORM_CONTROL_CLASS,
  FormActions,
  FormField,
  FormSection,
} from '../ui/FormField';
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
      footer={
        <FormActions
          error={error}
          onCancel={onClose}
          submitLabel={isEditing ? 'Save Goal' : 'Create Goal'}
          submitting={submitting}
          submitDisabled={scheduleLoading}
          formId="space-goal-form"
        />
      }
    >
      <form id="space-goal-form" onSubmit={handleSubmit} class="space-y-4">
        <FormField label="Title" required>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="Keep release train healthy"
            class={FORM_CONTROL_CLASS}
          />
        </FormField>

        <FormField label="Description">
          <textarea
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            rows={3}
            placeholder="What should agents keep driving toward?"
            class={cn(FORM_CONTROL_CLASS, 'resize-none')}
          />
        </FormField>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <FormField label="Type">
            <select
              value={type}
              onChange={(e) => setType((e.target as HTMLSelectElement).value as SpaceGoalType)}
              class={FORM_CONTROL_CLASS}
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          <FormField label="Priority">
            <select
              value={priority}
              onChange={(e) =>
                setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)
              }
              class={FORM_CONTROL_CLASS}
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </FormField>
          {type !== 'recurring' ? (
            <FormField label="Progress">
              <input
                type="number"
                min={0}
                max={100}
                value={progress}
                onInput={(e) => setProgress((e.target as HTMLInputElement).value)}
                class={FORM_CONTROL_CLASS}
              />
            </FormField>
          ) : (
            <FormField label="Progress">
              <div class="rounded border border-line bg-surface px-2.5 py-1.5 text-xs text-fg-faint">
                Recurring goals use activity and metrics instead of progress.
              </div>
            </FormField>
          )}
        </div>

        <FormField label="Preferred workflow">
          <select
            value={preferredWorkflowId}
            onChange={(e) => setPreferredWorkflowId((e.target as HTMLSelectElement).value)}
            class={FORM_CONTROL_CLASS}
          >
            <option value="">Auto-select workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="Summary">
          <textarea
            value={summary}
            onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
            rows={2}
            placeholder="Rolling state summary"
            class={cn(FORM_CONTROL_CLASS, 'resize-none')}
          />
        </FormField>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Labels">
            <input
              value={labels}
              onInput={(e) => setLabels((e.target as HTMLInputElement).value)}
              placeholder="release, health"
              class={FORM_CONTROL_CLASS}
            />
          </FormField>
          <FormField label="Metrics">
            <textarea
              value={metrics}
              onInput={(e) => setMetrics((e.target as HTMLTextAreaElement).value)}
              rows={2}
              placeholder={'build_health: green\nopen_bugs: 3'}
              class={cn(FORM_CONTROL_CLASS, 'resize-none')}
            />
          </FormField>
        </div>

        <FormField label="Next steps">
          <textarea
            value={nextSteps}
            onInput={(e) => setNextSteps((e.target as HTMLTextAreaElement).value)}
            rows={3}
            placeholder="One next step per line"
            class={cn(FORM_CONTROL_CLASS, 'resize-none')}
          />
        </FormField>

        <label class="flex items-center gap-2 text-sm text-fg-soft">
          <input
            type="checkbox"
            checked={autoTriggerNext}
            onChange={(e) => setAutoTriggerNext((e.target as HTMLInputElement).checked)}
            class={FORM_CHECKBOX_CLASS}
          />
          Auto-trigger next task when current task finishes
        </label>

        <FormSection
          title="Check-in"
          hint={
            isEditing
              ? 'Edit the recurring check-in schedule. Clearing the cron removes it; changing it reschedules in place without affecting the active task.'
              : 'Schedule recurring check-in tasks for this goal.'
          }
        >
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Cron expression">
              <input
                value={checkInCronExpression}
                onInput={(e) => {
                  cronDirtyRef.current = true;
                  setCheckInCronExpression((e.target as HTMLInputElement).value);
                }}
                placeholder="@daily or 0 9 * * 1"
                class={FORM_CONTROL_CLASS}
              />
            </FormField>
            <FormField label="Timezone">
              <select
                value={checkInTimezone}
                onChange={(e) => {
                  timezoneDirtyRef.current = true;
                  setCheckInTimezone((e.target as HTMLSelectElement).value);
                }}
                class={FORM_CONTROL_CLASS}
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
            </FormField>
          </div>
          {!isEditing && (
            <label class="flex items-center gap-2 text-sm text-fg-soft">
              <input
                type="checkbox"
                checked={triggerImmediately}
                onChange={(e) => setTriggerImmediately((e.target as HTMLInputElement).checked)}
                class={FORM_CHECKBOX_CLASS}
              />
              Create first task immediately
            </label>
          )}
        </FormSection>
      </form>
    </Modal>
  );
}
