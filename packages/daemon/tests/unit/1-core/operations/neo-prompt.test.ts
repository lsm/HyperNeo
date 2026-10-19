import { describe, expect, test } from 'bun:test';
import type { HookInput, Options } from '@anthropic-ai/claude-agent-sdk';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_ROOT_PROMPT,
  NEO_ROOT_TURN_END,
} from '@hyperneo/prompts';
import { OPERATION_NAMES } from '@hyperneo/shared/types/operation-names';
import { FindWorkResultSchema } from '../../../../src/lib/drivers/find-operation.ts';
import { ReadWorkInputSchema } from '../../../../src/lib/drivers/read-operation.ts';
import { WorkSummarySchema } from '../../../../src/lib/drivers/types.ts';
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
  test('is the short coordinator text alone, replacing the Claude Code preset', () => {
    const options: Options = {};
    restrictNeoQuery(options, undefined, []);
    expect(options.systemPrompt).toEqual({
      type: 'custom',
      prompt: `${NEO_ROOT_PROMPT}\n\n${NEO_ROOT_TURN_END}`,
      snapshot: false,
    });
    expect(neoPrompt([])).toBe(`${NEO_ROOT_PROMPT}\n\n${NEO_ROOT_TURN_END}`);
    expect(NEO_ROOT_TURN_END.trim()).toBe(
      'End every turn with exactly one line: Done. No summary.'
    );
    expect(NEO_ROOT_PROMPT.split(/\s+/).length).toBeLessThan(160);
    for (const fact of [
      'work.find',
      'work.send',
      'neo.publication.publish',
      'neo.question.ask',
      'neo.rule.save',
      'Plain assistant text is never shown to the human.',
    ])
      expect(NEO_ROOT_PROMPT).toContain(fact);
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
