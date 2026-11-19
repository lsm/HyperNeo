import { describe, expect, test } from 'bun:test';
import { reportPipelineVerdicts } from './pipeline-verdict-report.ts';

const file = 'packages/demo/src/operations.ts';
const sources = (source: string) => new Map([[file, source]]);

describe('reportPipelineVerdicts', () => {
  test('attributes routes while ignoring unrelated dynamic pipelines', () => {
    const routes = reportPipelineVerdicts(
      sources(`
      const unrelated = superpipe({})(dynamicName).end();
      const run = superpipe({})('demo.good').end();
      defineOperation({ name: 'demo.good', execute: () => run() });
      defineOperation({ name: 'demo.bad', execute: () => 1 });
    `)
    );
    expect(routes.map(({ name, verdict }) => [name, verdict])).toEqual([
      ['demo.bad', 'missing'],
      ['demo.good', 'named'],
    ]);
  });

  test('distinguishes alternatives using whitespace-independent schemas', () => {
    const source = `
      defineOperation({ name: 'demo.read', inputSchema: byId, execute: () => 1 });
      defineOperation({ name: 'demo.read', inputSchema: union([byId, byNumber]), execute: () => 1 });
    `;
    const first = reportPipelineVerdicts(sources(source));
    const second = reportPipelineVerdicts(
      sources(source.replace('union([byId, byNumber])', 'union( [ byId , byNumber ] )'))
    );
    expect(first).toEqual(second);
    expect(new Set(first.map((route) => route.variant)).size).toBe(2);
    expect(first.every((route) => route.variant?.startsWith('schema:'))).toBe(true);
  });

  test('rejects ambiguous alternate identities and unsupported definitions', () => {
    expect(() =>
      reportPipelineVerdicts(
        sources(`
      defineOperation({ name: 'demo.read', inputSchema: byId, execute: () => 1 });
      defineOperation({ name: 'demo.read', inputSchema: byId, execute: () => 2 });
    `)
      )
    ).toThrow('Duplicate operation identity');
    expect(() =>
      reportPipelineVerdicts(
        sources(`defineOperation({ name: nameFromConfig, execute: () => 1 });`)
      )
    ).toThrow('not a literal');
    expect(() => reportPipelineVerdicts(sources(`defineOperation(config);`))).toThrow(
      'Unsupported operation'
    );
    expect(() =>
      reportPipelineVerdicts(
        sources(
          `defineOperation({ name: 'demo.outer', execute: () => defineOperation({ name: 'demo.inner' }) });`
        )
      )
    ).toThrow('Nested operation');
  });

  test('rejects inconsistent classifier results', () => {
    let count = 0;
    expect(() =>
      reportPipelineVerdicts(
        sources(`defineOperation({ name: 'demo.read', execute: () => 1 });`),
        () => ({ missing: count++, misnamed: 0, dynamic: 0, unreadable: 0 })
      )
    ).toThrow('Ambiguous pipeline attribution');
  });
});
