import { describe, expect, test } from 'bun:test';
import { DEFAULT_SEED_AGENT_TEMPLATE_KEY } from '@hyperneo/shared';
import { RESERVED_SPACE_AGENT_HANDLES } from '../../../../src/lib/space/slug';
import {
  getLongHorizonAgentTemplates,
  isLegacyWorkerTemplateKey,
  normalizeLegacyWorkerTemplateKey,
  WORKER_TEMPLATE_KEY_PREFIX,
} from '../../../../src/lib/agents/long-horizon-templates';

function getLongHorizonFamilyTemplates() {
  return getLongHorizonAgentTemplates().filter(
    (template) => !template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
  );
}

describe('long-horizon agent templates', () => {
  test('the space-creation default seed template exists and its handle is not reserved', () => {
    expect(DEFAULT_SEED_AGENT_TEMPLATE_KEY).toBe('space-manager.default');
    const template = getLongHorizonAgentTemplates().find(
      (candidate) => candidate.key === DEFAULT_SEED_AGENT_TEMPLATE_KEY
    );

    expect(template).toBeDefined();
    expect(template?.handle).toBe('space-manager');
    expect(RESERVED_SPACE_AGENT_HANDLES as readonly string[]).not.toContain(template?.handle);
  });

  test('offers Space Manager without the retired Task Manager built-in', () => {
    const templates = getLongHorizonFamilyTemplates();

    expect(templates.map((template) => template.key)).toEqual(['space-manager.default']);
    expect(templates.map((template) => template.displayName)).toEqual(['Space Manager']);
  });

  test('registers the worker presets as code built-ins under the worker namespace', () => {
    const workerTemplates = getLongHorizonAgentTemplates().filter((template) =>
      template.key.startsWith(WORKER_TEMPLATE_KEY_PREFIX)
    );

    expect(workerTemplates.map((template) => template.key)).toEqual([
      'worker.swe',
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

  test('Space Manager coordinates work with goal ownership and human gates', () => {
    const spaceManager = getLongHorizonAgentTemplates().find(
      (template) => template.key === 'space-manager.default'
    );

    expect(spaceManager?.suggestedAutonomyLevel).toBe(3);
    expect(spaceManager?.suggestedEventSubscriptions).toEqual([]);
    expect(spaceManager?.instructions).toContain('goal.owner.set');
    expect(spaceManager?.instructions).toContain('goal.task.trigger');
    expect(spaceManager?.instructions).toContain('task.create');
    expect(spaceManager?.instructions).toContain('task.message.send');
    expect(spaceManager?.instructions).toContain('manual handoff');
    expect(spaceManager?.instructions).toContain('human review');
  });

  test('defines instructions, autonomy, subscriptions, reminders, and ownership patterns', () => {
    for (const template of getLongHorizonFamilyTemplates()) {
      expect(template.handle).toMatch(/^[a-z0-9-]+$/);
      expect(template.description.length).toBeGreaterThan(20);
      expect(template.instructions.length).toBeGreaterThan(80);
      expect(template.suggestedAutonomyLevel).toBeGreaterThanOrEqual(1);
      expect(template.suggestedAutonomyLevel).toBeLessThanOrEqual(5);
      expect(template.suggestedEventSubscriptions).toEqual([]);
      expect(template.reminderDefaults.length).toBeGreaterThan(0);
      expect(template.ownershipPatterns.length).toBeGreaterThan(0);
    }
  });

  test('returns cloned template data', () => {
    const [template] = getLongHorizonAgentTemplates();
    template.reminderDefaults[0].title = 'Mutated';
    template.ownershipPatterns[0].description = 'Mutated';
    template.toolPermissions.mutated = true;

    const [again] = getLongHorizonAgentTemplates();

    expect(again.reminderDefaults[0].title).not.toBe('Mutated');
    expect(again.ownershipPatterns[0].description).not.toBe('Mutated');
    expect(again.toolPermissions).not.toHaveProperty('mutated');
  });
});

describe('legacy worker template key helpers', () => {
  test('maps the removed key to its successor', () => {
    expect(normalizeLegacyWorkerTemplateKey('worker.coder')).toBe('worker.swe');
    expect(isLegacyWorkerTemplateKey('worker.coder')).toBe(true);
  });

  test('passes unknown keys through', () => {
    expect(normalizeLegacyWorkerTemplateKey('worker.qa')).toBe('worker.qa');
    expect(isLegacyWorkerTemplateKey('worker.qa')).toBe(false);
  });

  test('does not match inherited prototype properties', () => {
    expect(normalizeLegacyWorkerTemplateKey('toString')).toBe('toString');
    expect(isLegacyWorkerTemplateKey('constructor')).toBe(false);
    expect(isLegacyWorkerTemplateKey('hasOwnProperty')).toBe(false);
  });
});
