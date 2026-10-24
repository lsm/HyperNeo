import { neoSettingsPackBriefs } from '../../../../src/lib/neo/packs/index.ts';
import { describe, expect, test } from 'bun:test';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_GOAL_CYCLE,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
} from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
describe('root Neo system prompt', () => {
  test('assembles core guidance with the short root, replacing the Claude Code preset', () => {
    expect(neoPrompt([])).toBe(`${NEO_ROOT_PROMPT}\n\n${NEO_ROOT_TURN_END}`);
    expect(neoPrompt([])).not.toContain(NEO_GOAL_CYCLE);
    expect(NEO_ROOT_TURN_END).toContain('On a scheduled goal wake');
    expect(NEO_ROOT_TURN_END).toContain('On other turns');
    expect(NEO_ROOT_TURN_END).toContain('end the turn without text');
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(260);
    expect(NEO_ROOT_PROMPT).toContain('neo.publication.publish');
    expect(NEO_ROOT_PROMPT).not.toContain('triggerId');
    for (const fact of ['work.find', 'work.send', 'neo.rule.save'])
      expect(NEO_ROOT_PROMPT).toContain(fact);
    expect(NEO_ROOT_PROMPT).not.toContain('Everything for the human goes through');
    expect(NEO_ROOT_PROMPT).not.toContain('Plain assistant text shows only');
  });

  test('routes continuing discussion into a fresh prepared session using existing flows', () => {
    for (const prompt of [neoPrompt([]), neoPrompt(neoSettingsPackBriefs())]) {
      for (const rule of [
        'fresh focused session',
        'continuing human judgment or back-and-forth',
        'Delegate bounded fixes, PRs, deploys and research normally',
        'ask a routing question only when genuinely ambiguous',
        'Always offer a multi-provider HyperNeo session',
        'available Claude Code in Desktop or Codex Desktop',
        "human's preference",
        'neo.todo.add',
        "verb:'start'",
        "human's words, linked docs and earlier decisions",
        'research and drafts',
        'clear questions and options',
        'Wait for preparation',
        'one card',
        'neo.question.ask',
        'sourceSession',
        'Open session',
      ])
        expect(prompt).toContain(rule);
    }
  });

  test('gives questions and publications the same concise Markdown guidance', () => {
    const prompt = neoPrompt([]);
    expect(prompt).toContain('For neo.question.ask text and publication shortText, use Markdown');
    expect(prompt).toContain('a short title line, then a few bullets or a small comparison table');
    expect(prompt).toContain('Bold the key choice');
    expect(prompt).toContain('Avoid walls of text');
    expect(prompt).toContain('Preserve required proposal text, path and hash');
  });

  test('appends the pack briefing only when packs are enabled', () => {
    const coding = neoPrompt(neoSettingsPackBriefs());
    expect(coding.startsWith(`${NEO_ROOT_PROMPT}\n\nDomain packs carry the field`)).toBe(true);
    expect(coding).toContain(NEO_PACK_CODING_INSTRUCTIONS);
    expect(coding.trim().split('\n').at(-1)).toBe(NEO_ROOT_TURN_END.trim());
    expect(neoPrompt([])).not.toContain('Domain packs');
    expect(coding).not.toMatch(/holder|consult|forward|dispatch/i);
  });

  test('teaches no holder, consultation, forwarding or dispatch', () => {
    expect(NEO_ROOT_PROMPT).not.toMatch(/holder|consult|forward|dispatch/i);
    expect(NEO_ROOT_PROMPT).not.toMatch(/neo\.project\.(consult|respond)|neo\.projects\.dispatch/);
  });
});
