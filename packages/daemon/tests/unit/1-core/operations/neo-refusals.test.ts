import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { explainNeoRefusal, NEO_REFUSALS } from '@hyperneo/shared/types/neo-refusals';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';

const NEO_SOURCE = join(import.meta.dirname, '../../../../src/lib/neo');
const REFUSAL_CODES = [
  /\b(?:ok|accepted):\s*false(?:\s+as\s+const)?,\s*reason:\s*'([a-z][a-z0-9_]*)'(?!,\s*detail:)/g,
  /\b(?:fail|refuse|reject)\('([a-z][a-z0-9_]*)'(?!,\s*['`])/g,
  /\.reason\s*\?\?\s*'([a-z][a-z0-9_]*)'/g,
];

function neoRefusalCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of readdirSync(NEO_SOURCE, { recursive: true }) as string[]) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(NEO_SOURCE, file), 'utf8');
    for (const pattern of REFUSAL_CODES)
      for (const match of source.matchAll(pattern)) codes.add(match[1]);
  }
  return codes;
}

describe('explainNeoRefusal', () => {
  test.each([
    'speech_backend_not_configured',
    'speech_backend_unavailable',
    'invalid_speech_backend',
  ])('explains the speech catalog rejection %s', (reason) => {
    expect(explainNeoRefusal({ ok: false, reason })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(new RegExp(`^${reason}: .+`)),
    });
  });

  test('turns a bare refusal code into the code, why, and what would pass', () => {
    expect(explainNeoRefusal({ ok: false, reason: 'work_not_found' })).toEqual({
      ok: false,
      reason: `work_not_found: ${NEO_REFUSALS.work_not_found}`,
    });
    expect(
      explainNeoRefusal({ accepted: false, reason: 'edit_unchanged', publicationId: 'p1' })
    ).toEqual({
      accepted: false,
      reason: `edit_unchanged: ${NEO_REFUSALS.edit_unchanged}`,
      publicationId: 'p1',
    });
  });

  test('leaves successes, already explained refusals and unknown codes as they are', () => {
    for (const value of [
      { ok: true, reason: 'ask_not_found' },
      { ok: false, reason: 'delivers_unknown: i9 is not an open item on this ask.' },
      { ok: false, reason: 'no_news', detail: 'Speak when there is something new.' },
      { ok: false, reason: 'some_other_code' },
      { ok: false, reason: 'toString' },
      null,
      'ask_not_found',
    ])
      expect(explainNeoRefusal(value)).toBe(value);
  });
});

describe('NEO_REFUSALS', () => {
  test('explains every bare refusal code a Neo gate returns', () => {
    expect([...neoRefusalCodes()].filter((code) => !Object.hasOwn(NEO_REFUSALS, code))).toEqual([]);
  });
});

describe('createOperationMcpHandler', () => {
  test('explains a Neo operation’s refusal for the agent and leaves other operations bare', async () => {
    const refusing = (name: string) =>
      defineOperation({
        name,
        description: name,
        inputSchema: z.object({}),
        resultSchema: z.object({ ok: z.literal(false), reason: z.string() }),
        execute: async () => ({ ok: false as const, reason: 'work_not_found' }),
      });
    const handle = createOperationMcpHandler(
      createOperationRegistry([refusing('neo.work.close'), refusing('task.close')]),
      () => ({ sessionId: 's1' })
    );
    const reason = async (name: string) =>
      JSON.parse((await handle({ name, input: {} })).content[0].text).reason;
    expect(await reason('neo.work.close')).toBe(`work_not_found: ${NEO_REFUSALS.work_not_found}`);
    expect(await reason('task.close')).toBe('work_not_found');
  });
});
