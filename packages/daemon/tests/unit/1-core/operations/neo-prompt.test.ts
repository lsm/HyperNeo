import { neoSettingsPackBriefs } from '../../../../src/lib/neo/packs/index.ts';
import { describe, expect, test } from 'bun:test';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_PACK_CODING_WORKER_RULES,
  NEO_GOAL_CYCLE,
  NEO_ROOT_PROMPT,
  NEO_FOCUSED_DISCUSSION,
  NEO_ROOT_TURN_END,
} from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
describe('root Neo system prompt', () => {
  test.each([false, true])('limits worker messages with packs: %s', (enabled) => {
    const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
    expect(prompt).toContain('project and a number');
    expect(prompt).toContain('never a task title');
    expect(prompt).toContain('work.rename');
    expect(prompt).toContain('Coordination questions');
    expect(prompt).toContain('never human cards');
    expect(prompt).toContain('Message Neo only at milestones');
    expect(prompt).toContain('PR opened, merged or closed; blocked; a question; done; failed');
    expect(prompt).toContain('no acknowledgments and no progress pings');
    expect(prompt).toContain('Never ask workers to confirm or acknowledge');
  });

  test('assembles core guidance with the short root, replacing the Claude Code preset', () => {
    expect(neoPrompt([])).toBe(
      `${NEO_ROOT_PROMPT}\n\n${NEO_FOCUSED_DISCUSSION}\n\n${NEO_ROOT_TURN_END}`
    );
    expect(neoPrompt([])).not.toContain(NEO_GOAL_CYCLE);
    expect(NEO_ROOT_TURN_END).toContain('On a scheduled goal wake');
    expect(NEO_ROOT_TURN_END).toContain('On other turns');
    expect(NEO_ROOT_TURN_END).toContain('end the turn without text');
    expect(NEO_ROOT_TURN_END).toContain(
      'When you are waiting on something, end the turn; the event wakes you'
    );
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(300);
    expect(NEO_ROOT_PROMPT).toContain('neo.publication.publish');
    expect(NEO_ROOT_PROMPT).not.toContain('triggerId');
    for (const fact of ['work.find', 'work.send', 'neo.rule.save'])
      expect(NEO_ROOT_PROMPT).toContain(fact);
    expect(NEO_ROOT_PROMPT).not.toContain('Everything for the human goes through');
    expect(NEO_ROOT_PROMPT).not.toContain('Plain assistant text shows only');
  });

  test('routes continuing discussion into a fresh prepared session using existing flows', () => {
    expect(NEO_FOCUSED_DISCUSSION.split(/\s+/).length).toBeLessThan(250);
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
        'focused:true',
        'ask id',
        'explicitly says it is settled',
        'decision, documents and PRs',
        'neo.ask.outcome',
        'existing todos',
        'status only',
        'do not act, reply, forward or treat them as approval',
      ])
        expect(prompt).toContain(rule);
    }
  });

  test.each([false, true])(
    'keeps non-coding file rules in delivered guidance with packs: %s',
    (enabled) => {
      const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
      for (const rule of [
        '~/HyperNeo',
        'configured workspace',
        'Most tasks write nothing',
        'filled form',
        'table',
        '旅行/2026圣诞',
        'home root',
        'hidden state',
      ])
        expect(prompt).toContain(rule);
      expect(prompt).toMatch(/human.{0,35}(?:named path|own message)/u);
    }
  );

  test('gives questions and publications the same concise Markdown guidance', () => {
    const prompt = neoPrompt([]);
    expect(prompt).toContain('For neo.question.ask text and publication shortText, use Markdown');
    expect(prompt).toContain('a short title line, then a few bullets or a small comparison table');
    expect(prompt).toContain('Bold the key choice');
    expect(prompt).toContain('Avoid walls of text');
    expect(prompt).toContain('Preserve required proposal text, path and hash');
  });

  test('guides verbatim publications next to the shortText and fullText rules', () => {
    const prompt = neoPrompt([]);
    expect(prompt).toContain(
      'Use verbatim: true for deliverables the human will copy: translations, drafted emails/messages, text to paste'
    );
    expect(prompt).toContain(
      'A verbatim message holds only the deliverable; any lead-in line is a separate normal message or is skipped'
    );
    expect(prompt).toContain('One message per deliverable');
    expect(prompt).toContain(
      'Plain text for emails and translations; Markdown or code only when the human wants it'
    );
    expect(prompt).toContain('Everything else stays shortText + fullText ("more")');
    expect(prompt).toContain('Anything over the verbatim limit goes as a file');
  });

  test('appends the pack briefing only when packs are enabled', () => {
    const coding = neoPrompt(neoSettingsPackBriefs());
    expect(coding.startsWith(`${NEO_ROOT_PROMPT}\n\nDomain packs carry the field`)).toBe(true);
    expect(coding).toContain(NEO_PACK_CODING_INSTRUCTIONS);
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('never sleep or poll gh');
    expect(coding.trim().split('\n').at(-1)).toBe(NEO_ROOT_TURN_END.trim());
    expect(neoPrompt([])).not.toContain('Domain packs');
    expect(coding.replace(NEO_FOCUSED_DISCUSSION, '')).not.toMatch(
      /holder|consult|forward|dispatch/i
    );
  });

  test('teaches no holder, consultation, forwarding or dispatch', () => {
    expect(NEO_ROOT_PROMPT).not.toMatch(/holder|consult|forward|dispatch/i);
    expect(NEO_ROOT_PROMPT).not.toMatch(/neo\.project\.(consult|respond)|neo\.projects\.dispatch/);
  });
});

describe('coding worker rules', () => {
  test('keeps simulator slots and coordination with workers and Neo', () => {
    for (const phrase of [
      'at most 2 booted machine-wide',
      'wait and retry yourself',
      'never ask the human for a slot',
      'coordination questions',
      'kind question and no question envelope',
      'never a human card',
    ])
      expect(NEO_PACK_CODING_WORKER_RULES).toContain(phrase);
  });

  test('requires concise public PR descriptions and issues while retaining full reports to Neo', () => {
    expect(
      NEO_PACK_CODING_WORKER_RULES
    ).toContain(`10. Write PR descriptions and issues for a person to read in 30 seconds.
    - First, 2–3 sentences: what this is (bug fix, feature, cleanup) and why. For a bug, say what was wrong as a user sees it. Link the issue if there is one (keep \`Closes #N\`).
    - Then how, in a few short bullets: the change, not the search that found it.
    - Then \`Verified:\` in one or two lines: what you ran and what you saw.
    - Nothing else: no file-by-file audits, test counts, lists of what you didn't touch, or merge instructions. Your full report (rule 9) goes to Neo, not into the PR.
    - In a public repo: no local paths, machine names, session ids or private repo names.
    An issue states the problem and what done looks like, in a few sentences.`);
  });
});
