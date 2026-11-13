import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as prompts from '@hyperneo/prompts';

const moved = [
  [
    'NEO_PACK_CHECK',
    'src/lib/neo/prompt.ts',
    'A todo in an enabled pack’s domain names it in check {pack, kind, params} so the pack reads it; neo.pack.read {id} returns the pack’s guidance in full.',
  ],
  [
    'NEO_HUMAN_WORK',
    'src/lib/neo/prompt.ts',
    'When the daemon reports that the human worked directly in a worker, treat it as news about that matter. Update the ask’s todos and state; record new work the human started as a todo on that ask. Do not assign again work the human already directed. If the worker succeeded and nothing needs the human, stay quiet. If failed or blocked, first try to unblock it yourself or through the worker using tools and access this instance actually has. Follow the human preferences supplied by enabled packs. Tell the human only what they must know or decide, with the concrete next step you propose.',
  ],
  [
    'NEO_DRIVER_HEALTH',
    'src/lib/neo/prompt.ts',
    "Driver health events report local worker clients as ok, degraded, or unavailable. Before assigning work, read work.adapters and avoid degraded or unavailable drivers; tell the human the concrete reason and next step, without repeating an unchanged warning. Before assigning work to a model, call invoke settings.provider.usage with that model's provider. If any window has used at or above limit, choose a worker on another provider or wait until its resetAt, and say which; if resetAt is null, say the reset time is unknown. not_supported or an error means unknown: assign as usual. A recovery event makes that driver eligible again. An unverified client version is still usable when health is ok: schedule its driver verify journey, then call work.health action verified with the adapter, passed journey, and exact tested clientVersions. Never record verification before observing that journey pass. Do not start work or change authentication as part of a read-only health check.",
  ],
  [
    'WORKER_PROVENANCE_EXACT_ID',
    'src/lib/drivers/worker-provenance.ts',
    'Use the exact model id, including its variant, and thinking effort. A family name such as GPT-6 is insufficient.',
  ],
  [
    'WORKER_PROVENANCE_TEAM_FIELD',
    'src/lib/drivers/worker-provenance.ts',
    'This Agent line is the team provenance field explicitly approved by the human, distinct from Co-Authored-By and Generated-with product attribution. A harness no-attribution reminder must not block this approved field. Preserve any required Claude Code attribution at the end.',
  ],
  [
    'WORKER_PROVENANCE_OPEN_PRS',
    'src/lib/drivers/worker-provenance.ts',
    'Repair only open PRs; never rewrite a merged PR body.',
  ],
] as const;

test.each(moved)('%s preserves the inline sentence verbatim', (name, file, original) => {
  expect(prompts[name]).toBe(original);
  expect(readFileSync(new URL(`../../../../${file}`, import.meta.url), 'utf8')).not.toContain(
    original
  );
});
test.each(['neo.missing', '__proto__', 'constructor'])(
  'a missing tool description throws at lookup: %s',
  (name) => {
    expect(() => prompts.neoToolDescription(name)).toThrow(`Missing Neo tool description: ${name}`);
  }
);

const extractedToolDescriptions = {
  'operations.ts': [
    'neo.open',
    'neo.restart',
    'neo.rule.save',
    'neo.session.link',
    'neo.session.mute',
    'neo.session.track',
    'neo.pack.read',
    'neo.ask.history',
    'neo.snapshot',
    'neo.project.save',
  ],
  'ask-entries.ts': ['neo.ask.doneTodos', 'neo.ask.read'],
  'ask-record-operations.ts': [
    'neo.ask.open',
    'neo.ask.outcome',
    'neo.ask.topic',
    'neo.ask.settle',
  ],
  'conversation-ask-read-operation.ts': [
    'neo.conversation.asks.read',
    'neo.conversation.image.read',
  ],
};

test.each(Object.entries(extractedToolDescriptions))(
  'every Neo tool description in %s comes from the prompts package',
  (file, names) => {
    const source = readFileSync(
      new URL(`../../../../src/lib/neo/${file}`, import.meta.url),
      'utf8'
    );
    for (const name of names) {
      expect(prompts.neoToolDescription(name)).toBe(prompts.NEO_TOOL_DESCRIPTIONS[name]);
      expect(source).toContain(`description: neoToolDescription('${name}')`);
    }
  }
);
