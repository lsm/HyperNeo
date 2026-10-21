import { describe, expect, test } from 'bun:test';
import {
  createNeoPublicationOperation,
  createNeoPublisher,
  requireShortTextCoversTopics,
} from '../../../../src/lib/neo/publication-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';

const INCIDENT = {
  requestId: 'bundled',
  shortText: 'environments can only be created by you in Desktop',
  fullText: [
    '**Claude Desktop 环境**：查清楚了，环境只能由你在 Desktop 里新建，我这边建不了。',
    '',
    '**qlark 长听写开关**：按你说的做了，长听写现在默认关闭，设置里可以打开。',
  ].join('\n'),
  links: [],
};

const untouched = new Proxy({} as Parameters<typeof createNeoPublisher>[0], {
  get: (_target, name) => () => {
    throw new Error(`a refused publication reached the runtime (${String(name)})`);
  },
});

const covered = (shortText: string, fullText: string) =>
  'value' in requireShortTextCoversTopics({ ...INCIDENT, shortText, fullText });

describe('neo.publication.publish keeps one topic per short line', () => {
  test('refuses the incident: two inline-labelled topics under a short line naming one', async () => {
    const result = await invokeOperation(
      createOperationRegistry([createNeoPublicationOperation(createNeoPublisher(untouched))]),
      'neo.publication.publish',
      INCIDENT,
      { source: 'mcp', sessionId: 'neo:x', role: 'neo' }
    );
    expect(result).toMatchObject({
      value: { accepted: false, reason: 'multiple_topics' },
    });
    const detail = (result as { value: { detail: string } }).value.detail;
    expect(detail).toContain('Claude Desktop 环境');
    expect(detail).toContain('qlark 长听写开关');
    expect(detail).toContain('publish each topic separately');
  });

  test('accepts the same details once the short line names every topic, in any case', () => {
    expect(
      covered(
        'claude desktop 环境 needs you; QLARK 长听写开关 is off by default',
        INCIDENT.fullText
      )
    ).toBe(true);
  });

  test('a single topic, however it is labelled, needs no more of the short line', () => {
    expect(covered('Done.', '**Claude Desktop 环境**：查清楚了。')).toBe(true);
    expect(covered('Done.', '## Result\n\nAll green.')).toBe(true);
  });

  test('headings and bold-only lines count as topic labels too', () => {
    expect(covered('Deploy', '## Deploy\n\nshipped\n\n## Billing\n\nfixed')).toBe(false);
    expect(covered('Deploy', '**Deploy**\nshipped\n\n**Billing:**\nfixed')).toBe(false);
  });

  test('bold inside a sentence, a list item or a code block is not a topic label', () => {
    const fullText = [
      'The **deploy** went out and **billing** is unchanged.',
      '- **Step one**: build',
      '- **Step two**: ship',
      '```',
      '**Not a label**: code',
      '```',
      '**Two differences** need a closer look.',
    ].join('\n');
    expect(covered('Deployed.', fullText)).toBe(true);
  });
});
