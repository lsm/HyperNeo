import { afterEach, describe, expect, it } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { neoQuestionOption, neoQuestionText, neoTodoStatus } from '../todo-status.ts';

afterEach(() => {
  locale.value = 'en';
});

const merged = { code: 'todo.pr.merged', params: { pr: '#7426' } };
const waiting = { code: 'todo.pr.waitingCi', params: { pr: '#7427' } };

describe('neoTodoStatus', () => {
  it('renders the same status codes in each language, joined with its separator', () => {
    const todo = {
      status: '#7426 merged; #7427 open, waiting on CI',
      statusCodes: [merged, waiting],
    };
    expect(neoTodoStatus(todo)).toBe('#7426 merged; #7427 open, waiting on CI');
    locale.value = 'zh-Hans';
    expect(neoTodoStatus(todo)).toBe('#7426 已合并；#7427 开着，等 CI');
  });

  it('falls back to the English status when codes are missing or unknown', () => {
    locale.value = 'zh-Hans';
    expect(neoTodoStatus({ status: 'Done' })).toBe('Done');
    expect(neoTodoStatus({ status: 'Done', statusCodes: [] })).toBe('Done');
    expect(
      neoTodoStatus({
        status: 'Something new',
        statusCodes: [merged, { code: 'todo.future', params: {} }],
      })
    ).toBe('Something new');
    expect(neoTodoStatus({ status: 'Done', statusCodes: [{ code: 'toString', params: {} }] })).toBe(
      'Done'
    );
  });
});

describe('neoQuestionText', () => {
  it('renders daemon start-question codes in each language', () => {
    const one = {
      text: 'Start "Ship W5"?',
      textCodes: [{ code: 'question.startOne', params: { title: 'Ship W5' } }],
    };
    const many = {
      text: 'Start these 3?',
      textCodes: [{ code: 'question.startMany', params: { count: '3' } }],
    };
    expect(neoQuestionText(one)).toBe('Start "Ship W5"?');
    expect(neoQuestionText(many)).toBe('Start these 3?');
    locale.value = 'zh-Hans';
    expect(neoQuestionText(one)).toBe('开始「Ship W5」？');
    expect(neoQuestionText(many)).toBe('开始这 3 件？');
  });

  it('renders a removal card and its buttons in each language', () => {
    const card = {
      text: '"Build" was removed. Continue "Deploy" without it, or remove this step too?',
      textCodes: [
        { code: 'question.removedOneOne', params: { removed: '"Build"', steps: '"Deploy"' } },
      ],
      options: ['Continue', 'Remove these'],
      optionCodes: [
        { code: 'question.removedContinue', params: {} },
        { code: 'question.removedRemove', params: {} },
      ],
    };
    expect(neoQuestionText(card)).toBe(card.text);
    expect(neoQuestionOption(card, 'Remove these')).toBe('Remove these');
    locale.value = 'zh-Hans';
    expect(neoQuestionText(card)).toBe(
      '"Build" 已移除。不等它，继续 "Deploy"？还是把这一步也移除？'
    );
    expect(neoQuestionOption(card, 'Continue')).toBe('继续');
    expect(neoQuestionOption(card, 'Remove these')).toBe('一起移除');
    expect(neoQuestionOption({ options: ['Ship'] }, 'Ship')).toBe('Ship');
  });

  it('keeps questions Neo wrote itself verbatim', () => {
    locale.value = 'zh-Hans';
    expect(neoQuestionText({ text: 'Which repo should I use?' })).toBe('Which repo should I use?');
  });
});
