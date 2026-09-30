import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { NeoPublicationSchema } from '../../../../src/lib/neo/publication.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { restrictNeoQuery } from '../../../../src/lib/neo/session-policy.ts';

const draft = { shortText: 'Draft only.', fullText: 'Detail behind it.', links: [] };

function options(): Options {
  return {
    systemPrompt: 'Legacy stored coordinator wording',
    model: 'fixture-model',
    maxTurns: 17,
    mcpServers: { 'hyperneo-operations': { type: 'stdio', command: 'fixture-operations' } },
  };
}
function delivered(concernId: string | null): string {
  const query = options();
  restrictNeoQuery(query, concernId);
  return (query.systemPrompt as { prompt: string }).prompt;
}

describe('direct human publication prompt', () => {
  test.each([null, 'research'])('reaches the real %s coordinator options', (concernId) => {
    const query = options();
    restrictNeoQuery(query, concernId);
    expect(query.systemPrompt).toEqual({
      type: 'custom',
      prompt: neoPrompt(concernId),
      snapshot: false,
    });
    const prompt = (query.systemPrompt as { prompt: string }).prompt;
    expect(prompt).toContain('neo.publication.publish');
    expect(prompt).not.toContain('Legacy stored coordinator wording');
    expect(prompt).toContain('Reuse operations.describe for the exact schema');
  });

  test.each([null, 'research'])(
    'keeps existing %s model, tool and MCP policy intact',
    (concernId) => {
      const query = options();
      restrictNeoQuery(query, concernId);
      const operations = { type: 'stdio' as const, command: 'fixture-operations' };
      expect(query.model).toBe('fixture-model');
      expect(query.maxTurns).toBe(17);
      expect(query.tools).toEqual(concernId ? ['AskUserQuestion'] : []);
      expect(query.mcpServers).toEqual({ 'hyperneo-operations': operations });
      expect(query.allowedTools).toEqual([
        ...(concernId ? ['AskUserQuestion'] : []),
        'mcp__hyperneo-operations__invoke',
      ]);
      expect(query.settingSources).toEqual([]);
      expect(query.plugins).toEqual([]);
      expect(query.agents).toEqual({});
    }
  );

  test.each([null, 'research'])('supplies the four authored keys jointly for %s', (concernId) => {
    const prompt = delivered(concernId);
    expect(prompt).toContain('neo.publication.publish {publicationId, shortText, fullText, links}');
    const accepted = NeoPublicationSchema.pick({
      publicationId: true,
      shortText: true,
      fullText: true,
      links: true,
    }).parse({ ...draft, publicationId: '30000000-0000-4000-8000-000000000001' });
    for (const key of ['publicationId', 'shortText', 'fullText', 'links']) {
      expect(prompt).toContain(key);
      expect(accepted).toHaveProperty(key);
    }
  });

  test.each([null, 'research'])('requires one call before the turn ends for %s', (concernId) => {
    expect(delivered(concernId)).toContain(
      'publish that answer with neo.publication.publish {publicationId, shortText, fullText, links} in one call before ending the turn'
    );
  });

  test.each([null, 'research'])(
    'keeps the authored short reply and full detail in the same reasoning pass for %s',
    (concernId) => {
      const prompt = delivered(concernId);
      expect(prompt).toContain(
        'Use the useful short reply and full detail from the reasoning pass you are already doing'
      );
      expect(prompt).toContain('no second model pass');
      expect(prompt).toContain('no separate re-summary step');
      expect(prompt).toContain('the labelled Neo scene references');
    }
  );

  test.each([null, 'research'])(
    'restricts publication to identical retries for %s',
    (concernId) => {
      const prompt = delivered(concernId);
      expect(prompt).toContain('Give publicationId a fresh UUID');
      expect(prompt).toContain(
        'reuse that same publicationId with the same authored payload only to retry an identical publication'
      );
    }
  );

  test.each([null, 'research'])(
    'derives identity at runtime and never flags authority for %s',
    (concernId) => {
      const prompt = delivered(concernId);
      expect(prompt).toContain(
        'The runtime derives the conversation, the original ask and the producer from live evidence'
      );
      expect(prompt).toContain('never pass or invent those');
      expect(prompt).toContain('never supply an approval or authority flag');
      const { conversationId, askOrigin, producerInput } = NeoPublicationSchema.shape;
      expect(conversationId).toBeDefined();
      expect(askOrigin).toBeDefined();
      expect(producerInput).toBeDefined();
    }
  );

  test('keeps an actual holder origin distinct from root', () => {
    const holder = delivered('research');
    expect(holder).toContain('your own origin is your actual session');
    expect(holder).toContain('do not present yourself as root');
    expect(holder).toContain('you are a context holder');
    expect(delivered(null)).toContain('the current input is a human message in this conversation');
  });

  test.each([null, 'research'])('links only inspected in-scope Neo ids for %s', (concernId) => {
    const prompt = delivered(concernId);
    expect(prompt).toContain(
      'Link only concern, work or consultation ids you actually inspected for this answer'
    );
    expect(prompt).toContain('keep each label to the user');
    expect(prompt).toContain('Never put a filesystem path, a private resource');
    expect(NeoPublicationSchema.shape.links).toBeDefined();
  });

  test.each([null, 'research'])('excludes internal and non-human inputs for %s', (concernId) => {
    const prompt = delivered(concernId);
    expect(prompt).toContain(
      'Do not publish internal compaction, tool chatter, system deliveries or any input that is not a direct human message'
    );
    expect(prompt).toContain('not a consultation request from Neo');
    expect(prompt).toContain('not a returned work or consultation result');
  });

  test.each([null, 'research'])(
    'treats a rejected publication as a real failure for %s',
    (concernId) => {
      const prompt = delivered(concernId);
      expect(prompt).toContain('A rejected publication is a real failure to fix and retry');
      expect(prompt).toContain('never a reply you may instead claim was recorded');
      expect(prompt).toContain('never a publication you may fabricate');
    }
  );

  test('does not instruct consultation or returned-result turns to publish the same answer', () => {
    const holder = delivered('research');
    expect(holder).toContain(
      'For every consultation request, return the answer with neo.concern.respond before ending your turn'
    );
    expect(holder).toContain('Ordinary assistant text alone does not return an answer to Neo');
    const root = delivered(null);
    expect(root).toContain(
      'This rule does not apply to a returned consultation answer: synthesize that answer and stop'
    );
    expect(root).toContain('consult its holder before giving the substantive answer');
  });

  test('preserves the pinned consultation, context, discovery and execution-approval text', () => {
    const root = delivered(null);
    const holder = delivered('research');
    expect(root).toContain('Detailed context belongs to the holder');
    expect(root).toContain('consult its holder before giving the substantive answer');
    expect(root).toContain('Ask clarification questions in ordinary conversational text');
    expect(root).toContain('Do not ask for that permission again');
    expect(holder).toContain('context holder (分身) for concern "research"');
    expect(holder).toContain('Use the consultationId from that request, not a work id');
    expect(holder).toContain('If a save is rejected as superseded, do not reread and retry it');
    expect(holder).toContain('Do not call AskUserQuestion during a consultation');
    for (const prompt of [root, holder]) {
      expect(prompt).toContain(
        'Inspect existing execution resources through their discovered read operations'
      );
      expect(prompt).toContain('the Start work button is the approval to execute');
      expect(prompt).toContain('Do not use other operations to bypass the existing human approval');
    }
  });
});
