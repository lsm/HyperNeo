import { useEffect, useMemo, useState } from 'preact/hooks';
import { Modal } from '../ui/Modal';
import {
  FORM_CHECKBOX_CLASS,
  FORM_CONTROL_CLASS,
  FormActions,
  FormField,
  FormSection,
} from '../ui/FormField';
import { spaceStore } from '../../lib/space-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import type {
  SpaceTaskPriority,
  SpaceWorkspace,
  TaskCore,
  TaskScheduleTriggerType,
} from '@hyperneo/shared';

interface SpaceCreateTaskDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated?: (task: TaskCore) => void;
}

const PRIORITY_OPTIONS: { value: SpaceTaskPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const TRIGGER_OPTIONS: { value: TaskScheduleTriggerType; label: string }[] = [
  { value: 'at', label: 'One-time' },
  { value: 'cron', label: 'Recurring' },
];

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: '@hourly', value: '@hourly' },
  { label: '@daily', value: '@daily' },
  { label: '@midnight', value: '@midnight' },
  { label: '@weekly', value: '@weekly' },
  { label: '@monthly', value: '@monthly' },
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

function isValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;

  if (/^@(hourly|daily|midnight|weekly|monthly|yearly|annually)$/.test(trimmed)) return true;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;

  const hasSeconds = parts.length === 6;

  const fieldPatterns = [
    /^([0-5]?\d|[*](?:\/[1-9]\d?)?|(?:[0-5]?\d)(?:-[0-5]?\d)?(?:\/[1-9]\d?)?|(?:[0-5]?\d|[*])(?:,(?:[0-5]?\d|[*]|[0-5]?\d-[0-5]?\d))+|\?)$/,
    /^([0-5]?\d|[*](?:\/[1-9]\d?)?|(?:[0-5]?\d)(?:-[0-5]?\d)?(?:\/[1-9]\d?)?|(?:[0-5]?\d|[*])(?:,(?:[0-5]?\d|[*]|[0-5]?\d-[0-5]?\d))+|\?)$/,
    /^([01]?\d|2[0-3]|[*](?:\/[1-9]\d?)?|(?:[01]?\d|2[0-3])(?:-[01]?\d|2[0-3])?(?:\/[1-9]\d?)?|(?:[01]?\d|2[0-3]|[*])(?:,(?:[01]?\d|2[0-3]|[*]|[01]?\d-2[0-3]|[01]?\d-[01]?\d|2[0-3]-2[0-3]))+|\?)$/,
    /^([1-9]|[12]\d|3[01]|[*](?:\/[1-9]\d?)?|(?:[1-9]|[12]\d|3[01])(?:-[1-9]|[12]\d|3[01])?(?:\/[1-9]\d?)?|(?:[1-9]|[12]\d|3[01]|[*])(?:,(?:[1-9]|[12]\d|3[01]|[*]|[1-9]-[1-9]|[1-9]-[12]\d|[1-9]-3[01]|[12]\d-[12]\d|[12]\d-3[01]|3[01]-3[01]))+|L|L-[1-9]|L-[12]\d|L-3[01]|LW|\?|(?:[1-9]|[12]\d|3[01])W)$/,
    /^([1-9]|1[0-2]|[*](?:\/[1-9]\d?)?|(?:[1-9]|1[0-2])(?:-[1-9]|1[0-2])?(?:\/[1-9]\d?)?|(?:[1-9]|1[0-2]|[*])(?:,(?:[1-9]|1[0-2]|[*]|[1-9]-[1-9]|[1-9]-1[0-2]|1[0-2]-1[0-2]))+|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|\?)$/i,
    /^([0-7]|[*](?:\/[1-9]\d?)?|(?:[0-7])(?:-[0-7])?(?:\/[1-9]\d?)?|(?:[0-7]|[*])(?:,(?:[0-7]|[*]|[0-7]-[0-7]))+|\+|\+[0-7]|\+(?:MON|TUE|WED|THU|FRI|SAT|SUN)|MON|TUE|WED|THU|FRI|SAT|SUN|L|\?|(?:MON|TUE|WED|THU|FRI|SAT|SUN)#(?:[1-5]|L))$/i,
  ];

  for (let i = 0; i < parts.length; i++) {
    const patternIdx = hasSeconds ? i : i + 1;
    if (!fieldPatterns[patternIdx].test(parts[i])) return false;
  }
  return true;
}

function toDatetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatPreviewDate(ts: number, timezone: string): string {
  return new Date(ts).toLocaleString('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function getBrowserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function workspaceTitle(workspace: SpaceWorkspace): string {
  if (workspace.label) return workspace.label;
  return workspace.path.split('/').filter(Boolean).at(-1) ?? workspace.path;
}

function getSchedulePreview(
  triggerType: TaskScheduleTriggerType,
  cronExpression: string,
  runAt: number | null,
  timezone: string
): string | null {
  if (triggerType === 'at' && runAt) {
    const localTz = getBrowserTimezone();
    return `One-time run at ${formatPreviewDate(runAt, localTz)} (${localTz})`;
  }
  if (triggerType === 'cron' && cronExpression) {
    const preset = CRON_PRESETS.find((p) => p.value === cronExpression);
    if (preset) return `${preset.label} in ${timezone}`;
    return `Recurring: ${cronExpression} (${timezone})`;
  }
  return null;
}

export function SpaceCreateTaskDialog({ isOpen, onClose, onCreated }: SpaceCreateTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<SpaceTaskPriority>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [triggerType, setTriggerType] = useState<TaskScheduleTriggerType>('at');
  const [cronExpression, setCronExpression] = useState('');
  const [runAt, setRunAt] = useState<number | null>(null);
  const [timezone, setTimezone] = useState('UTC');

  const [workspaces, setWorkspaces] = useState<SpaceWorkspace[] | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    spaceStore
      .listWorkspaces()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list);
        setWorkspacePath(list.find((w) => w.isPrimary)?.path ?? list[0]?.path ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setWorkspaces(null);
        setWorkspacePath(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const handleClose = () => {
    setTitle('');
    setDescription('');
    setPriority('normal');
    setError(null);
    setScheduleEnabled(false);
    setTriggerType('at');
    setCronExpression('');
    setRunAt(null);
    setTimezone('UTC');
    setWorkspaces(null);
    setWorkspacePath(null);
    onClose();
  };

  const validationError = useMemo(() => {
    if (!scheduleEnabled) return null;
    if (triggerType === 'cron') {
      if (!cronExpression.trim()) return 'Cron expression is required';
      if (!isValidCronExpression(cronExpression)) return 'Invalid cron expression';
    }
    if (triggerType === 'at') {
      if (!runAt) return 'Run date/time is required';
    }
    return null;
  }, [scheduleEnabled, triggerType, cronExpression, runAt]);

  const preview = useMemo(() => {
    if (!scheduleEnabled) return null;
    return getSchedulePreview(triggerType, cronExpression, runAt, timezone);
  }, [scheduleEnabled, triggerType, cronExpression, runAt, timezone]);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();

    if (!title.trim()) {
      setError('Task title is required');
      return;
    }

    if (scheduleEnabled && validationError) {
      setError(validationError);
      return;
    }

    if (scheduleEnabled && triggerType === 'at' && runAt && runAt <= Date.now()) {
      setError('Run time must be in the future');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      if (scheduleEnabled) {
        const schedule = await spaceStore.createSchedule({
          title: title.trim(),
          description: description.trim(),
          priority,
          triggerType,
          cronExpression: triggerType === 'cron' ? cronExpression.trim() : null,
          runAt: triggerType === 'at' ? runAt : null,
          timezone: triggerType === 'cron' ? timezone : null,
        });
        toast.success(`Scheduled task "${schedule.title}" created`);
      } else {
        const task = await spaceStore.createTask({
          title: title.trim(),
          description: description.trim(),
          priority,
          ...(workspacePath ? { workspacePath } : {}),
        });
        toast.success(`Task "${task.title}" created`);
        onCreated?.(task);
      }
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Create Task"
      size="md"
      footer={
        <FormActions
          error={error}
          onCancel={handleClose}
          submitLabel={scheduleEnabled ? 'Create Schedule' : 'Create Task'}
          submitting={submitting}
          formId="space-create-task-form"
        />
      }
    >
      <form id="space-create-task-form" onSubmit={handleSubmit} class="space-y-4">
        <FormField label="Title" required>
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
            placeholder="e.g., Implement authentication module"
            class={FORM_CONTROL_CLASS}
            autoFocus
          />
        </FormField>

        <FormField label="Description" optional>
          <textarea
            value={description}
            onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
            placeholder="Describe what this task should accomplish..."
            rows={3}
            class={cn(FORM_CONTROL_CLASS, 'resize-none')}
          />
        </FormField>

        <FormField label="Priority">
          <select
            value={priority}
            onChange={(e) =>
              setPriority((e.target as HTMLSelectElement).value as SpaceTaskPriority)
            }
            class={FORM_CONTROL_CLASS}
          >
            {PRIORITY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </FormField>

        {workspaces && workspaces.length > 0 && !scheduleEnabled && (
          <FormField label="Workspace">
            <select
              value={workspacePath ?? undefined}
              onChange={(e) => setWorkspacePath((e.target as HTMLSelectElement).value)}
              data-testid="task-workspace-select"
              class={FORM_CONTROL_CLASS}
            >
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.path}>
                  {workspaceTitle(workspace)}
                  {workspace.isPrimary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </FormField>
        )}

        <div class="border-t border-line pt-4">
          <label class="flex items-center gap-2 text-sm text-fg-soft cursor-pointer">
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={(e) => setScheduleEnabled((e.target as HTMLInputElement).checked)}
              class={FORM_CHECKBOX_CLASS}
            />
            Schedule this task
          </label>
        </div>

        {scheduleEnabled && (
          <FormSection title="Schedule">
            <FormField label="Trigger">
              <div class="flex gap-2">
                {TRIGGER_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    class={`flex items-center gap-2 px-3 py-1.5 rounded border cursor-pointer text-xs font-medium transition-colors ${
                      triggerType === opt.value
                        ? 'border-accent bg-accent/20 text-accent-soft'
                        : 'border-line text-fg-muted hover:border-line-strong hover:text-fg-soft'
                    }`}
                  >
                    <input
                      type="radio"
                      name="triggerType"
                      value={opt.value}
                      checked={triggerType === opt.value}
                      onChange={() => {
                        setTriggerType(opt.value);
                        if (opt.value === 'at') {
                          setTimezone('UTC');
                        }
                      }}
                      class="sr-only"
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            </FormField>

            {triggerType === 'at' && (
              <FormField label="Run at" required>
                <input
                  type="datetime-local"
                  value={runAt ? toDatetimeLocalValue(runAt) : ''}
                  onInput={(e) => {
                    const val = (e.target as HTMLInputElement).value;
                    setRunAt(val ? new Date(val).getTime() : null);
                  }}
                  class={FORM_CONTROL_CLASS}
                />
              </FormField>
            )}

            {triggerType === 'cron' && (
              <FormField label="Cron expression" required>
                <div class="flex gap-1.5 flex-wrap mb-2">
                  {CRON_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      onClick={() => setCronExpression(preset.value)}
                      class={`px-2 py-0.5 text-xs rounded border transition-colors ${
                        cronExpression === preset.value
                          ? 'border-accent bg-accent/20 text-accent-soft'
                          : 'border-line text-fg-muted hover:border-line-strong hover:text-fg-soft'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  value={cronExpression}
                  onInput={(e) => setCronExpression((e.target as HTMLInputElement).value)}
                  placeholder="0 9 * * 1"
                  class={cn(
                    FORM_CONTROL_CLASS,
                    'font-mono',
                    cronExpression &&
                      !isValidCronExpression(cronExpression) &&
                      'border-danger focus:border-danger'
                  )}
                />
                {cronExpression && !isValidCronExpression(cronExpression) && (
                  <p class="mt-1 text-xs text-danger">Invalid cron expression</p>
                )}
              </FormField>
            )}

            {triggerType === 'cron' && (
              <FormField label="Timezone">
                <select
                  value={timezone}
                  onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
                  class={FORM_CONTROL_CLASS}
                >
                  {COMMON_TIMEZONES.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </FormField>
            )}

            {preview && (
              <div class="text-xs text-fg-muted bg-surface/60 rounded px-2.5 py-1.5 border border-line">
                {preview}
              </div>
            )}
          </FormSection>
        )}
      </form>
    </Modal>
  );
}
