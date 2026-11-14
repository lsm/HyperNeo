import { useState } from 'preact/hooks';
import { NEO_TODO_LIMIT_DEFAULTS, neoTodoLimits } from '@hyperneo/shared/types/settings';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsSection.tsx';

type Field = 'maxRunningTodos' | 'maxRunningTodosPerProject';

const ROWS: { field: Field; key: 'running' | 'perGroup'; label: string; description: string }[] = [
  {
    field: 'maxRunningTodos',
    key: 'running',
    label: 'Running steps in total',
    description: `How many steps Neo runs at once across all work. Default ${NEO_TODO_LIMIT_DEFAULTS.running}.`,
  },
  {
    field: 'maxRunningTodosPerProject',
    key: 'perGroup',
    label: 'Running steps per project',
    description: `How many steps of one project run at once. Default ${NEO_TODO_LIMIT_DEFAULTS.perGroup}.`,
  },
];

export function NeoTodoLimitsSettings() {
  const settings = globalSettings.value;
  const neo = settings?.neo;
  const [saving, setSaving] = useState(false);
  if (!settings) return null;
  const limits = neoTodoLimits(neo);

  const save = async (field: Field, input: HTMLInputElement) => {
    const value = Number(input.value);
    if (!Number.isInteger(value) || value < 1) {
      toast.error('Enter a whole number of at least 1');
      input.value = String(limits[ROWS.find((row) => row.field === field)!.key]);
      return;
    }
    if (value === neo?.[field]) return;
    setSaving(true);
    try {
      await updateGlobalSettings({ neo: { ...neo, [field]: value } });
    } catch {
      toast.error('Failed to update running limits');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title="Running limits"
      description="Steps past a limit wait in the queue and start when a running one finishes or waits on you."
    >
      <SettingsGroup>
        {ROWS.map((row) => (
          <SettingsRow key={row.field} label={row.label} description={row.description}>
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              aria-label={row.label}
              class="w-20 rounded-md border border-line bg-surface px-2.5 py-1 text-right text-[13px] text-fg-soft focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              value={String(limits[row.key])}
              disabled={saving}
              onChange={({ currentTarget }) => void save(row.field, currentTarget)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
