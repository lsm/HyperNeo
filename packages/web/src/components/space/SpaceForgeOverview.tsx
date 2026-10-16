import type { SpaceGoal, EvolutionScope } from '@hyperneo/shared';
import { formatGoalMetricSnapshot } from './goal-display-utils';
import type { WorkflowModelSelection } from './visual-editor/WorkflowModelSelect';
import { getRelativeTime, cn } from '../../lib/utils';
import { formatDefinitionCount } from './space-forge-values.ts';
import { SectionCard } from '../ui/SectionCard';
import { WorkflowModelSelect } from './visual-editor/WorkflowModelSelect';
import { FORM_CHECKBOX_CLASS, formControlClass } from '../ui/FormField';

function GoalSummary({ goal }: { goal: SpaceGoal }) {
  return (
    <div class="rounded-lg border border-accent/20 bg-accent/5 p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <p class="text-[11px] font-semibold uppercase tracking-wide text-accent-soft">
            Linked recurring goal
          </p>
          <h3 class="mt-1 text-sm font-medium text-fg">{goal.title}</h3>
        </div>
        <span class="rounded-full bg-accent/10 px-2 py-1 text-xs text-accent-soft">Metrics</span>
      </div>
      <p class="mb-3 text-xs text-accent-soft/80">
        Metric trajectory: {formatGoalMetricSnapshot(goal)}
      </p>
      {goal.summary && <p class="text-sm text-fg-soft">{goal.summary}</p>}
      {goal.nextSteps.length > 0 && (
        <ul class="mt-3 space-y-1 text-xs text-fg-muted">
          {goal.nextSteps.map((step) => (
            <li key={step}>Next: {step}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function OverviewTab({
  scope,
  goal,
  savingJudgeModel,
  settingsError,
  handleJudgeModelChange,
  completedTaskAutomationEnabled,
  savingCompletedTaskAutomation,
  handleCompletedTaskAutomationChange,
  completedTaskThreshold,
}: {
  scope: EvolutionScope;
  goal: SpaceGoal | null;
  savingJudgeModel: boolean;
  settingsError: string | null;
  handleJudgeModelChange: (
    value: string | undefined,
    selection?: WorkflowModelSelection
  ) => Promise<void>;
  completedTaskAutomationEnabled: boolean;
  savingCompletedTaskAutomation: boolean;
  handleCompletedTaskAutomationChange: (updates: { enabled?: boolean; threshold?: number }) => void;
  completedTaskThreshold: number;
}) {
  return (
    <div class="space-y-4">
      {scope.objective && <p class="px-1 text-sm leading-5 text-fg-muted">{scope.objective}</p>}
      {goal ? (
        <GoalSummary goal={goal} />
      ) : (
        <div class="rounded-lg border border-line bg-fill-soft p-4 text-sm text-fg-muted">
          No recurring goal linked.
        </div>
      )}
      <div class="grid gap-3 md:grid-cols-2">
        <div class="rounded-lg border border-line bg-fill-soft p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Created</p>
          <p class="mt-1 text-sm text-fg-soft">{getRelativeTime(scope.createdAt)}</p>
        </div>
        <div class="rounded-lg border border-line bg-fill-soft p-4">
          <p class="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">Metrics</p>
          <p class="mt-1 text-sm text-fg-soft">
            {formatDefinitionCount(scope.metricDefinitions.length)}
          </p>
        </div>
      </div>
      <SectionCard title="Episode judge model">
        <p class="text-xs text-fg-muted">
          Override model for episode judging, or clear to use Space default.
        </p>
        <WorkflowModelSelect
          value={
            typeof scope.policy.episodeJudgeModel === 'string'
              ? scope.policy.episodeJudgeModel
              : undefined
          }
          provider={
            typeof scope.policy.episodeJudgeProvider === 'string'
              ? scope.policy.episodeJudgeProvider
              : undefined
          }
          onChange={handleJudgeModelChange}
          testId="scope-episode-judge-model-select"
          className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
        />
        {savingJudgeModel && <p class="text-xs text-fg-muted">Saving…</p>}
        {settingsError && <p class="text-xs text-danger">{settingsError}</p>}
      </SectionCard>
      {goal && (
        <SectionCard title="Completed-task automation">
          <p class="text-xs text-fg-muted">
            Draft an Evolution episode after a configured number of completed scoped tasks.
          </p>
          <label class="flex items-center gap-2 text-sm text-fg-soft">
            <input
              type="checkbox"
              checked={completedTaskAutomationEnabled}
              disabled={savingCompletedTaskAutomation}
              onChange={(event) =>
                handleCompletedTaskAutomationChange({
                  enabled: (event.currentTarget as HTMLInputElement).checked,
                })
              }
              class={FORM_CHECKBOX_CLASS}
            />
            Enable count-based episode drafts
          </label>
          <label class="mt-3 block text-xs font-medium uppercase tracking-wide text-fg-muted">
            Completed task threshold
            <input
              type="number"
              min="1"
              step="1"
              value={completedTaskThreshold}
              disabled={!completedTaskAutomationEnabled || savingCompletedTaskAutomation}
              onChange={(event) =>
                handleCompletedTaskAutomationChange({
                  threshold: Number((event.currentTarget as HTMLInputElement).value),
                })
              }
              data-testid="scope-completed-task-threshold-input"
              class={cn(formControlClass().replace('w-full', 'w-32'), 'mt-1')}
            />
          </label>
          {savingCompletedTaskAutomation && <p class="text-xs text-fg-muted">Saving…</p>}
        </SectionCard>
      )}
    </div>
  );
}
