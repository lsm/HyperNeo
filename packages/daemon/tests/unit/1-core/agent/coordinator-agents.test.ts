import { describe, expect, it } from 'bun:test';
import { getCoordinatorAgents } from '../../../../src/lib/agent/coordinator-agents';
import type { AgentDefinition } from '@hyperneo/shared';

describe('getCoordinatorAgents', () => {
  it('should return coordinator and all specialist agents', () => {
    const agents = getCoordinatorAgents();

    expect(agents.Coordinator).toBeDefined();
    expect(agents.Coder).toBeDefined();
    expect(agents.Debugger).toBeDefined();
    expect(agents.Tester).toBeDefined();
    expect(agents.Reviewer).toBeDefined();
    expect(agents.VCS).toBeDefined();
    expect(agents.Verifier).toBeDefined();
  });

  it('should include coordinator agent with orchestration tools only', () => {
    const agents = getCoordinatorAgents();
    const coordinator = agents.Coordinator;

    expect(coordinator.tools).toContain('Agent');
    expect(coordinator.tools).toContain('Task');
    expect(coordinator.tools).toContain('TodoWrite');
    expect(coordinator.tools).toContain('AskUserQuestion');
    expect(coordinator.model).toBe('opus');
  });

  it('should include specialist agents with appropriate tools', () => {
    const agents = getCoordinatorAgents();

    expect(agents.Coder.tools).toContain('Edit');
    expect(agents.Coder.tools).toContain('Write');
    expect(agents.Coder.tools).toContain('Agent');

    expect(agents.Debugger.tools).toContain('Bash');
    expect(agents.Debugger.tools).toContain('Write');
    expect(agents.Debugger.tools).toContain('Agent');

    expect(agents.Tester.tools).toContain('Agent');

    expect(agents.VCS.tools).toContain('Bash');
  });

  it('should merge user agents with specialists', () => {
    const userAgents: Record<string, AgentDefinition> = {
      'custom-agent': {
        description: 'A custom agent',
        prompt: 'You are a custom agent.',
      },
    };

    const agents = getCoordinatorAgents(userAgents);

    expect(agents['custom-agent']).toBeDefined();
    expect(agents['custom-agent'].description).toBe('A custom agent');
    expect(agents.Coder).toBeDefined();
    expect(agents.Coordinator).toBeDefined();
  });

  it('should let specialists win on name conflicts with user agents', () => {
    const userAgents: Record<string, AgentDefinition> = {
      Coder: {
        description: 'User-defined Coder',
        prompt: 'Custom coder prompt.',
      },
    };

    const agents = getCoordinatorAgents(userAgents);

    expect(agents.Coder.description).not.toBe('User-defined Coder');
  });

  it('should return correct number of agents', () => {
    const agents = getCoordinatorAgents();
    const agentNames = Object.keys(agents);

    expect(agentNames).toHaveLength(7);
  });

  it('should work with undefined user agents', () => {
    const agents = getCoordinatorAgents(undefined);

    expect(agents.Coordinator).toBeDefined();
    expect(Object.keys(agents)).toHaveLength(7);
  });

  it('should have verifier using opus model for critical verification', () => {
    const agents = getCoordinatorAgents();

    expect(agents.Verifier.model).toBe('opus');
  });

  it('should have all agents with non-empty prompts', () => {
    const agents = getCoordinatorAgents();

    for (const [_name, agent] of Object.entries(agents)) {
      expect(agent.prompt.length).toBeGreaterThan(0);
      expect(agent.description.length).toBeGreaterThan(0);
    }
  });

  it('should have coordinator with orchestration and monitoring tools only', () => {
    const agents = getCoordinatorAgents();
    expect(agents.Coordinator.tools).toEqual([
      'Agent',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TodoWrite',
      'AskUserQuestion',
      'EnterPlanMode',
      'ExitPlanMode',
    ]);
  });
});
