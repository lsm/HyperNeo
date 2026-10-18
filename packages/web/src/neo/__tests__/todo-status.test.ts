import { afterEach, describe, expect, it } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { neoQuestionText, neoTodoStatus } from '../todo-status.ts';

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

  it('keeps questions Neo wrote itself verbatim', () => {
    locale.value = 'zh-Hans';
    expect(neoQuestionText({ text: 'Which repo should I use?' })).toBe('Which repo should I use?');
  });
});
