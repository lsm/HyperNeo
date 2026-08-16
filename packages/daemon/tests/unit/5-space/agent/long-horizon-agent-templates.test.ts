import { describe, expect, test } from 'bun:test';
import { getLongHorizonAgentTemplates } from '../../../../src/lib/space/agents/long-horizon-agent-templates';

describe('long-horizon agent templates', () => {
  test('exports built-in templates for common evergreen roles', () => {
    const templates = getLongHorizonAgentTemplates();

    expect(templates.map((template) => template.key)).toEqual([
      'coordinator.default',
      'product-quality-manager.default',
      'release-manager.default',
      'security-auditor.default',
      'marketing.default',
      'sales.default',
      'research.default',
      'family-ops-chores.default',
    ]);
    expect(templates.map((template) => template.displayName)).toEqual([
      'Coordinator',
      'Product Quality Manager',
      'Release Manager',
      'Security Auditor',
      'Marketing',
      'Sales',
      'Research',
      'Family Ops/Chores',
    ]);
  });

  test('defines instructions, autonomy, subscriptions, reminders, and ownership patterns', () => {
    for (const template of getLongHorizonAgentTemplates()) {
      expect(template.handle).toMatch(/^[a-z0-9-]+$/);
      expect(template.description.length).toBeGreaterThan(20);
      expect(template.instructions.length).toBeGreaterThan(80);
      expect(template.suggestedAutonomyLevel).toBeGreaterThanOrEqual(1);
      expect(template.suggestedAutonomyLevel).toBeLessThanOrEqual(5);
      expect(template.suggestedEventSubscriptions.length).toBeGreaterThan(0);
      expect(template.reminderDefaults.length).toBeGreaterThan(0);
      expect(template.ownershipPatterns.length).toBeGreaterThan(0);
    }
  });

  test('marks human-confirmation roles with low autonomy', () => {
    const templates = getLongHorizonAgentTemplates();
    const securityAuditor = templates.find(
      (template) => template.key === 'security-auditor.default'
    );
    const familyOps = templates.find((template) => template.key === 'family-ops-chores.default');

    expect(securityAuditor?.suggestedAutonomyLevel).toBe(1);
    expect(familyOps?.suggestedAutonomyLevel).toBe(1);
    expect(securityAuditor?.instructions).toContain('escalate high-risk issues');
    expect(familyOps?.instructions).toContain(
      'avoid making commitments without human confirmation'
    );
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
