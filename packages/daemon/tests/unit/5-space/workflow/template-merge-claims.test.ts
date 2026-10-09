import { describe, expect, test } from 'bun:test';
import type { WorkflowNode } from '@hyperneo/shared';
import { findRenamedTemplateInstalls } from '../../../../src/lib/workflows/built-in-template-merge';

const node = (id: string, name: string, templateKey?: string) =>
  ({ id, name, agents: [{ name: `${name}-agent`, templateKey }] }) as unknown as WorkflowNode;

describe('findRenamedTemplateInstalls', () => {
  test('lets each existing node satisfy only the first template that matches it', () => {
    const existing = [node('e1', 'Renamed Coder', 'coder')];
    const first = node('t1', 'Coder', 'coder');
    const second = node('t2', 'Coder Two', 'coder');
    const renamed = findRenamedTemplateInstalls(existing, [first, second], [first, second]);
    expect([...renamed]).toEqual([first]);
  });

  test('never matches a node already claimed by id or name', () => {
    const existing = [node('e1', 'Coder', 'coder')];
    const byName = node('t1', 'Coder', 'other');
    const sameKey = node('t2', 'Coder Two', 'coder');
    expect(findRenamedTemplateInstalls(existing, [byName, sameKey], [sameKey]).size).toBe(0);
  });

  test('leaves templates without a matching agent unclaimed', () => {
    const template = node('t1', 'Reviewer', 'reviewer');
    expect(
      findRenamedTemplateInstalls([node('e1', 'Coder', 'coder')], [template], [template]).size
    ).toBe(0);
  });
});
