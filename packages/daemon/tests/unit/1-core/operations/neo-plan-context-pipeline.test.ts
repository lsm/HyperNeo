import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoPlanContext } from '../../../../src/lib/neo/plan-context-pipeline.ts';

const asks = Array.from({ length: 12 }, (_, i) => ({
  id: `ask-${i}`,
  title: `Plan ${i}`,
  status: 'open',
})) as NeoAsk[];
const step = {
  id: 'first',
  askId: 'ask-0',
  title: 'First step',
  position: 0,
  state: 'todo',
  dependsOn: [],
  approvedAt: 1,
  startedAt: null,
  blockedBy: null,
  blockedReason: null,
  reason: null,
} as NeoTodo;

describe('neo.plan.context', () => {
  test('sends full after compact, changed lines after, nothing when unchanged', async () => {
    let facts = { asks, todos: [step], questions: [] };
    const context = createNeoPlanContext(async () => facts);
    expect(await context('startup')).toContain('ask-11');
    expect(await context('prompt')).toBe('');
    facts = { ...facts, todos: [{ ...step, state: 'doing' }] };
    const changed = await context('prompt');
    expect(changed).toContain('[doing]');
    expect(changed).not.toContain('ask-11');
    expect(await context('compact')).toContain('ask-11');
    expect(await context('prompt')).toBe('');
    expect(await context('resume')).toContain('ask-11');
    expect(await createNeoPlanContext(async () => facts)('prompt')).toContain('ask-11');
  });

  test('retains every owner over budget and leaves the last delivered context intact on read failure', async () => {
    let fail = false;
    const facts = { asks, todos: [step], questions: [] };
    const context = createNeoPlanContext(async () => {
      if (fail) throw new Error('Synthetic read failed');
      return facts;
    }, 1);
    const full = await context('startup');
    for (const ask of asks) expect(full).toContain(`Ask ${ask.id} `);
    expect(full).toContain('neo.ask.read ask-0');
    fail = true;
    await expect(context('prompt')).rejects.toThrow('Synthetic read failed');
    fail = false;
    expect(await context('prompt')).toBe('');
  });
});
