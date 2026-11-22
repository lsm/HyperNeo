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
import {
  NEO_DELIVERABLE_CHAR_LIMIT,
  NEO_REPLY_CHAR_LIMIT,
  NEO_REPLY_WORD_LIMIT,
} from '@hyperneo/shared/types/neo-publication';
import { neoSettingsPackBriefs } from '../../../../src/lib/neo/packs/index.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('root Neo system prompt', () => {
  test('never points Neo at a [message id: …] line the intake no longer writes', () => {
    for (const text of [
      neoPrompt([]),
      neoPrompt(neoSettingsPackBriefs()),
      neoToolDescription('neo.rule.save'),
    ])
      expect(text).not.toContain('[message id');
    expect(neoPrompt([])).toContain('<human-message');
  });
  test('adds every ask step with after before the first starts', () => {
    expect(NEO_ROOT_PROMPT).toContain(
      'Add all ask steps as todos, each with after, before the first starts.'
    );
  });
  test.each([false, true])(
    'delivers follow-up input binding guidance with packs: %s',
    (enabled) => {
      const prompt = neoPrompt(enabled ? neoSettingsPackBriefs() : []);
      expect(prompt).toContain('pass input for a human request');
      expect(prompt).toContain('For a plain follow-up to an open ask you own, also pass its askId');
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
      'Answer it yourself when the plan, saved rules or your authority settle it. Otherwise use neo.question.ask with kind relay.'
    );
  });
  test('tells Neo a next-step wake is its own to resolve and how to ask the human', () => {
    for (const line of [
      'resolving it is yours, not the human’s',
      'Run a step the human already authorized',
      'Ask with neo.question.ask only when the step needs new authority from the human or you cannot tell',
      'If the human says a step must wait, use neo.todo.hold',
      'For an overdue check, ask whoever it waits on, mark it done or remove it; if the wait is still right, do nothing',
    ])
      expect(NEO_ROOT_TURN_END).toContain(line);
    expect(NEO_ROOT_TURN_END).not.toContain(
      'Act on it, ask the human, or hold it with neo.todo.hold'
    );
    expect(NEO_ROOT_TURN_END).not.toContain('Not yet');
    expect(neoToolDescription('neo.question.ask')).toContain('omit catch-all and defer options');
  });

  test('tells Neo a topic is a lasting area reused from the topic list', () => {
    expect(NEO_ROOT_TURN_END).toContain('neo.ask.topic');
    expect(NEO_ROOT_TURN_END).toContain("a lasting topic in the human's language");
    expect(NEO_ROOT_TURN_END).toContain('up to 12 display cells');
    expect(NEO_ROOT_TURN_END).toContain('Count CJK, fullwidth characters and emoji as two cells.');
    expect(NEO_ROOT_TURN_END).toContain('reuse a topic from the topic list');
    expect(NEO_ROOT_TURN_END).toContain('其他');
  });
  test('non-Neo proposal callers still get topic guidance', () => {
    expect(neoToolDescription('neo.ask.propose')).toContain('topic names a lasting area');
  });
  test('neo.topic.merge tells Neo it rewrites the pick on every ask and leaves project topics', () => {
    expect(neoToolDescription('neo.topic.merge')).toContain('every ask, open or settled');
    expect(neoToolDescription('neo.topic.merge')).toContain('Project topics are never rewritten');
  });
  test('tells Neo to bind parallel running work with after: []', () => {
    expect(neoToolDescription('neo.todo.add')).toContain(
      'satisfied prerequisites (after: [] if parallel)'
    );
  });
  test.each([
    { packs: [] },
    { packs: ['coding'] },
    { packs: ['life-admin'] },
    { packs: ['coding', 'life-admin'] },
  ])('delivered root and pack guidance use paths with $packs', ({ packs }) => {
    const prompt = neoPrompt(packs.length ? neoSettingsPackBriefs({ packs }) : []);
    expect(prompt).toContain('Store non-coding core.evidence files at persistent visible paths.');
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
    expect(NEO_ROOT_TURN_END).toContain('never summarize the turn');
    expect(NEO_ROOT_TURN_END).toContain(
      'When you are waiting on something, end the turn; the event wakes you'
    );
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(350);
    expect(NEO_ROOT_PROMPT).toContain('talking with the human, coordinating work');
    expect(NEO_ROOT_PROMPT).toContain('current across restarts');
    expect(NEO_ROOT_PROMPT).toContain('A `<session-message>` is not human');
    expect(NEO_ROOT_PROMPT).toContain('Keep workers in their own project');
    expect(NEO_ROOT_PROMPT).toContain('follow the naming rule in neo.todo.add');
    expect(NEO_ROOT_TURN_END).toContain('neo.publication.publish');
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

  test('settle keeps unfinished asks open', () => {
    const settle = neoToolDescription('neo.ask.settle');
    expect(settle).toContain('while todos are unfinished (the ask stays open)');
    expect(settle).toContain('remove them with reasons');
    expect(settle).toContain('dropped when abandoning the request');
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
        'itineraries',
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

  test('states the reply length rule once, in the publish description', () => {
    const prompt = neoPrompt([]);
    const publish = neoToolDescription('neo.publication.publish');
    expect(publish).toContain('Deliver one matter per message');
    expect(publish).toContain(
      'a short bold title line that states the conclusion or decision, then a few bullets or a small table; bold the key choice'
    );
    expect(publish).toContain(`Write at most ${NEO_REPLY_WORD_LIMIT} words`);
    expect(publish).toContain(`The server refuses text over ${NEO_REPLY_CHAR_LIMIT} characters.`);
    expect(publish).not.toContain('5 lines');
    expect(publish).not.toContain('one-sentence summary');
    expect(publish).toContain(`at most ${NEO_DELIVERABLE_CHAR_LIMIT} characters`);
    for (const stale of [
      'a few bullets or a small comparison table',
      'Bold the key choice',
      'Avoid walls of text',
      'keep detail in publication details',
    ])
      expect(prompt).not.toContain(stale);
    expect(neoToolDescription('neo.question.ask')).toContain(
      'exact path and 64-character lowercase hash'
    );
  });

  test('keeps copyable deliverables separate from normal reply limits', () => {
    const publish = neoToolDescription('neo.publication.publish');
    expect(publish).toContain('deliverable:true with no details');
    expect(publish).toContain('exempt from the reply limit');
    expect(publish).toContain('resend the whole text for revisions');
    expect(publish).toContain('Put any lead-in in a separate normal message or omit it');
    expect(neoPrompt([])).not.toContain('deliverable:true');
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
