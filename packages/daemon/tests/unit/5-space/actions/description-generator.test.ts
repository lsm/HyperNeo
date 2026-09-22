import { describe, expect, test } from 'bun:test';
import { OPERATION_NAMES } from '@hyperneo/shared/types/operation-names';
import {
  CODER_HOT_ACTIONS,
  GENERAL_HOT_ACTIONS,
  PLANNER_HOT_ACTIONS,
  QA_HOT_ACTIONS,
  RESEARCH_HOT_ACTIONS,
  REVIEWER_HOT_ACTIONS,
  ROLE_HOT_ACTIONS,
} from '../../../../src/lib/space/actions/description-generator.ts';
import { WORKER_NODE_HOT_FILL } from '../../../../src/lib/space/actions/worker-contract-tools.ts';

describe('role hot action seeds', () => {
  test('ROLE_HOT_ACTIONS contains all six preset roles', () => {
    expect(Object.keys(ROLE_HOT_ACTIONS).sort()).toEqual([
      'coder',
      'general',
      'planner',
      'qa',
      'research',
      'reviewer',
    ]);
  });

  test('each role has 4-6 hot actions', () => {
    for (const [, actions] of Object.entries(ROLE_HOT_ACTIONS)) {
      expect(actions.length).toBeGreaterThanOrEqual(4);
      expect(actions.length).toBeLessThanOrEqual(6);
    }
  });

  test('every hot-fill name is a declared operation name', () => {
    const declared = new Set<string>(OPERATION_NAMES);
    const names = [...Object.values(ROLE_HOT_ACTIONS).flat(), ...WORKER_NODE_HOT_FILL];
    for (const name of names) {
      expect(declared.has(name), `expected ${name} to be a declared operation`).toBe(true);
    }
  });
});

describe('worker node hot fill seed', () => {
  test('exposes exactly the dispatcher contract hot-fill names', () => {
    expect(CODER_HOT_ACTIONS).toContain('task.create');
    expect([...WORKER_NODE_HOT_FILL]).toEqual([
      'workflow.run.peer.list',
      'workflow.run.reachableAgent.list',
      'workflow.run.channel.list',
      'send_message',
      'nodeAgent.restore',
    ]);
  });
});
