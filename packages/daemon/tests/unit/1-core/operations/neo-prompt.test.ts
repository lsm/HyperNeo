import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_GOAL_CYCLE,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
} from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import {
  neoCoordinatorAllowedTools,
  neoCoordinatorDeniedReads,
  neoCoordinatorNativeTools,
  restrictNeoQuery,
} from '../../../../src/lib/neo/session-policy.ts';

const NEO_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Bash',
];

describe('Neo native tools without command parsing', () => {
  test('adds no PreToolUse hook to an unrestricted native tool request', () => {
    const options: Options = {};
    restrictNeoQuery(options, undefined, []);
    expect(options.hooks).toBeUndefined();
    expect(options.allowedTools).toContain('Bash');
    expect(options.disallowedTools).toEqual(neoCoordinatorDeniedReads());
  });

  test('preserves existing hooks without injecting a command gate', () => {
    const hooks: NonNullable<Options['hooks']> = {
      PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({})] }],
      PostToolUse: [{ hooks: [async () => ({})] }],
    };
    const options: Options = { hooks };
    restrictNeoQuery(options, undefined, []);
    expect(options.hooks).toBe(hooks);
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(options.hooks?.PostToolUse).toBe(hooks.PostToolUse);
  });
});

describe('restrictNeoQuery attribution', () => {
  test('gives Neo empty commit and PR attribution, so the CLI adds no attribution reminder', () => {
    const options: Options = { settings: { cleanupPeriodDays: 30 } };
    restrictNeoQuery(options);
    expect(options.settings).toEqual({
      cleanupPeriodDays: 30,
      attribution: { commit: '', pr: '' },
    });
  });
});

describe('root Neo system prompt', () => {
  test('assembles core guidance with the short root, replacing the Claude Code preset', () => {
    const options: Options = {};
    restrictNeoQuery(options, undefined, []);
    expect(options.systemPrompt).toEqual({
      type: 'custom',
      prompt: `${NEO_ROOT_PROMPT}\n\n${NEO_GOAL_CYCLE}\n\n${NEO_ROOT_TURN_END}`,
      snapshot: false,
    });
    expect(neoPrompt([])).toBe(`${NEO_ROOT_PROMPT}\n\n${NEO_GOAL_CYCLE}\n\n${NEO_ROOT_TURN_END}`);
    expect(NEO_ROOT_TURN_END).toContain('On a scheduled goal wake');
    expect(NEO_ROOT_TURN_END).toContain('On other turns');
    expect(NEO_ROOT_TURN_END).toContain('end the turn without text');
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(160);
    expect(NEO_ROOT_PROMPT).toContain('<human-input>');
    expect(NEO_ROOT_PROMPT).toContain('triggerId');
    for (const fact of ['work.find', 'work.send', 'neo.rule.save'])
      expect(NEO_ROOT_PROMPT).toContain(fact);
    expect(NEO_ROOT_PROMPT).not.toContain('Everything for the human goes through');
    expect(NEO_ROOT_PROMPT).not.toContain('Plain assistant text shows only');
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
    const coding = neoPrompt();
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

describe('neoCoordinatorNativeTools', () => {
  test('gives every Neo session the same tools and no SDK question tool', () => {
    expect(neoCoordinatorNativeTools()).toEqual(NEO_TOOLS);
    expect(neoCoordinatorNativeTools()).not.toContain('AskUserQuestion');
  });
});

describe('neoCoordinatorAllowedTools', () => {
  test('approves whole tools for root and topic alike, leaving the line to the guard', () => {
    expect(neoCoordinatorAllowedTools()).toEqual([
      ...NEO_TOOLS,
      'mcp__hyperneo-operations__invoke',
    ]);
    expect(neoCoordinatorAllowedTools().some((tool) => tool.startsWith('Bash('))).toBe(false);
  });
});

describe('neoCoordinatorDeniedReads', () => {
  test('blocks credentials, shell profiles, env files and the daemon data folder', () => {
    expect(neoCoordinatorDeniedReads()).toEqual(
      expect.arrayContaining([
        'Read(~/.ssh/**)',
        'Read(~/.claude/.credentials.json)',
        'Read(~/.zshrc)',
        'Read(~/**/.env)',
      ])
    );
  });

  test('restricted Neo queries carry the denials and the look-up guard first', () => {
    const options: Options = { disallowedTools: ['Task'] };
    restrictNeoQuery(options);
    expect(options.disallowedTools).toEqual(['Task', ...neoCoordinatorDeniedReads()]);
    expect(options.hooks?.PreToolUse?.[0]?.matcher).toBeUndefined();
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });
});
