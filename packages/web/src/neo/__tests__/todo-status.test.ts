import { afterEach, describe, expect, it } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import { neoTodoStatus } from '../todo-status.ts';

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
