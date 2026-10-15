import { describe, expect, mock, test } from 'bun:test';
import type { NeoPublicationInput } from '@hyperneo/shared/types/neo-publication';
import { createNeoPublicationCommit } from '../../../../src/lib/neo/publication-commit.ts';
import {
  neoNamesLanguage,
  planPublicationLanguage,
} from '../../../../src/lib/neo/publication-language.ts';

const post = (shortText: string): NeoPublicationInput => ({
  conversationId: '10000000-0000-4000-8000-000000000001',
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: { sessionId: 'root', messageId: 'h1' },
  producerInput: { sessionId: 'root', messageId: 'h1' },
  shortText,
  fullText: shortText,
  links: [],
});

describe('planPublicationLanguage', () => {
  const english = 'Which cards are running right now?';
  test('flags only a confident mismatch between named languages', () => {
    expect(planPublicationLanguage(post('现在有一张卡片在运行。'), english)).toEqual({
      expected: 'English',
      published: 'Chinese',
    });
    expect(planPublicationLanguage(post('One card is running now.'), english)).toBeNull();
    expect(planPublicationLanguage(post('现在有一张卡片在运行。'), null)).toBeNull();
    expect(
      planPublicationLanguage(post('Une carte est en cours.'), 'Bonjour, quelles cartes tournent?')
    ).toBeNull();
  });

  test.each([
    ['English that asks for Chinese', 'Which cards are running? Answer in Chinese please.'],
    ['English that names 中文', 'Which cards are running? Reply in 中文.'],
  ])('honors requestedLanguage when the human’s message asks for it: %s', (_label, human) => {
    expect(
      planPublicationLanguage(
        { ...post('现在有一张卡片在运行。'), requestedLanguage: 'Chinese' },
        human
      )
    ).toBeNull();
  });

  test('refuses requestedLanguage the human never asked for', () => {
    expect(
      planPublicationLanguage(
        { ...post('现在有一张卡片在运行。'), requestedLanguage: 'Chinese' },
        english
      )
    ).toEqual({ expected: 'English', published: 'Chinese', unrequested: true });
  });
});

describe('neoNamesLanguage', () => {
  test.each([
    ['Answer in Chinese please.', 'Chinese', true],
    ['用英文回答', 'English', true],
    ['日本語で答えて', 'Japanese', true],
    ['Which cards are running?', 'Chinese', false],
  ] as const)('%s names %s: %s', (text, language, names) => {
    expect(neoNamesLanguage(text, language)).toBe(names);
  });
});

describe('the publication commit language gate', () => {
  function pipeline() {
    const commit = mock((input: NeoPublicationInput) => ({
      accepted: true as const,
      created: true,
      publication: { ...input, sequence: 1, createdAt: '2026-10-15T00:00:00.000Z' },
    }));
    const run = createNeoPublicationCommit({
      commit,
      published: () => {},
      turnText: () => 'Which cards are running right now?',
    });
    return { commit, run };
  }

  test('refuses a published reply in the wrong language, so Neo rewrites it', () => {
    const { commit, run } = pipeline();
    expect(run(post('现在有一张卡片在运行，另一张已经完成。'))).toMatchObject({
      accepted: false,
      reason: 'wrong_language',
      detail: expect.stringContaining('requestedLanguage'),
    });
    expect(commit).not.toHaveBeenCalled();
    expect(
      run({ ...post('现在有一张卡片在运行，另一张已经完成。'), requestedLanguage: 'Chinese' })
    ).toMatchObject({
      accepted: false,
      reason: 'wrong_language',
      detail: expect.stringContaining('does not ask for a reply in Chinese'),
    });
    expect(commit).not.toHaveBeenCalled();
  });

  test('posts the end-of-turn fallback anyway, flagged with the language it should have used', () => {
    const { commit, run } = pipeline();
    expect(run(post('现在有一张卡片在运行，另一张已经完成。'), undefined, true)).toMatchObject({
      accepted: true,
    });
    expect(commit.mock.calls[0][0]).toMatchObject({ languageMismatch: 'English' });
    expect(run(post('One card is running and another finished.'))).toMatchObject({
      accepted: true,
    });
    expect(commit.mock.calls[1][0]).not.toHaveProperty('languageMismatch');
  });
});
