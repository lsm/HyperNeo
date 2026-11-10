import { unclassifiedNeoOperations } from './neo-discovery-coverage.ts';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { z } from '../packages/daemon/node_modules/zod/index.js';
import { clientEventMethods, serializeApiSurface, saveApiSurface } from './api-surface.ts';

const operation = (name: string, schema = z.object({ title: z.string() })) => ({
  name,
  description: 'Synthetic operation',
  inputSchema: schema,
  resultSchema: z.object({ ok: z.boolean(), note: z.string().nullable().optional() }),
  execute: async () => ({ ok: true }),
});
describe('api:surface', () => {
  test('exports input/output schemas with stable sorted operations, events and keys', () => {
    const first = serializeApiSurface(
      [operation('test.z'), operation('test.a')],
      ['state.z', 'state.a', 'state.z'],
      ['test.a', 'test.z']
    );
    const again = serializeApiSurface(
      [operation('test.a'), operation('test.z')],
      ['state.a', 'state.z'],
      ['test.z', 'test.a']
    );
    expect(first).toBe(again);
    const surface = JSON.parse(first);
    expect(surface.operations.map((x: { name: string }) => x.name)).toEqual(['test.a', 'test.z']);
    expect(surface.events).toEqual(['state.a', 'state.z']);
    expect(surface.operations[0].inputSchema.properties.title.type).toBe('string');
    expect(surface.operations[0].resultSchema.properties.note.type).toContain('null');
    expect(surface.operations[0].resultSchema.additionalProperties).toBe(false);
    expect(first.endsWith('\n')).toBe(true);
  });
  test('marks unrepresentable transforms and detects a transform change', () => {
    const a = {
      ...operation('test.a'),
      resultSchema: z.string().transform((value) => value.length),
    };
    const b = {
      ...operation('test.a'),
      resultSchema: z.string().transform((value) => value.length + 1),
    };
    const first = serializeApiSurface([a], [], ['test.a']);
    expect(first).toContain('x-zod-unrepresentable');
    expect(first).toContain('x-zod-transform-sha256');
    expect(first).not.toBe(serializeApiSurface([b], [], ['test.a']));
  });
  test('refuses missing operations instead of silently producing a partial API', () => {
    expect(() =>
      serializeApiSurface([operation('test.a')], [], ['test.a', 'test.missing'])
    ).toThrow('test.missing');
  });
  test('check detects schema drift without overwriting the committed surface', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-surface-test-'));
    try {
      const path = join(dir, 'api-surface.json');
      const before = serializeApiSurface([operation('test.a')], [], ['test.a']);
      saveApiSurface(path, before, false);
      expect(readFileSync(path, 'utf8')).toBe(before);
      saveApiSurface(path, before, true);
      const after = serializeApiSurface(
        [operation('test.a', z.object({ title: z.string(), count: z.number() }))],
        [],
        ['test.a']
      );
      expect(() => saveApiSurface(path, after, true)).toThrow('bun run api:surface');
      expect(readFileSync(path, 'utf8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('extracts direct, constant, template and bridge event methods without internal events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-events-test-'));
    try {
      const path = join(dir, 'events.ts');
      writeFileSync(
        path,
        "const C = { SESSION: 'state.session' } as const; const hub = { event(_method: string) {} }; hub.event(C.SESSION); hub.event(`${C.SESSION}.delta`); hub.event('neo.changed'); const mappings = [{clientEvent:'space.updated'}]; const bus = { publish(_method: string) {} }; bus.publish('internal.secret');"
      );
      const program = ts.createProgram([path], { noLib: true });
      expect(clientEventMethods(program, [path])).toEqual([
        'neo.changed',
        'space.updated',
        'state.session',
        'state.session.delta',
      ]);
      writeFileSync(
        path,
        'declare const method: string; declare const hub: {event(method: string):void}; hub.event(method);'
      );
      expect(() => clientEventMethods(ts.createProgram([path], { noLib: true }), [path])).toThrow(
        'event method'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Neo discovery coverage', () => {
  test('requires every admitted name to have a visible route or documented exclusion', () => {
    expect(
      unclassifiedNeoOperations([
        operation('work.status'),
        operation('work.read'),
        operation('neo.session.archive'),
        operation('goal.journal.list'),
        operation('goal.session.list'),
        operation('schedule.session.list'),
        operation('goal.list'),
        operation('schedule.list'),
        operation('goal.reviewFuture'),
        operation('session.get'),
        operation('review.new'),
      ])
    ).toEqual(['goal.reviewFuture', 'review.new']);
  });
  test('checks disabled pack operations before a future enablement', () => {
    expect(
      unclassifiedNeoOperations([
        { ...operation('review.pack'), pack: { id: 'example', enabledIds: () => [] } },
      ])
    ).toEqual(['review.pack']);
  });
  test('does not require a discovery entry for callers denied by admission', () => {
    expect(
      unclassifiedNeoOperations([
        {
          ...operation('review.worker'),
          policy: { safetyClass: 'read', roles: ['workflow_worker'] },
        },
        { ...operation('neo.session.track'), policy: { safetyClass: 'human_only' } },
      ])
    ).toEqual([]);
  });
});
