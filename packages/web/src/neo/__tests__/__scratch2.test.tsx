import { render, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { NeoPublicConversation } from '../NeoPublicConversation.tsx';

describe('scratch2', () => {
  it('dumps real projection', async () => {
    const conversationId = '10000000-0000-4000-8000-000000000001';
    const root = `neo:${conversationId}`;
    const original = { sessionId: root, messageId: 'original' };
    const md = '## Evidence\n\n| Source | Finding |\n| --- | --- |\n| A | Different |';
    const publication = {
      conversationId, publicationId: '20000000-0000-4000-8000-000000000001',
      askOrigin: original, producerInput: { sessionId: 'h', messageId: 'm' },
      shortText: md, fullText: md, links: [], sequence: 1, createdAt: '2026-09-30T12:00:01Z',
    };
    const { projectNeoPublicConversation } = await import('../public-conversation.ts');
    const conversation = projectNeoPublicConversation(root, {
      conversationId,
      asks: { state: 'ready', items: [], nextAfter: 1 },
      publications: { state: 'ready', items: [publication], nextAfter: 1 },
    } as never);
    console.log('ENTRIES:', JSON.stringify(conversation).slice(0, 300));
    const { container } = render(<NeoPublicConversation conversation={conversation} />);
    await new Promise((r) => setTimeout(r, 500));
    console.log('TABLES:', container.querySelectorAll('table').length);
    console.log('TEXT:', container.textContent?.slice(0, 200));
    expect(true).toBe(true);
  });
});
