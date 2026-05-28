import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseAddress } from '../../../../messaging/src/address';
import {
  canonicalAgentHandle,
  SpaceActorRegistryAdapter,
} from '../../../src/lib/space/actor-registry';
import { longTermAgentSessionId } from '../../../src/lib/space/long-term-agent-session';
import { NodeExecutionRepository } from '../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../src/storage/repositories/pending-agent-message-repository';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository';
import type { Session } from '@neokai/shared';
import { createSpaceTables } from '../helpers/space-test-db';

function alignTestSchema(db: Database): void {
  db.exec('ALTER TABLE space_agents ADD COLUMN custom_prompt TEXT DEFAULT NULL');
  db.exec('DROP TABLE sessions');
  db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			workspace_path TEXT,
			created_at TEXT NOT NULL,
			last_active_at TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'ended', 'archived', 'pending_worktree_choice')),
			config TEXT NOT NULL,
			metadata TEXT NOT NULL,
			is_worktree INTEGER DEFAULT 0,
			worktree_path TEXT,
			main_repo_path TEXT,
			worktree_branch TEXT,
			git_branch TEXT,
			sdk_session_id TEXT,
			sdk_origin_path TEXT,
			available_commands TEXT,
			processing_state TEXT,
			archived_at TEXT,
			type TEXT DEFAULT 'worker',
			session_context TEXT
		)
	`);
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    workspacePath: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    config: {},
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    type: 'worker',
    context: undefined,
    ...overrides,
  };
}

describe('SpaceActorRegistryAdapter', () => {
  let db: Database;
  let spaceRepo: SpaceRepository;
  let sessionRepo: SessionRepository;
  let spaceAgentRepo: SpaceAgentRepository;
  let workflowRepo: SpaceWorkflowRepository;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let pendingMessageRepo: PendingAgentMessageRepository;
  let registry: SpaceActorRegistryAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    alignTestSchema(db);
    spaceRepo = new SpaceRepository(db);
    sessionRepo = new SessionRepository(db);
    spaceAgentRepo = new SpaceAgentRepository(db);
    workflowRepo = new SpaceWorkflowRepository(db);
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    pendingMessageRepo = new PendingAgentMessageRepository(db);
    registry = new SpaceActorRegistryAdapter({
      spaceRepo,
      sessionRepo,
      spaceAgentRepo,
      workflowRepo,
      workflowRunRepo,
      nodeExecutionRepo,
      pendingMessageRepo,
    });
  });

  afterEach(() => {
    db.close();
  });

  it('seeds humans, coordinator, ad-hoc sessions, agents, workers, pending workers, and systems', () => {
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/project',
      slug: 'project',
      name: 'Project',
    });
    const member = makeSession('member-1', { context: { spaceId: space.id } });
    const legacyMember = makeSession('legacy-member');
    const coordinator = makeSession(`space:chat:${space.id}`, {
      type: 'space_chat',
      context: { spaceId: space.id },
    });
    const taskAgent = makeSession('task-agent-1', {
      type: 'space_task_agent',
      context: { spaceId: space.id },
    });
    const workerSubSession = makeSession('space:task:t1:exec:e1', {
      context: { spaceId: space.id },
    });
    const namedAgentSubSession = makeSession('named-agent-session', {
      context: { spaceId: space.id },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
        promptProvenance: { workflowRunId: 'run-from-prompt' },
      },
    });
    sessionRepo.createSession(member);
    sessionRepo.createSession(legacyMember);
    sessionRepo.createSession(coordinator);
    sessionRepo.createSession(taskAgent);
    sessionRepo.createSession(workerSubSession);
    sessionRepo.createSession(namedAgentSubSession);
    spaceRepo.addSessionToSpace(space.id, member.id);
    spaceRepo.addSessionToSpace(space.id, legacyMember.id);
    spaceRepo.addSessionToSpace(space.id, coordinator.id);
    spaceRepo.addSessionToSpace(space.id, taskAgent.id);
    spaceRepo.addSessionToSpace(space.id, workerSubSession.id);
    spaceRepo.addSessionToSpace(space.id, namedAgentSubSession.id);

    const agent = spaceAgentRepo.create({
      spaceId: space.id,
      name: 'Long Term Agent',
    });
    sessionRepo.createSession(
      makeSession(longTermAgentSessionId(space.id, agent.id), {
        context: { spaceId: space.id },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: agent.id,
            agentName: agent.name,
          },
        },
      })
    );
    const reservedNameAgent = spaceAgentRepo.create({
      spaceId: space.id,
      name: 'Coordinator',
    });
    sessionRepo.createSession(
      makeSession(longTermAgentSessionId(space.id, reservedNameAgent.id), {
        context: { spaceId: space.id },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
          promptProvenance: {
            source: 'test',
            hash: 'hash',
            agentId: reservedNameAgent.id,
            agentName: reservedNameAgent.name,
          },
        },
      })
    );
    const workflow = workflowRepo.createWorkflow({
      spaceId: space.id,
      name: 'Coding Workflow',
      nodes: [
        {
          id: 'Coding',
          name: 'Coding',
          agents: [{ agentId: agent.id, name: 'coder' }],
        },
        {
          id: 'Review/QA',
          name: 'Review/QA',
          agents: [{ agentId: agent.id, name: 'reviewer:lead' }],
        },
        {
          id: 'coordinator',
          name: 'Coordinator Worker',
          agents: [{ agentId: agent.id, name: 'messaging' }],
        },
        {
          id: 'OtherReview',
          name: 'Other Review',
          agents: [{ agentId: agent.id, name: 'reviewer:lead' }],
        },
      ],
      transitions: [],
      startNodeId: 'Coding',
      rules: [],
      completionAutonomyLevel: 3,
    });
    const run = workflowRunRepo.createRun({
      spaceId: space.id,
      workflowId: workflow.id,
      title: 'Run',
    });
    nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: 'Coding:Node',
      agentName: 'coder/lead',
      agentId: agent.id,
      agentSessionId: workerSubSession.id,
      status: 'in_progress',
    });
    nodeExecutionRepo.create({
      workflowRunId: run.id,
      workflowNodeId: 'coordinator',
      agentName: 'messaging',
      agentId: agent.id,
      agentSessionId: null,
      status: 'cancelled',
    });
    pendingMessageRepo.enqueue({
      workflowRunId: run.id,
      spaceId: space.id,
      targetKind: 'node_agent',
      targetAgentName: 'reviewer:lead',
      message: 'review this',
    });
    pendingMessageRepo.enqueue({
      workflowRunId: run.id,
      spaceId: space.id,
      targetKind: 'node_agent',
      targetAgentName: 'messaging',
      message: 'message cancelled worker',
    });

    const actors = registry.listActors(space.id);

    expect(canonicalAgentHandle([agent, reservedNameAgent], reservedNameAgent)).toBe(
      '@coordinator'
    );

    expect(actors).toContainEqual({
      actorId: `human:${member.id}`,
      kind: 'human',
      spaceId: space.id,
      handle: undefined,
      roles: ['member'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `session:${member.id}`,
      kind: 'session',
      spaceId: space.id,
      handle: `@session:${member.id}`,
      roles: ['member-session'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `human:${legacyMember.id}`,
      kind: 'human',
      spaceId: space.id,
      handle: undefined,
      roles: ['member'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `session:${legacyMember.id}`,
      kind: 'session',
      spaceId: space.id,
      handle: `@session:${legacyMember.id}`,
      roles: ['member-session'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `agent:coordinator:${space.id}`,
      kind: 'agent',
      spaceId: space.id,
      handle: '@coordinator',
      roles: ['coordinator', 'space-agent'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `agent:${agent.id}`,
      kind: 'agent',
      spaceId: space.id,
      handle: '@long-term-agent',
      roles: ['actor-role:long-term-agent', 'space-agent'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `agent:${reservedNameAgent.id}`,
      kind: 'agent',
      spaceId: space.id,
      handle: '@coordinator',
      roles: ['actor-role:coordinator', 'space-agent'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `worker:${encodeURIComponent(run.id)}:Coding%3ANode:coder%2Flead`,
      kind: 'worker',
      spaceId: space.id,
      handle: `@worker:${encodeURIComponent(run.id)}/Coding%3ANode/coder%2Flead`,
      roles: ['actor-role:Coding%3ANode', 'actor-role:coder%2Flead'],
      status: 'active',
    });
    expect(actors).toContainEqual({
      actorId: `worker:${encodeURIComponent(run.id)}:Review%2FQA:reviewer%3Alead`,
      kind: 'worker',
      spaceId: space.id,
      handle: `@worker:${encodeURIComponent(run.id)}/Review%2FQA/reviewer%3Alead`,
      roles: ['actor-role:Review%2FQA', 'actor-role:reviewer%3Alead'],
      status: 'inactive',
    });
    expect(actors).toContainEqual({
      actorId: `worker:${encodeURIComponent(run.id)}:coordinator:messaging`,
      kind: 'worker',
      spaceId: space.id,
      handle: `@worker:${encodeURIComponent(run.id)}/coordinator/messaging`,
      roles: ['actor-role:coordinator', 'actor-role:messaging'],
      status: 'archived',
    });
    expect(
      actors.some(
        (actor) =>
          actor.actorId === `worker:${encodeURIComponent(run.id)}:OtherReview:reviewer%3Alead`
      )
    ).toBe(false);
    expect(actors.some((actor) => actor.actorId === `worker:${run.id}:reviewer:reviewer`)).toBe(
      false
    );
    expect(actors).toContainEqual({
      actorId: 'system:runtime',
      kind: 'system',
      spaceId: space.id,
      handle: '@system-runtime',
      roles: ['runtime'],
      status: 'active',
    });
    expect(actors.some((actor) => actor.actorId === `session:${coordinator.id}`)).toBe(false);
    expect(actors.some((actor) => actor.actorId === `session:${taskAgent.id}`)).toBe(false);
    expect(actors.some((actor) => actor.actorId === `session:${workerSubSession.id}`)).toBe(false);
    expect(actors.some((actor) => actor.actorId === `session:${namedAgentSubSession.id}`)).toBe(
      false
    );
    expect(actors.some((actor) => actor.actorId === `human:${taskAgent.id}`)).toBe(false);
    expect(actors.some((actor) => actor.actorId === `human:${workerSubSession.id}`)).toBe(false);
    expect(actors.some((actor) => actor.actorId === `human:${namedAgentSubSession.id}`)).toBe(
      false
    );
    for (const actor of actors) {
      if (actor.handle) expect(() => parseAddress(actor.handle!)).not.toThrow();
    }
  });

  it('uses fallback and collision-safe handles for slug-derived agent handles', () => {
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/project',
      slug: 'project',
      name: 'Project',
    });
    const first = spaceAgentRepo.create({ spaceId: space.id, name: 'A-B' });
    const second = spaceAgentRepo.create({ spaceId: space.id, name: 'A B' });
    const prefixed = spaceAgentRepo.create({ spaceId: space.id, name: 'custom-coordinator' });
    const cjk = spaceAgentRepo.create({ spaceId: space.id, name: '助手' });

    const actors = registry.listActors(space.id);

    expect(registry.getActor(space.id, `agent:${first.id}`)?.handle).toBe('@a-b');
    expect(registry.getActor(space.id, `agent:${second.id}`)?.handle).toBe('@a-b-2');
    expect(registry.getActor(space.id, `agent:${first.id}`)?.roles).toEqual([
      'actor-role:a-b',
      'space-agent',
    ]);
    expect(registry.getActor(space.id, `agent:${second.id}`)?.roles).toEqual([
      'actor-role:a-b-2',
      'space-agent',
    ]);
    expect(registry.getActor(space.id, `agent:${prefixed.id}`)?.roles).toEqual([
      'actor-role:custom-coordinator',
      'space-agent',
    ]);
    expect(registry.getActor(space.id, `agent:${cjk.id}`)?.handle).toBe('@unnamed-space');
    for (const actor of actors) {
      if (actor.handle) expect(() => parseAddress(actor.handle!)).not.toThrow();
    }
  });

  it('returns row-backed inactive coordinator when no space chat session exists', () => {
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/project',
      slug: 'project',
      name: 'Project',
    });

    expect(registry.getActor(space.id, `agent:coordinator:${space.id}`)).toEqual({
      actorId: `agent:coordinator:${space.id}`,
      kind: 'agent',
      spaceId: space.id,
      handle: '@coordinator',
      roles: ['coordinator', 'space-agent'],
      status: 'inactive',
    });
  });

  it('preserves synthetic coordinator actor when no long-horizon repository is configured', () => {
    const space = spaceRepo.createSpace({
      workspacePath: '/workspace/project',
      slug: 'project',
      name: 'Project',
    });
    const fallbackRegistry = new SpaceActorRegistryAdapter({
      spaceRepo,
      sessionRepo,
      spaceAgentRepo,
      workflowRepo,
      workflowRunRepo,
      nodeExecutionRepo,
      pendingMessageRepo,
    });

    expect(fallbackRegistry.getActor(space.id, `agent:coordinator:${space.id}`)).toEqual({
      actorId: `agent:coordinator:${space.id}`,
      kind: 'agent',
      spaceId: space.id,
      handle: '@coordinator',
      roles: ['coordinator', 'space-agent'],
      status: 'inactive',
    });
  });
});
