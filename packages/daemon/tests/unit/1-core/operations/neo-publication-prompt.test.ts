import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { NEO_SPEAKING_POLICY } from '@hyperneo/prompts';
import { NeoPublicationSchema } from '../../../../src/lib/neo/publication.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import {
  neoCoordinatorAllowedTools,
  restrictNeoQuery,
} from '../../../../src/lib/neo/session-policy.ts';

const policy = [
  'Answer every direct human question; wait for needed facts or ask for genuinely missing information.',
  'Say what helps the human act or understand the result, using the conversation and current facts to avoid repetition.',
  'On event wakes, stay silent unless there is something useful to tell the human.',
].join('\n');

describe('Neo speaking policy delivery', () => {
  test('loads the approved three lines as authored text', () => {
    expect(NEO_SPEAKING_POLICY).toBe(policy);
  });

  test.each([null, 'research'])(
    'reaches the actual %s coordinator query without a second speaking protocol',
    (projectId) => {
      const options: Options = { systemPrompt: 'Stored old protocol', model: 'fixture-model' };
      restrictNeoQuery(options, projectId);
      const prompt = (options.systemPrompt as { prompt: string }).prompt;
      expect(prompt).toBe(neoPrompt(projectId));
      expect(prompt.split(policy)).toHaveLength(2);
      expect(prompt).not.toContain('Stored old protocol');
      expect(prompt).not.toContain('there are no interim or status posts');
      expect(prompt).not.toContain('Then answer the human');
      expect(prompt).not.toContain('A wrong fact is never fixed by an edit');
      expect(prompt).not.toContain('neo.publication.correct');
      expect(options.model).toBe('fixture-model');
      expect(options.allowedTools).toEqual(neoCoordinatorAllowedTools());
    }
  );

  test.each([null, 'research'])(
    'documents message delivery and revisions with request identity for %s',
    (projectId) => {
      const prompt = neoPrompt(projectId);
      expect(prompt).toContain('ordinary assistant text is internal');
      expect(prompt).toContain('neo.publication.publish {requestId,shortText,fullText,links}');
      expect(prompt).toContain(
        'neo.publication.edit {publicationId,requestId,shortText?,fullText?}'
      );
      expect(prompt).toContain('a retry reuses it');
      expect(prompt).toContain('revision history remain');
      expect(
        NeoPublicationSchema.pick({ shortText: true, fullText: true, links: true }).safeParse({
          shortText: 'e7ceb7be9',
          fullText: 'e7ceb7be9',
          links: [],
        }).success
      ).toBe(true);
    }
  );
});
