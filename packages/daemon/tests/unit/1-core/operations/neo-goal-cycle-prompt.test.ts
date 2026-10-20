import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { NEO_ROOT_PROMPT } from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';

describe('Neo scheduled goal-cycle guidance', () => {
  test.each([false, true])('reaches Neo with domain packs enabled: %s', (packsEnabled) => {
    const options: Options = {};
    if (packsEnabled) restrictNeoQuery(options);
    else restrictNeoQuery(options, undefined, []);
    const text =
      typeof options.systemPrompt === 'object' && 'prompt' in options.systemPrompt
        ? options.systemPrompt.prompt
        : '';
    expect(text).toContain('On a scheduled goal wake');
    for (const operation of [
      'goal.session.get',
      'goal.facts',
      'neo.home.read',
      'goal.journal.list',
      'neo.ask.open',
      'goal.journal.append',
      'goal.session.update',
    ])
      expect(text).toContain(operation);
    for (const field of [
      'goalId',
      'runId',
      'done',
      'effect',
      'evidence',
      'worked',
      'failed',
      'progress',
      'summary',
      'nextSteps',
    ])
      expect(text).toContain(field);
    expect(text).toContain('nothing moved; waiting on');
  });
  test('binds proposed mandate changes to an actual human yes before saving', () => {
    const text = neoPrompt([]);
    for (const fact of [
      'mandateRef',
      'direction.md',
      'neo.question.ask',
      'yesno',
      'confirm',
      'sha256',
      'neo.question.get',
      'answeredByHuman',
      'neo.home.save',
      'questionId',
      'mandateRev',
    ])
      expect(text).toContain(fact);
    expect(text).toContain('exact UTF-8');
    expect(text).toContain('old and new');
    expect(text).toContain('On no');
  });
  test('keeps the short root and gives only scheduled goal wakes a one-line closing label', () => {
    expect(NEO_ROOT_PROMPT.trim().split(/\s+/).length).toBeLessThan(160);
    expect(NEO_ROOT_PROMPT).not.toContain('goal.journal');
    expect(neoPrompt([])).toContain('one plain-text summary line');
    expect(neoPrompt([])).toContain('On other turns');
    expect(neoPrompt([])).toContain('end the turn without text');
  });
});
