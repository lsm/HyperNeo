import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentReminderRepository } from '../../../../src/storage/repositories/space-agent-reminder-repository';
import { SpaceAgentSubscriptionRepository } from '../../../../src/storage/repositories/space-agent-subscription-repository';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { createAgentTemplateOperations } from '../../../../src/lib/agents/agent-template-operations';
import { SpaceAgentTemplateManager } from '../../../../src/lib/agents/template-manager';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationCallerRole,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';

let db: Database;
let agentRepo: SpaceLongHorizonAgentRepository;
let templateRepo: SpaceAgentTemplateRepository;
let reminderRepo: SpaceAgentReminderRepository;
let spaceId: string;
let otherSpaceId: string;
let spaceAutonomyLevel: number;
let sessions: Map<string, Session>;
let audited: Array<{ toolName: string; paramsSummary: Record<string, unknown> }>;
let published: string[];

const MEMBER_SESSION = 'space:chat:member';

function memberCaller(role: OperationCallerRole = 'ad_hoc_member'): OperationCaller {
  return { source: 'mcp', sessionId: MEMBER_SESSION, spaceId, role };
}

function sessionRow(overrides: Partial<Session> & { id: string }): Session {
  return {
    title: 'Space chat',
    workspacePath: '/repo',
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    type: 'space_chat',
    config: { model: 'm', provider: 'p', maxTokens: 1, temperature: 1 },
    metadata: {},
    context: { spaceId },
    ...overrides,
  } as unknown as Session;
}

function registry() {
  return createOperationRegistry(
    createAgentTemplateOperations({
      getDatabase: () => db,
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      longHorizonAgentRepo: agentRepo,
      templateManager: new SpaceAgentTemplateManager(templateRepo),
      subscriptionRepo: new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db)),
      reminderRepo,
      refreshSubscription: () => ({ success: true }),
      getSpaceAutonomyLevel: async () => spaceAutonomyLevel,
      publishAgentCreated: (agent) => published.push(agent.id),
      audit: (toolName, paramsSummary) => audited.push({ toolName, paramsSummary }),
    })
  );
}

async function run(
  name: string,
  input: Record<string, unknown>,
  caller: OperationCaller = memberCaller()
) {
  const outcome = await invokeOperation(registry(), name, input, caller);
  return outcome as {
    kind: string;
    code?: string;
    value?: {
      rejected?: boolean;
      reason?: string;
      message?: string;
      template?: Record<string, unknown>;
      templates?: Array<Record<string, unknown>>;
      deleted?: string;
      agent?: Record<string, unknown>;
      seededReminders?: Array<{ title: string }>;
      skippedReminders?: Array<{ title: string; reason: string }>;
    };
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  templateRepo = new SpaceAgentTemplateRepository(db);
  reminderRepo = new SpaceAgentReminderRepository(db, new SpaceAgentRepository(db));
  const spaceRepo = new SpaceRepository(db);
  spaceId = spaceRepo.createSpace({ name: 'Home', slug: 'home', workspacePath: '/repo' }).id;
  otherSpaceId = spaceRepo.createSpace({ name: 'Away', slug: 'away', workspacePath: '/other' }).id;
  spaceAutonomyLevel = 5;
  sessions = new Map([[MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION })]]);
  audited = [];
  published = [];
});

describe('the agentTemplate.create operation', () => {
  test('creates a user-authored template and returns the stored record with its version', async () => {
    const outcome = await run('agentTemplate.create', {
      key: 'custom.reviewer',
      handle: 'custom-reviewer',
      displayName: 'Custom Reviewer',
      description: 'Reviews code',
      instructions: 'Review every change carefully.',
      labels: ['review'],
      suggestedAutonomyLevel: 3,
    });
    expect(outcome.value?.rejected).toBeUndefined();
    expect(outcome.value?.template).toMatchObject({
      key: 'custom.reviewer',
      handle: 'custom-reviewer',
      displayName: 'Custom Reviewer',
      suggestedAutonomyLevel: 3,
      labels: ['review'],
      version: 1,
    });
    expect(templateRepo.getOwned(spaceId, 'custom.reviewer')?.displayName).toBe('Custom Reviewer');
  });

  test('a duplicate key is rejected with template_rejected and nothing is overwritten', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    const outcome = await run('agentTemplate.create', {
      key: 'custom.reviewer',
      handle: 'another-reviewer',
      displayName: 'Impostor',
    });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(templateRepo.getOwned(spaceId, 'custom.reviewer')?.handle).toBe('custom-reviewer');
  });

  test('the audit entry names the underlying template tool', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    expect(audited).toEqual([
      {
        toolName: 'create_agent_template',
        paramsSummary: { key: 'custom.reviewer', from_agent_id: undefined },
      },
    ]);
  });
});

describe('the agentTemplate.update operation', () => {
  test('updates an owned template and bumps its version', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    const outcome = await run('agentTemplate.update', {
      key: 'custom.reviewer',
      expectedVersion: 1,
      displayName: 'Renamed Reviewer',
    });
    expect(outcome.value?.template).toMatchObject({
      key: 'custom.reviewer',
      displayName: 'Renamed Reviewer',
      version: 2,
    });
  });

  test('a stale expectedVersion is rejected and the template is unchanged', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    await run('agentTemplate.update', { key: 'custom.reviewer', displayName: 'Renamed' });
    const outcome = await run('agentTemplate.update', {
      key: 'custom.reviewer',
      expectedVersion: 1,
      displayName: 'Should Not Apply',
    });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('modified concurrently');
    expect(templateRepo.getOwnedWithVersion(spaceId, 'custom.reviewer')?.displayName).toBe(
      'Renamed'
    );
  });

  test('a built-in template key is rejected', async () => {
    const outcome = await run('agentTemplate.update', {
      key: 'worker.swe',
      displayName: 'Nope',
    });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('built-in');
  });
});

describe('the agentTemplate.delete operation', () => {
  test('deletes an owned template by key', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    const outcome = await run('agentTemplate.delete', { key: 'custom.reviewer' });
    expect(outcome.value?.deleted).toBe('custom.reviewer');
    expect(templateRepo.getOwned(spaceId, 'custom.reviewer')).toBeNull();
  });

  test('a built-in template key is rejected', async () => {
    const outcome = await run('agentTemplate.delete', { key: 'worker.swe' });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('cannot be deleted');
  });

  test('a space below autonomy level 4 is refused and the template survives', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    spaceAutonomyLevel = 3;
    const outcome = await run('agentTemplate.delete', { key: 'custom.reviewer' });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('not permitted');
    expect(templateRepo.getOwned(spaceId, 'custom.reviewer')?.key).toBe('custom.reviewer');
  });
});

describe('the agentTemplate.list operation', () => {
  test('lists built-in templates flagged builtin with a null owned version', async () => {
    const outcome = await run('agentTemplate.list', {});
    const entries = outcome.value?.templates ?? [];
    const swe = entries.find((entry) => entry.templateName === 'worker.swe');
    expect(swe).toMatchObject({ builtin: true, version: null });
    expect(entries.find((entry) => entry.builtin)).toBeTruthy();
  });

  test('a user-created template appears with its version', async () => {
    await run('agentTemplate.create', { key: 'custom.reviewer', handle: 'custom-reviewer' });
    const outcome = await run('agentTemplate.list', {});
    const owned = (outcome.value?.templates ?? []).find(
      (entry) => entry.templateName === 'custom.reviewer'
    );
    expect(owned).toMatchObject({ builtin: false, version: 1, handle: 'custom-reviewer' });
  });

  test('a human caller naming the Space reads the list', async () => {
    const outcome = await run('agentTemplate.list', { spaceId }, { source: 'rpc' });
    expect(outcome.value?.templates?.length).toBeGreaterThan(0);
  });

  test('a human caller omitting the Space is rejected with space_required', async () => {
    const outcome = await run('agentTemplate.list', {}, { source: 'rpc' });
    expect(outcome.value?.reason).toBe('space_required');
  });

  test('a member naming a different Space is rejected with space_mismatch', async () => {
    const outcome = await run('agentTemplate.list', { spaceId: otherSpaceId });
    expect(outcome.value?.reason).toBe('space_mismatch');
  });

  test('a workflow worker is refused at the door', async () => {
    const outcome = await run('agentTemplate.list', {}, memberCaller('workflow_worker'));
    expect(outcome.kind).toBe('failed');
    expect(outcome.code).toBe('forbidden');
  });
});

describe('the agent.createFromTemplate operation', () => {
  test('creates a long-horizon agent from a built-in worker template', async () => {
    const outcome = await run('agent.createFromTemplate', { templateName: 'worker.swe' });
    expect(outcome.value?.agent).toMatchObject({
      templateKey: 'worker.swe',
      status: 'active',
    });
    const created = outcome.value?.agent;
    expect(agentRepo.getById(String(created?.id))?.spaceId).toBe(spaceId);
    expect(published).toEqual([String(created?.id)]);
    expect(outcome.value?.seededReminders).toEqual([]);
    expect(outcome.value?.skippedReminders).toEqual([]);
  });

  test('a repeated creation derives a unique display name and handle', async () => {
    await run('agent.createFromTemplate', { templateName: 'worker.swe' });
    const second = await run('agent.createFromTemplate', { templateName: 'worker.swe' });
    expect(second.value?.agent).toMatchObject({ displayName: 'SWE (2)', handle: 'swe-2' });
  });

  test('an explicit name that is already taken is rejected', async () => {
    await run('agent.createFromTemplate', { templateName: 'worker.swe', name: 'Duplicate' });
    const outcome = await run('agent.createFromTemplate', {
      templateName: 'worker.research',
      name: 'Duplicate',
    });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('already used');
  });

  test('template reminder defaults are seeded for the new agent', async () => {
    const outcome = await run('agent.createFromTemplate', { templateName: 'task-manager.default' });
    const agentId = String(outcome.value?.agent?.id);
    expect(outcome.value?.seededReminders).toEqual([{ title: 'Review stalled work' }]);
    expect(outcome.value?.skippedReminders).toEqual([]);
    const reminders = reminderRepo.listReminders(agentId);
    expect(reminders.map((reminder) => reminder.title)).toEqual(['Review stalled work']);
    expect(reminders[0]?.createdBySession).toBe(MEMBER_SESSION);
  });

  test('an unknown template key is rejected with template_rejected', async () => {
    const outcome = await run('agent.createFromTemplate', { templateName: 'worker.nope' });
    expect(outcome.value?.reason).toBe('template_rejected');
    expect(outcome.value?.message).toContain('not found');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
  });

  test('the creating session must be active in the Space', async () => {
    sessions.set(MEMBER_SESSION, sessionRow({ id: MEMBER_SESSION, status: 'archived' }));
    const outcome = await run('agent.createFromTemplate', { templateName: 'worker.swe' });
    expect(outcome.value?.reason).toBe('agent_denied');
    expect(agentRepo.listBySpaceId(spaceId)).toHaveLength(0);
  });
});
