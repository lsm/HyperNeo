import { describe, expect, test } from 'bun:test';
import {
  getLongHorizonAgentTemplates,
  WORKER_TEMPLATE_KEY_PREFIX,
} from '../../../../src/lib/space/agents/long-horizon-agent-templates';

function getLongHorizonFamilyTemplates() {
  return getLongHorizonAgentTemplates().filter(
    (template) => !template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
  );
}

describe('long-horizon agent templates', () => {
  test('keeps only the coordinator and task-manager as non-worker built-ins (ATC-3, ATC-4)', () => {
    const templates = getLongHorizonFamilyTemplates();

    expect(templates.map((template) => template.key)).toEqual([
      'coordinator.default',
      'task-manager.default',
    ]);
    expect(templates.map((template) => template.displayName)).toEqual([
      'Coordinator',
      'Task Manager',
    ]);
  });

  test('registers the worker presets as code built-ins under the worker namespace', () => {
    const workerTemplates = getLongHorizonAgentTemplates().filter((template) =>
      template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
    );

    expect(workerTemplates.map((template) => template.key)).toEqual([
      'worker.coder',
      'worker.research',
      'worker.reviewer',
      'worker.qa',
    ]);
    for (const template of workerTemplates) {
      expect(template.instructions.length).toBeGreaterThan(0);
      expect(template.suggestedAutonomyLevel).toBe(1);
      expect(template.suggestedEventSubscriptions).toEqual([]);
      expect(template.reminderDefaults).toEqual([]);
      expect(template.ownershipPatterns).toEqual([]);
    }
    const reviewer = workerTemplates.find((template) => template.key === 'worker.reviewer')!;
    expect(Array.isArray(reviewer.toolPermissions.tools)).toBe(true);
    expect(reviewer.toolPermissions.tools).toContain('Read');
  });

  test('stamps labels on every built-in template (ATC-2)', () => {
    for (const template of getLongHorizonAgentTemplates()) {
      if (template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)) {
        expect(template.labels, template.key).toEqual(['workflow-worker']);
      } else {
        expect(template.labels, template.key).toEqual(['long-horizon']);
      }
    }
  });

  test('task-manager tracks work without routing powers or subscriptions (ATC-4)', () => {
    const taskManager = getLongHorizonAgentTemplates().find(
      (template) => template.key === 'task-manager.default'
    );

    expect(taskManager?.suggestedAutonomyLevel).toBe(2);
    expect(taskManager?.suggestedEventSubscriptions).toEqual([]);
    expect(taskManager?.instructions).toContain('Triage');
    expect(taskManager?.instructions).toContain('send_message_to_task');
    expect(taskManager?.instructions).toContain('mark it `blocked`');
    expect(taskManager?.instructions).toContain('not awaiting review');
    expect(taskManager?.instructions).toContain('statuses like `stopped` cannot take it at all');
    expect(taskManager?.instructions).toContain(
      'rate- or usage-paused tasks gate it above level 2'
    );
    expect(taskManager?.instructions).toContain('Tasks waiting in review are not yours to move');
    expect(taskManager?.instructions).toContain('next slices');
    expect(taskManager?.instructions).toContain('no routing powers');
    expect(taskManager?.instructions).not.toContain('reassign_task');
    expect(taskManager?.instructions).not.toContain('send_session_message');
    expect(taskManager?.instructions).not.toContain('escalate to the space manager');
  });

  test('defines instructions, autonomy, subscriptions, reminders, and ownership patterns', () => {
    for (const template of getLongHorizonFamilyTemplates()) {
      expect(template.handle).toMatch(/^[a-z0-9-]+$/);
      expect(template.description.length).toBeGreaterThan(20);
      expect(template.instructions.length).toBeGreaterThan(80);
      expect(template.suggestedAutonomyLevel).toBeGreaterThanOrEqual(1);
      expect(template.suggestedAutonomyLevel).toBeLessThanOrEqual(5);
      if (template.key !== 'task-manager.default') {
        expect(template.suggestedEventSubscriptions.length).toBeGreaterThan(0);
      }
      expect(template.reminderDefaults.length).toBeGreaterThan(0);
      expect(template.ownershipPatterns.length).toBeGreaterThan(0);
    }
  });

  test('coordinator teaches the fallback-reviewer duty (MC5-B2)', () => {
    const coordinator = getLongHorizonAgentTemplates().find(
      (template) => template.key === 'coordinator.default'
    );
    expect(coordinator?.instructions).toContain('fallback reviewer');
    expect(coordinator?.instructions).toContain('review_goal_outcome');
  });

  test('returns cloned template data', () => {
    const [template] = getLongHorizonAgentTemplates();
    const statuses = template.suggestedEventSubscriptions[0].filter.statuses as string[];
    statuses.push('mutated');
    template.suggestedEventSubscriptions[0].filter.mutated = true;
    template.reminderDefaults[0].title = 'Mutated';
    template.ownershipPatterns[0].description = 'Mutated';
    template.toolPermissions.mutated = true;

    const [again] = getLongHorizonAgentTemplates();

    expect(again.suggestedEventSubscriptions[0].filter).not.toHaveProperty('mutated');
    expect(again.suggestedEventSubscriptions[0].filter.statuses).toEqual([
      'blocked',
      'review',
      'done',
    ]);
    expect(again.reminderDefaults[0].title).not.toBe('Mutated');
    expect(again.ownershipPatterns[0].description).not.toBe('Mutated');
    expect(again.toolPermissions).not.toHaveProperty('mutated');
  });
});
