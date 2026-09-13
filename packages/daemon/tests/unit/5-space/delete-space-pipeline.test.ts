import { describe, expect, mock, test } from 'bun:test';
import {
  type DeleteSpaceIo,
  runSpaceDeletion,
} from '../../../src/lib/space/managers/delete-space-pipeline.ts';

function io(overrides: Partial<DeleteSpaceIo> = {}): DeleteSpaceIo {
  return {
    fenceSpace: mock(async () => true),
    quiesceSpace: mock(async () => {}),
    removeSpace: mock(async () => true),
    ...overrides,
  };
}

describe('delete-space pipeline', () => {
  test('fences, quiesces and removes in that order', async () => {
    const order: string[] = [];
    const deps = io({
      fenceSpace: mock(async () => {
        order.push('fence');
        return true;
      }),
      quiesceSpace: mock(async () => {
        order.push('quiesce');
      }),
      removeSpace: mock(async () => {
        order.push('remove');
        return true;
      }),
    });

    const result = await runSpaceDeletion(deps, 'space-1');

    expect(result).toEqual({ success: true });
    expect(order).toEqual(['fence', 'quiesce', 'remove']);
  });

  test('a refused fence halts the run before quiesce and removal', async () => {
    const deps = io({ fenceSpace: mock(async () => false) });

    const result = await runSpaceDeletion(deps, 'ghost');

    expect(result).toBe('space_not_found');
    expect(deps.quiesceSpace).not.toHaveBeenCalled();
    expect(deps.removeSpace).not.toHaveBeenCalled();
  });

  test('a failed removal rejects after the space was already quiesced', async () => {
    const deps = io({ removeSpace: mock(async () => false) });

    const result = await runSpaceDeletion(deps, 'space-1');

    expect(result).toBe('space_not_found');
    expect(deps.quiesceSpace).toHaveBeenCalledWith('space-1');
  });

  test('an absent quiesce step is optional and the run still completes', async () => {
    const deps = io({ quiesceSpace: undefined });

    const result = await runSpaceDeletion(deps, 'space-1');

    expect(result).toEqual({ success: true });
    expect(deps.removeSpace).toHaveBeenCalledWith('space-1');
  });

  test('each stage receives the fenced space id', async () => {
    const deps = io();

    await runSpaceDeletion(deps, 'space-7');

    expect(deps.fenceSpace).toHaveBeenCalledWith('space-7');
    expect(deps.quiesceSpace).toHaveBeenCalledWith('space-7');
    expect(deps.removeSpace).toHaveBeenCalledWith('space-7');
  });

  test('a throwing quiesce propagates and never removes the space', async () => {
    const deps = io({
      quiesceSpace: mock(async () => {
        throw new Error('drain exploded');
      }),
    });

    await expect(runSpaceDeletion(deps, 'space-1')).rejects.toThrow('drain exploded');
    expect(deps.removeSpace).not.toHaveBeenCalled();
  });
});
