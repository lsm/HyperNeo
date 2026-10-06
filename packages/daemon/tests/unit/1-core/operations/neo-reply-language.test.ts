import { describe, expect, test } from 'bun:test';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';

describe('Neo reply language guidance', () => {
  test.each([null, 'mixed-name-concern'])(
    'rendered prompt keeps human language distinct from names for %j',
    (concernId) => {
      const prompt = neoPrompt(concernId);
      expect(prompt).toContain("Choose the reply language from the human question's phrasing");
      expect(prompt).toContain('not its project\nnames, tool names, or these English instructions');
      expect(prompt).toContain('This also applies to a brief\nacknowledgement');
      expect(prompt).toContain(
        "use the originating human ask's\nlanguage, not the latest unrelated ask"
      );
      expect(prompt).toContain('An explicitly requested output language\ntakes precedence');
      expect(prompt).toContain('not prescribed wording or fixed modes');
      expect(prompt).not.toContain('Always answer in Chinese');
      expect(prompt).not.toContain('Always answer in English');
    }
  );

  test('language refinement preserves the different root and holder roles', () => {
    const root = neoPrompt(null);
    const holder = neoPrompt('mixed-name-concern');
    expect(root).toContain('Native question cards are not available to root Neo');
    expect(root).toContain('A new message is NOT a new concern');
    expect(holder).toContain('You are the context holder for concern');
    expect(holder).toContain('never mention concerns, topics, holders, the inbox or your role');
    expect(holder).toContain("Reply in the language of the user's latest message.");
    expect(holder).not.toContain('分身');
    expect(holder).toContain('You cannot consult other holders');
    for (const prompt of [root, holder]) {
      expect(prompt).toContain('Respond to the current input, not the whole visible backlog');
      expect(prompt).toContain('one or two conversational sentences');
      expect(prompt).toContain('You and the concern holders NEVER execute worker jobs directly');
    }
  });
});
