import { neoSettingsPackBriefs } from '../../../../src/lib/neo/packs/index.ts';
import { describe, expect, test } from 'bun:test';
import { NEO_GOAL_CYCLE, NEO_ROOT_PROMPT } from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('Neo scheduled goal-cycle guidance', () => {
  test.each([false, true])('reaches Neo with domain packs enabled: %s', (packsEnabled) => {
    expect(packsEnabled ? neoPrompt(neoSettingsPackBriefs()) : neoPrompt([])).not.toContain(
      NEO_GOAL_CYCLE
    );
    const text = NEO_GOAL_CYCLE;
    expect(text).toContain('On a scheduled goal wake');
    for (const operation of [
      'goal.session.get',
      'goal.facts',
      'neo.home.read',
      'goal.journal.list',
      'neo.ask.propose',
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
  test('binds proposed mandate changes to an actual human confirmation before saving', () => {
    const text = NEO_GOAL_CYCLE;
    for (const fact of [
      'mandateRef',
      'direction.md',
      'neo.question.ask',
      'choice',
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
    expect(text).toContain('declines in chat');
  });
  test('names the goal definition sections at creation and in the work cycle', () => {
    for (const section of ['Resources', 'Do alone', 'Needs the human', 'Daily limit']) {
      expect(NEO_ROOT_PROMPT).toContain(section);
      expect(NEO_GOAL_CYCLE).toContain(section);
    }
    expect(NEO_ROOT_PROMPT).toContain("the human's words");
    expect(NEO_GOAL_CYCLE).toContain('wait for the human to choose Do it');
    expect(NEO_GOAL_CYCLE).toContain('resources or limits');
  });
  test('teaches standing-outcome setup with explicit frequent cadence', () => {
    for (const text of [
      'neo.home.init',
      'neo.home.save',
      'goal.session.create',
      'mandateRev',
      '900000',
      'nudgeEvery',
      'sha256',
      'answeredByHuman',
    ])
      expect(NEO_ROOT_PROMPT).toContain(text);
  });
  test('keeps the short root and gives only scheduled goal wakes a one-line closing label', () => {
    expect(NEO_ROOT_PROMPT.trim().split(/\s+/).length).toBeLessThan(350);
    expect(NEO_ROOT_PROMPT).not.toContain('goal.journal');
    expect(neoPrompt([])).toContain('one plain-text summary line');
    expect(neoPrompt([])).toContain('On other turns');
    expect(neoPrompt([])).toContain('End every other turn with exactly "No response requested."');
  });
  test.each([false, true])(
    'delivers guidance for answered goal reviews with packs: %s',
    (packsEnabled) => {
      const prompt = packsEnabled ? neoPrompt(neoSettingsPackBriefs()) : neoPrompt([]);
      for (const guidance of [
        'no-effect review question is answered',
        'neo.snapshot',
        'goal.session.get',
        'goal.session.update',
        'nextSteps',
        'status to active',
        'status to completed',
      ])
        expect(prompt).toContain(guidance);
    }
  );
});
