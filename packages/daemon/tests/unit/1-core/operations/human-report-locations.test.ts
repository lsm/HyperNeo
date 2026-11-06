import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { NEO_ROOT_PROMPT } from '@hyperneo/prompts';
import { projectNeoAskEntries } from '../../../../src/lib/neo/ask-entries.ts';
import { workerWorkLocationsBrief, todoEvidenceFile } from '../../../../src/lib/work-locations.ts';

describe('human report locations', () => {
  test('the delivered worker brief separates reports from private completion evidence', () => {
    const brief = workerWorkLocationsBrief('/repo');
    expect(brief).toContain('~/HyperNeo/<matter>/');
    expect(brief).toMatch(/never link/i);
    expect(brief).toContain('full absolute path');
    expect(NEO_ROOT_PROMPT).toContain('~/HyperNeo/<matter>/');
    expect(NEO_ROOT_PROMPT).toContain('~/.hyperneo/work');
  });

  test.each(['assigned', 'human-evidence', 'another-todo'])(
    'keeps the human report visible with %s completion evidence',
    (kind) => {
      const path = todoEvidenceFile(kind === 'another-todo' ? 'other' : 't');
      const evidence =
        kind === 'human-evidence' ? 'The human read the report.' : `File ${path} exists.`;
      const original = {
        id: 't',
        askId: 'ask',
        title: 'Review the report',
        state: 'done',
        doneWhen: `File ${todoEvidenceFile('t')} exists.`,
        check: { pack: 'core', kind: 'evidence', params: { path: todoEvidenceFile('t') } },
        evidence,
        report: 'Read the report at /results/Travel/report.md',
      } as NeoTodo;
      const [entry] = projectNeoAskEntries(
        [{ id: 'ask', status: 'open' } as NeoAsk],
        { todos: [original], questions: [], links: new Map() },
        []
      );
      expect(entry.todos[0].evidence).toBe(kind === 'assigned' ? null : evidence);
      expect(entry.todos[0].status).toBe(kind === 'assigned' ? 'Done' : evidence);
      expect(entry.todos[0].report).toBe(original.report);
      expect(original.evidence).toBe(evidence);
    }
  );
});
