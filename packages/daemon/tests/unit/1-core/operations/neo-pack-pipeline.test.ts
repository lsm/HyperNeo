import { expect, mock, test } from 'bun:test';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { retainPackPipeline } from '../../../../src/lib/neo/pack-pipeline.ts';
import { defineOperation } from '../../../../src/lib/operations/registry.ts';

const definition = {
  name: 'fixture.read',
  description: 'Read a fixture',
  inputSchema: z.string(),
  resultSchema: z.string(),
};

test('defines the operation without exposing its described runner', async () => {
  const runner = (superpipe({})('fixture.read') as PipelineAPI).input('input').endAsync('input');
  const displaced = mock(async () => 'wrong');
  const marked = {
    ...defineOperation({ ...definition, execute: displaced }),
    pipelineRunner: runner,
  };
  const operation = retainPackPipeline(marked, runner);
  expect(Reflect.has(operation, 'pipelineRunner')).toBe(false);
  expect(Reflect.has(operation.execute, 'pipeline')).toBe(false);
  expect(await operation.execute('value', { source: 'rpc', principal: 'local' })).toBe('value');
  expect(displaced).not.toHaveBeenCalled();
});

test('rejects a runner with a different pipeline name', () => {
  const runner = (superpipe({})('fixture.other') as PipelineAPI).input('input').endAsync('input');
  expect(() =>
    retainPackPipeline(defineOperation({ ...definition, execute: runner }), runner)
  ).toThrow('Pack pipeline name does not match fixture.read');
});
