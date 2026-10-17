import { describe, expect, test } from 'bun:test';
import { NEO_SPEAKING_POLICY } from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('Neo speaking context', () => {
  test.each([null, 'mixed-name-project'])(
    'keeps human answers and event silence distinct for %j',
    (projectId) => {
      const prompt = neoPrompt(projectId);
      expect(prompt).toContain(NEO_SPEAKING_POLICY);
      expect(prompt).toContain('Answer every direct human question');
      expect(prompt).toContain('On event wakes, stay silent unless');
      expect(prompt).not.toContain('Always answer in Chinese');
      expect(prompt).not.toContain('Always answer in English');
      expect(prompt).not.toContain('one or two conversational sentences');
      expect(prompt).not.toContain('A refused publication says why; end the turn');
    }
  );

  test('retains root and holder context boundaries', () => {
    expect(neoPrompt(null)).toContain('Detailed context belongs to the holder');
    expect(neoPrompt(null)).toContain('Empty redacted context, instruction or report fields');
    const holder = neoPrompt('mixed-name-project');
    expect(holder).toContain('context holder for project "mixed-name-project"');
    expect(holder).toContain(
      "When a request spans projects, handle this project's part and open an ask in each other project"
    );
    expect(holder).toContain('NEVER execute worker jobs directly');
  });
});
