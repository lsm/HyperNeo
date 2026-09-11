import { describe, expect, test } from 'bun:test';
import type { SpaceAgentTemplate, SpaceWorkflow } from '@hyperneo/shared';
import {
  buildRunTemplateSnapshots,
  createAgentTemplateResolver,
  createAgentTemplateResolverFactory,
  runTemplateResolves,
  toRunTemplateSnapshot,
  workflowReferencesTemplates,
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
  const stored = {
    getOwned: (spaceId: string, key: string) =>
      spaceId === 'space-a' && key === 'worker.custom'
        ? template({ instructions: 'stored copy' })
        : null,
  };

  test('prefers built-in templates over stored templates with the same key', () => {
    const resolve = createAgentTemplateResolver('space-a', stored);

    const builtIn = resolve('worker.swe');
    expect(builtIn?.key).toBe('worker.swe');
    expect(builtIn?.instructions).not.toBe('stored copy');

    const userTemplate = resolve('worker.custom');
    expect(userTemplate?.instructions).toBe('stored copy');

    expect(resolve('worker.nope')).toBeNull();
  });

  test('does not resolve a stored template another Space owns', () => {
    expect(createAgentTemplateResolver('space-b', stored)('worker.custom')).toBeNull();
  });

  test('resolves built-ins when no template repository is provided', () => {
    const resolve = createAgentTemplateResolver('space-a');

    expect(resolve('worker.swe')?.key).toBe('worker.swe');
    expect(resolve('worker.unheard-of')).toBeNull();
  });
});

describe('createAgentTemplateResolverFactory', () => {
  test('binds each resolver to the Space it is asked for', () => {
    const resolveFor = createAgentTemplateResolverFactory({
      getOwned: (spaceId: string, key: string) =>
        key === 'worker.custom' ? template({ instructions: `stored in ${spaceId}` }) : null,
    });

    expect(resolveFor('space-a')('worker.custom')?.instructions).toBe('stored in space-a');
    expect(resolveFor('space-b')('worker.custom')?.instructions).toBe('stored in space-b');
  });
});

describe('runTemplateResolves', () => {
  const pinned = { definitionVersion: 'vh-1' };
  const unpinned = { definitionVersion: null };

  test('resolves a key present in the run snapshot', () => {
    expect(
      runTemplateResolves(
        { templateSnapshots: { 'worker.custom': {} as never } },
        pinned,
        'worker.custom'
      )
    ).toBe(true);
  });

  test('rejects a key absent from the run snapshot', () => {
    expect(
      runTemplateResolves(
        { templateSnapshots: { 'worker.custom': {} as never } },
        pinned,
        'other.key'
      )
    ).toBe(false);
  });

  test('rejects an unpinned run rather than resolving live', () => {
    expect(runTemplateResolves({}, unpinned, 'worker.custom')).toBe(false);
  });

  test('rejects a pinned run predating snapshots rather than resolving live', () => {
    expect(runTemplateResolves({}, pinned, 'worker.custom')).toBe(false);
  });

  test('rejects when the pinned definition is unresolvable', () => {
    expect(runTemplateResolves(null, pinned, 'worker.custom')).toBe(false);
  });

  test('does not treat prototype members as snapshot entries', () => {
    expect(
      runTemplateResolves(
        { templateSnapshots: JSON.parse('{"worker.custom":{}}') },
        pinned,
        'toString'
      )
    ).toBe(false);
  });

  test('rejects a blank key', () => {
    expect(runTemplateResolves({ templateSnapshots: {} }, pinned, '   ')).toBe(false);
  });

  test('trims the key before matching the snapshot', () => {
    expect(
      runTemplateResolves(
        { templateSnapshots: { 'worker.custom': {} as never } },
        pinned,
        '  worker.custom  '
      )
    ).toBe(true);
  });
});

describe('empty snapshot marker', () => {
  test('attaches an empty record when the workflow references templates none of which resolve', () => {
    const wf = workflow([
      {
        id: 'n1',
        name: 'Review',
        agents: [slot({ name: 'Reviewer', templateKey: 'gone.custom' })],
      },
    ] as unknown as SpaceWorkflow['nodes']);

    const pinned = withRunTemplateSnapshots(wf, () => null);

    expect(pinned.templateSnapshots).toEqual({});
    expect(
      runTemplateResolves(pinned, { definitionVersion: 'vh-1' }, 'gone.custom', () => true)
    ).toBe(false);
  });

  test('leaves a template-free workflow untouched so its definition hash is unchanged', () => {
    const wf = workflow([
      { id: 'n1', name: 'Review', agents: [slot({ agentId: 'agent-1', name: 'Reviewer' })] },
    ] as unknown as SpaceWorkflow['nodes']);

    const pinned = withRunTemplateSnapshots(wf, () => null);

    expect(pinned).toBe(wf);
    expect(pinned.templateSnapshots).toBeUndefined();
  });

  test('workflowReferencesTemplates ignores blank template keys', () => {
    const withBlank = {
      nodes: [{ agents: [{ agentId: 'a', name: 'x', templateKey: '   ' }] }],
    } as unknown as SpaceWorkflow;
    const withKey = {
      nodes: [{ agents: [{ agentId: '', name: 'x', templateKey: 'k' }] }],
    } as unknown as SpaceWorkflow;

    expect(workflowReferencesTemplates(withBlank)).toBe(false);
    expect(workflowReferencesTemplates(withKey)).toBe(true);
  });
});
