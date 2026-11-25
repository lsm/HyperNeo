import { expect, test } from 'bun:test';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { validatePackRunner } from '../../../../src/lib/neo/pack-runner.ts';
import { defineOperation } from '../../../../src/lib/operations/registry.ts';

const operation = defineOperation({
  name: 'fixture.read',
  description: 'Read a fixture',
  inputSchema: z.string(),
  resultSchema: z.string(),
  execute: async (input) => input,
});

test('accepts an unmarked handler and a matching described runner', () => {
  const runner = (superpipe({})('fixture.read') as PipelineAPI).input('input').endAsync('input');
  const marked = { ...operation, pipelineRunner: runner };
  expect(() => validatePackRunner(operation)).not.toThrow();
  expect(() => validatePackRunner(marked)).not.toThrow();
});

test('rejects a mismatched or undescribed runner', () => {
  const other = (superpipe({})('fixture.other') as PipelineAPI).input('input').endAsync('input');
  for (const runner of [other, async () => 'value', 'not a function']) {
    const marked = { ...operation, pipelineRunner: runner };
    expect(() => validatePackRunner(marked)).toThrow(
      'Invalid pack pipeline runner for fixture.read'
    );
  }
});
