import { describe, expect, test } from 'bun:test';
import {
  NEO_FOCUSED_DISCUSSION,
  NEO_GOAL_CYCLE,
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_PACK_CODING_WORKER_RULES,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
  neoToolDescription,
} from '@hyperneo/prompts';
import { neoSettingsPackBriefs } from '../../../../src/lib/neo/packs/index.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('root Neo system prompt', () => {
  test('adds every ask step with after before starting the first', () => {
    expect(NEO_ROOT_PROMPT).toContain(
      'Add all ask steps as todos, each with after, before starting the first.'
    );
  });
  test.each([false, true])(
    'delivers follow-up input binding guidance with packs: %s',
    (enabled) => {
      const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
      expect(prompt).toContain('Human requests use input');
      expect(prompt).toContain('plain follow-ups add their open askId');
      expect(prompt).not.toContain('Human requests use input, never askId');
    }
  );
  test('tells Neo to check provider quota before assigning work', () => {
    expect(neoPrompt([])).toContain(
      "Before assigning work to a model, call invoke settings.provider.usage with that model's provider. If any window has used at or above limit, choose a worker on another provider or wait until its resetAt, and say which; if resetAt is null, say the reset time is unknown. not_supported or an error means unknown: assign as usual."
    );
  });
  test('tells Neo to answer a worker question itself before asking the human', () => {
    expect(NEO_ROOT_TURN_END).toContain(
      'A worker that ended its turn with a question waits on you. Answer it yourself when the plan, saved rules or your authority settle it; only otherwise relay it with neo.question.relay, so the card links the session and the answer reaches the worker.'
    );
  });
  test('tells Neo to label asks with a reused short topic', () => {
    expect(NEO_ROOT_TURN_END).toContain('neo.ask.topic');
    expect(NEO_ROOT_TURN_END).toContain('never coin a near-synonym');
    expect(NEO_ROOT_TURN_END).toContain('其他');
  });
  test('tells Neo to add parallel running work with after: [] before binding', () => {
    expect(NEO_ROOT_TURN_END).toContain('so pass after: [] for parallel running work.');
  });
  test.each([
    { packs: [] },
    { packs: ['coding'] },
    { packs: ['life-admin'] },
    { packs: ['coding', 'life-admin'] },
  ])('delivered root and pack guidance use paths with $packs', ({ packs }) => {
    const prompt = neoPrompt(packs.length ? neoSettingsPackBriefs({ packs }) : []);
    expect(prompt).toContain('core.evidence {}');
    expect(prompt).toContain('absolute path on the owning daemon');
    expect(prompt).toContain('fixed-head Git');
    expect(prompt).not.toContain('{artifact:registeredArtifactId}');
    expect(prompt).not.toContain('saved registered confirmation');
    expect(prompt).toContain('owner_unavailable');
  });
  test.each([false, true])('limits worker messages with packs: %s', (enabled) => {
    const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
    expect(prompt).toContain(
      "work.start may reuse an existing idle worker of the same project; trust the receipt's ref."
    );
    expect(prompt).not.toContain('Give a new item to an idle worker');
    expect(prompt).not.toContain('project and a number');
    expect(prompt).not.toContain('never a task title');
    expect(prompt).not.toContain('work.rename');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('named for the project and a number');
    expect(prompt).toContain('Coordination questions');
    expect(prompt).toContain('never human cards');
    expect(prompt).toContain('Message Neo only at milestones');
    expect(prompt).toContain('PR opened, merged or closed; blocked; a question; done; failed');
    expect(prompt).toContain('no acknowledgments and no progress pings');
    expect(prompt).toContain('Never ask workers to confirm or acknowledge');
  });

  test('assembles core guidance with the short root, replacing the Claude Code preset', () => {
    expect(neoPrompt([]).startsWith(`${NEO_ROOT_PROMPT}\n\n${NEO_FOCUSED_DISCUSSION}\n\n`)).toBe(
      true
    );
    expect(neoPrompt([]).endsWith(NEO_ROOT_TURN_END)).toBe(true);
    expect(neoPrompt([])).not.toContain(NEO_GOAL_CYCLE);
    expect(neoPrompt([])).toContain('Your Bash commands are capped at 2 minutes');
    expect(NEO_ROOT_TURN_END).toContain('On a scheduled goal wake');
    expect(NEO_ROOT_TURN_END).toContain('On other turns');
    expect(NEO_ROOT_TURN_END).toContain('end the turn without text');
    expect(NEO_ROOT_TURN_END).toContain(
      'When you are waiting on something, end the turn; the event wakes you'
    );
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(340);
    expect(NEO_ROOT_PROMPT).toContain('neo.publication.publish');
    expect(NEO_ROOT_PROMPT).not.toContain('triggerId');
    for (const fact of ['work.find', 'work.send', 'neo.rule.save'])
      expect(NEO_ROOT_PROMPT).toContain(fact);
    expect(NEO_ROOT_PROMPT).not.toContain('Everything for the human goes through');
    expect(NEO_ROOT_PROMPT).not.toContain('Plain assistant text shows only');
  });

  test('delivers per-todo reminder guidance while retaining the short root', () => {
    const prompt = neoPrompt([]);
    expect(prompt).toContain('even when its ask has other work or open questions');
    expect(prompt).toContain('later reminders queue as fresh-turn input every two hours');
    expect(prompt).toContain('stopping after three consumed reminders');
  });

  test.each([false, true])('delivers completion guidance with packs: %s', (enabled) => {
    const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
    expect(prompt).toContain('Settle an ask done only after its todos finish.');
    expect(prompt).toContain(
      'For abandoned work, use dropped or remove individual todos with reasons.'
    );
    expect(prompt).toContain('An unfinished-todo refusal keeps the ask open.');
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

  test('handles direct human work as matter news without repeating the assignment', () => {
    const prompt = neoPrompt([]);
    for (const rule of [
      'the human worked directly in a worker',
      'record new work the human started as a todo on that ask',
      'Do not assign again',
      'stay quiet',
      'tools and access this instance actually has',
      'Follow the human preferences supplied by enabled packs',
      'concrete next step',
    ])
      expect(prompt).toContain(rule);
  });

  test('gives Neo the reply length rule the check enforces', () => {
    const rule =
      'Keep text to at most 5 lines including the title, about 60 words or 150 Chinese characters, and at most 500 characters. For anything longer, or for any structured report, multi-topic update, sectioned explanation, list, table or long report, put a standalone summary in text and details that add new information; never repeat text in details.';
    expect(neoToolDescription('neo.publication.publish')).toContain(rule);
    const prompt = neoPrompt([]);
    expect(prompt).not.toContain('a few bullets or a small comparison table');
    expect(prompt).not.toContain('keep detail in publication details');
    expect(prompt).not.toContain('Bold the key choice');
    expect(prompt).toContain('Preserve required proposal text, path and hash');
  });

  test('guides text-only deliverables next to the text and details rules', () => {
    const prompt = neoPrompt([]);
    expect(prompt).toContain(
      'Send deliverables the human will copy as text alone: translations, drafted emails/messages, text to paste'
    );
    expect(prompt).toContain('any lead-in line is a separate normal message or is skipped');
    expect(prompt).toContain('One message per deliverable');
    expect(prompt).toContain(
      'Publish each with deliverable: true; deliverables are exempt from the body length limit.'
    );
    expect(prompt).toContain(
      'Plain text for emails and translations; Markdown or code only when the human wants it'
    );
    expect(prompt).toContain('Anything over the text limit goes as a file');
  });

  test('appends the pack briefing only when packs are enabled', () => {
    const coding = neoPrompt(neoSettingsPackBriefs());
    expect(coding.startsWith(`${NEO_ROOT_PROMPT}\n\nDomain packs carry the field`)).toBe(true);
    expect(coding).not.toContain(NEO_PACK_CODING_INSTRUCTIONS);
    expect(coding).toContain('load its guidance skill: coding-pack.');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('never sleep or poll gh');
    expect(coding.trim().endsWith(NEO_ROOT_TURN_END.trim())).toBe(true);
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
