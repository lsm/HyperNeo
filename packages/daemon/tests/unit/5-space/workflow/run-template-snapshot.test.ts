import { describe, expect, test } from 'bun:test';
import type { SpaceAgentTemplate, SpaceWorkflow } from '@hyperneo/shared';
import {
  buildRunTemplateSnapshots,
  createAgentTemplateResolver,
  toRunTemplateSnapshot,
  withRunTemplateSnapshots,
} from '../../../../src/lib/space/workflows/run-template-snapshot.ts';

function template(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
  return {
    key: 'worker.custom',
    handle: 'custom-worker',
    displayName: 'Custom Worker',
    description: 'A custom worker template.',
    instructions: 'Do the custom work.',
    suggestedAutonomyLevel: 2,
    model: 'claude-sonnet-5',
    provider: 'anthropic',
    modelPool: null,
    thinkingLevel: 'think8k',
    settingSources: ['user'],
    tools: ['Read', 'Grep'],
    labels: ['workflow-worker'],
    createdAt: 111,
    updatedAt: 222,
    ...overrides,
  };
}

function workflow(
  nodes: SpaceWorkflow['nodes'],
  overrides: Partial<SpaceWorkflow> = {}
): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Workflow',
    nodes,
    startNodeId: nodes[0]?.id ?? '',
    endNodeId: nodes[nodes.length - 1]?.id,
    tags: [],
    completionAutonomyLevel: 3,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function slot(overrides: Partial<SpaceWorkflow['nodes'][number]['agents'][number]> = {}) {
  return {
    agentId: '',
    name: 'Worker',
    ...overrides,
  };
}

describe('toRunTemplateSnapshot', () => {
  test('keeps spawn-relevant payload fields and drops volatile timestamps', () => {
    expect(toRunTemplateSnapshot(template())).toEqual({
      key: 'worker.custom',
      handle: 'custom-worker',
      displayName: 'Custom Worker',
      description: 'A custom worker template.',
      instructions: 'Do the custom work.',
      suggestedAutonomyLevel: 2,
      model: 'claude-sonnet-5',
      provider: 'anthropic',
      modelPool: null,
      thinkingLevel: 'think8k',
      settingSources: ['user'],
      tools: ['Read', 'Grep'],
      labels: ['workflow-worker'],
    });
  });
});

describe('buildRunTemplateSnapshots', () => {
  test('resolves each referenced templateKey once across nodes', () => {
    const snapshots = buildRunTemplateSnapshots(
      workflow([
        { id: 'n1', name: 'Build', agents: [slot({ templateKey: 'worker.custom' })] },
        { id: 'n2', name: 'Verify', agents: [slot({ name: 'QA', templateKey: 'worker.custom' })] },
      ]),
      (key) => (key === 'worker.custom' ? template() : null)
    );

    expect(Object.keys(snapshots)).toEqual(['worker.custom']);
    expect(snapshots['worker.custom'].instructions).toBe('Do the custom work.');
  });

  test('skips slots without a templateKey and unresolvable keys', () => {
    const snapshots = buildRunTemplateSnapshots(
      workflow([
        {
          id: 'n1',
          name: 'Mixed',
          agents: [
            slot({ name: 'AgentBound', agentId: 'agent-9' }),
            slot({ name: 'Orphan', templateKey: 'worker.gone' }),
            slot({ name: 'Known', templateKey: ' worker.custom ' }),
          ],
        },
      ]),
      (key) => (key === 'worker.custom' ? template() : null)
    );

    expect(Object.keys(snapshots)).toEqual(['worker.custom']);
  });

  test('snapshots template keys that collide with Object.prototype members', () => {
    const snapshots = buildRunTemplateSnapshots(
      workflow([{ id: 'n1', name: 'Odd', agents: [slot({ templateKey: 'toString' })] }]),
      (key) => (key === 'toString' ? template({ key: 'toString' }) : null)
    );

    expect(snapshots['toString']?.key).toBe('toString');
  });

  test('snapshots the __proto__ template key as an own property', () => {
    const snapshots = buildRunTemplateSnapshots(
      workflow([{ id: 'n1', name: 'Odd', agents: [slot({ templateKey: '__proto__' })] }]),
      (key) => (key === '__proto__' ? template({ key: '__proto__' }) : null)
    );

    expect(Object.keys(snapshots)).toEqual(['__proto__']);
    expect(Object.hasOwn(snapshots, '__proto__')).toBe(true);
    expect(snapshots['__proto__']?.key).toBe('__proto__');
  });
});

describe('withRunTemplateSnapshots', () => {
  test('returns the same workflow when no slot resolves to a template', () => {
    const wf = workflow([{ id: 'n1', name: 'Solo', agents: [slot({ agentId: 'agent-1' })] }]);

    expect(withRunTemplateSnapshots(wf, () => null)).toBe(wf);
  });

  test('embeds snapshots without mutating the input workflow', () => {
    const wf = workflow([
      { id: 'n1', name: 'Build', agents: [slot({ templateKey: 'worker.custom' })] },
    ]);

    const pinned = withRunTemplateSnapshots(wf, (key) =>
      key === 'worker.custom' ? template() : null
    );

    expect(pinned).not.toBe(wf);
    expect(pinned.templateSnapshots?.['worker.custom'].labels).toEqual(['workflow-worker']);
    expect(wf.templateSnapshots).toBeUndefined();
  });

  test('pins a workflow whose only template key is __proto__', () => {
    const wf = workflow([{ id: 'n1', name: 'Odd', agents: [slot({ templateKey: '__proto__' })] }]);

    const pinned = withRunTemplateSnapshots(wf, (key) =>
      key === '__proto__' ? template({ key: '__proto__' }) : null
    );

    expect(pinned).not.toBe(wf);
    expect(Object.keys(pinned.templateSnapshots ?? {})).toEqual(['__proto__']);
  });
});

describe('createAgentTemplateResolver', () => {
  test('prefers built-in templates over stored templates with the same key', () => {
    const stored = {
      getByKey: (key: string) =>
        key === 'worker.custom' ? template({ instructions: 'stored copy' }) : null,
    };
    const resolve = createAgentTemplateResolver(stored);

    const builtIn = resolve('worker.swe');
    expect(builtIn?.key).toBe('worker.swe');
    expect(builtIn?.instructions).not.toBe('stored copy');

    const userTemplate = resolve('worker.custom');
    expect(userTemplate?.instructions).toBe('stored copy');

    expect(resolve('worker.nope')).toBeNull();
  });

  test('resolves built-ins when no template repository is provided', () => {
    const resolve = createAgentTemplateResolver();

    expect(resolve('worker.swe')?.key).toBe('worker.swe');
    expect(resolve('worker.unheard-of')).toBeNull();
  });
});
