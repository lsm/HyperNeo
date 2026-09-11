import { describe, expect, test } from 'bun:test';
import type { SpaceAgent, SpaceAgentTemplate } from '@hyperneo/shared';
import {
  buildTemplateExtrasSeeder,
  isSeedableSubscription,
  type TemplateExtrasStore,
} from '../../../../src/lib/space/agents/template-extras-seeding';

const agent = { id: 'agent-1', spaceId: 'space-1' } as SpaceAgent;

function template(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
  return {
    key: 'k',
    handle: 'h',
    displayName: 'H',
    description: '',
    instructions: '',
    suggestedAutonomyLevel: 2,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as SpaceAgentTemplate;
}

function makeStore() {
  const subscriptions: unknown[] = [];
  const reminders: unknown[] = [];
  const deleted: string[] = [];
  let next = 0;
  const store: TemplateExtrasStore = {
    upsertSubscription: (params) => {
      subscriptions.push(params);
      next += 1;
      return { id: `sub-${next}` };
    },
    deleteSubscription: (id) => {
      deleted.push(id);
    },
    createReminder: (params) => {
      reminders.push(params);
      return params;
    },
  };
  return { store, subscriptions, reminders, deleted };
}

describe('template extras seeding', () => {
  test('seeds nothing for a template with no extras', () => {
    const { store, subscriptions, reminders } = makeStore();
    buildTemplateExtrasSeeder({ store })(agent, template());
    expect(subscriptions).toEqual([]);
    expect(reminders).toEqual([]);
  });

  test('seeds a valid subscription against the new agent', () => {
    const { store, subscriptions } = makeStore();
    buildTemplateExtrasSeeder({ store })(
      agent,
      template({
        suggestedEventSubscriptions: [{ source: 'github', topic: 'pull_request', filter: {} }],
      })
    );
    expect(subscriptions).toEqual([
      {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'pull_request',
        filter: {},
        status: 'active',
      },
    ]);
  });

  test('skips a subscription whose topic resource is unsupported', () => {
    const { store, subscriptions } = makeStore();
    buildTemplateExtrasSeeder({ store })(
      agent,
      template({
        suggestedEventSubscriptions: [{ source: 'github', topic: 'push', filter: {} }],
      })
    );
    expect(subscriptions).toEqual([]);
    expect(isSeedableSubscription('github', 'push')).toBe(false);
  });

  test('skips a subscription whose source is invalid', () => {
    const { store, subscriptions } = makeStore();
    buildTemplateExtrasSeeder({ store })(
      agent,
      template({
        suggestedEventSubscriptions: [
          { source: 'not a source!!', topic: 'x', filter: {} },
          { source: 'github', topic: 'pull_request', filter: {} },
        ],
      })
    );
    expect(subscriptions).toHaveLength(1);
    expect(isSeedableSubscription('not a source!!', 'x')).toBe(false);
  });

  test('rolls back a subscription whose runtime refresh fails', () => {
    const { store, deleted } = makeStore();
    buildTemplateExtrasSeeder({
      store,
      refreshSubscription: () => ({ success: false }),
    })(
      agent,
      template({
        suggestedEventSubscriptions: [{ source: 'github', topic: 'pull_request', filter: {} }],
      })
    );
    expect(deleted).toEqual(['sub-1']);
  });

  test('keeps a subscription whose refresh succeeds', () => {
    const { store, deleted } = makeStore();
    buildTemplateExtrasSeeder({
      store,
      refreshSubscription: () => ({ success: true }),
    })(
      agent,
      template({
        suggestedEventSubscriptions: [{ source: 'github', topic: 'pull_request', filter: {} }],
      })
    );
    expect(deleted).toEqual([]);
  });

  test('computes nextRunAt for a cron reminder', () => {
    const { store, reminders } = makeStore();
    buildTemplateExtrasSeeder({ store })(
      agent,
      template({
        reminderDefaults: [
          {
            title: 'Daily sweep',
            body: 'Check the queue',
            triggerType: 'cron',
            cronExpression: '0 9 * * *',
            timezone: 'UTC',
          },
        ],
      })
    );
    expect(reminders).toHaveLength(1);
    const reminder = reminders[0] as { nextRunAt: number | null; timezone: string };
    expect(reminder.timezone).toBe('UTC');
    expect(typeof reminder.nextRunAt).toBe('number');
  });

  test('leaves nextRunAt null for a non-cron reminder', () => {
    const { store, reminders } = makeStore();
    buildTemplateExtrasSeeder({ store })(
      agent,
      template({
        reminderDefaults: [
          {
            title: 'One off',
            body: '',
            triggerType: 'at',
            cronExpression: null,
            timezone: 'UTC',
          },
        ],
      })
    );
    expect((reminders[0] as { nextRunAt: number | null }).nextRunAt).toBeNull();
  });
});
