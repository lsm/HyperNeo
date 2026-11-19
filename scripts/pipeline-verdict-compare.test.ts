import { expect, test } from 'bun:test';
import { comparePipelineVerdicts } from './pipeline-verdict-compare.ts';

const route = (name: string, verdict: string) => ({
  file: 'packages/demo/src/ops.ts',
  name,
  verdict,
});

test('grandfathers only the same operation with the same adverse verdict', () => {
  const base = [route('demo.existing', 'unreadable'), route('demo.fixed', 'misnamed')];
  const head = [route('demo.existing', 'unreadable'), route('demo.fixed', 'named')];
  expect(comparePipelineVerdicts(base, head)).toEqual({
    changes: [
      { file: 'packages/demo/src/ops.ts', name: 'demo.fixed', before: 'misnamed', after: 'named' },
    ],
    regressions: [],
  });
});

test('rejects new or changed adverse verdicts even if another route improves', () => {
  const base = [route('demo.fixed', 'unreadable'), route('demo.changed', 'unreadable')];
  const head = [
    route('demo.fixed', 'named'),
    route('demo.changed', 'missing'),
    route('demo.new', 'unreadable'),
  ];
  expect(comparePipelineVerdicts(base, head).regressions.map((change) => change.name)).toEqual([
    'demo.changed',
    'demo.new',
  ]);
});

test('rejects a disappeared route and a duplicate identity', () => {
  const original = route('demo.read', 'named');
  expect(comparePipelineVerdicts([original], []).regressions).toHaveLength(1);
  expect(() => comparePipelineVerdicts([original, original], [])).toThrow(
    'Duplicate pipeline verdict'
  );
  expect(() => comparePipelineVerdicts([], [route('demo.read', 'unknown')])).toThrow(
    'Invalid pipeline verdict'
  );
});

test('compares alternative definitions independently', () => {
  const first = { ...route('task.get', 'named'), variant: 'by-id' };
  const second = { ...route('task.get', 'unreadable'), variant: 'by-number' };
  const head = [
    { ...first, verdict: 'unreadable' },
    { ...second, verdict: 'named' },
  ];
  expect(comparePipelineVerdicts([first, second], head).regressions).toEqual([
    { file: first.file, name: first.name, variant: 'by-id', before: 'named', after: 'unreadable' },
  ]);
  expect(() => comparePipelineVerdicts([first, first], [])).toThrow('Duplicate pipeline verdict');
  expect(() => comparePipelineVerdicts([route('task.get', 'named'), first], [])).toThrow(
    'Ambiguous pipeline verdict variants'
  );
  expect(() => comparePipelineVerdicts([], [{ ...first, variant: '' }])).toThrow(
    'Invalid pipeline verdict'
  );
});
