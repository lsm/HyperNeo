import { describe, it, expect } from 'vitest';
import type { WorkflowChannel, WorkflowNode } from '@hyperneo/shared';
import type { VisualTransition } from '../types';
import { autoLayout } from '../layout';

function makeStep(id: string, name = id, options: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    name,
    agents: [],
    ...options,
  };
}

function makeTransition(from: string, to: string): VisualTransition {
  return { id: `${from}->${to}`, from, to };
}

describe('autoLayout', () => {
  it('returns an empty map for an empty workflow', () => {
    expect(autoLayout([], [], 'start').size).toBe(0);
  });

  it('lays out a linear workflow vertically', () => {
    const steps = ['a', 'b', 'c'].map((id) => makeStep(id));
    const transitions = [makeTransition('a', 'b'), makeTransition('b', 'c')];
    const result = autoLayout(steps, transitions, 'a');

    expect(result.size).toBe(3);
    expect(result.get('b')!.y).toBeGreaterThan(result.get('a')!.y);
    expect(result.get('c')!.y).toBeGreaterThan(result.get('b')!.y);
    expect(result.get('a')!.x).toBe(result.get('b')!.x);
    expect(result.get('b')!.x).toBe(result.get('c')!.x);
  });

  it('uses semantic channels to place reviewer nodes in a side lane', () => {
    const steps = [
      makeStep('planning', 'Planning'),
      makeStep('plan-review', 'Plan Review'),
      makeStep('coding', 'Coding'),
      makeStep('code-review', 'Code Review'),
      makeStep('qa', 'QA'),
      makeStep('done', 'Done'),
    ];
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Plan Review' },
      { from: 'Plan Review', to: 'Planning' },
      { from: 'Plan Review', to: 'Coding' },
      { from: 'Coding', to: 'Code Review' },
      { from: 'Code Review', to: 'Coding' },
      { from: 'Code Review', to: 'QA' },
      { from: 'QA', to: 'Done' },
    ];

    const result = autoLayout(steps, [], 'planning', channels);
    expect(result.get('plan-review')!.x).toBeGreaterThan(result.get('planning')!.x);
    expect(result.get('code-review')!.x).toBeGreaterThan(result.get('coding')!.x);
    expect(result.get('qa')!.x).toBeLessThan(result.get('code-review')!.x);
  });

  it('ignores backward feedback channels for rank placement', () => {
    const steps = [
      makeStep('planning', 'Planning'),
      makeStep('review', 'Plan Review'),
      makeStep('coding', 'Coding'),
    ];
    const channels: WorkflowChannel[] = [
      { from: 'Planning', to: 'Plan Review' },
      { from: 'Plan Review', to: 'Planning' },
      { from: 'Plan Review', to: 'Coding' },
    ];

    const result = autoLayout(steps, [], 'planning', channels);
    expect(result.get('review')!.y).toBeGreaterThan(result.get('planning')!.y);
    expect(result.get('coding')!.y).toBeGreaterThan(result.get('review')!.y);
  });

  it('assigns positions to orphaned nodes even without edges', () => {
    const steps = ['a', 'b', 'c'].map((id) => makeStep(id));
    const result = autoLayout(steps, [], 'a');
    expect(result.size).toBe(3);
    expect(result.get('a')).toBeDefined();
    expect(result.get('b')).toBeDefined();
    expect(result.get('c')).toBeDefined();
  });
});
