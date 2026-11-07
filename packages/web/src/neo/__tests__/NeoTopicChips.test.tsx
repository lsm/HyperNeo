import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoTopicChips, neoTopicCounts } from '../NeoTopicChips.tsx';
import { locale } from '../../lib/i18n/index.ts';

const asks = (...topics: (string | null)[]) => topics.map((topic) => ({ ask: { topic } }));

beforeEach(() => {
  locale.value = 'zh-Hans';
});
afterEach(() => {
  cleanup();
  locale.value = 'en';
});

describe('neoTopicCounts', () => {
  it('orders topics by count, puts 其他 last and leaves untopiced asks out', () => {
    expect(neoTopicCounts(asks('邮件', '其他', 'OAP', '其他', '其他', 'OAP', null, 'OAP'))).toEqual(
      [
        ['OAP', 3],
        ['邮件', 1],
        ['其他', 3],
      ]
    );
  });
});

describe('NeoTopicChips', () => {
  it('shows every ask under 全部 and one chip per topic with its count', () => {
    const view = render(
      <NeoTopicChips entries={asks('OAP', null, 'OAP')} selected={null} onSelect={vi.fn()} />
    );
    expect(view.getAllByRole('button').map((chip) => chip.textContent)).toEqual([
      '全部 3',
      'OAP 2',
    ]);
    expect(view.getByRole('button', { name: '全部 3' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('selects a topic and clears it on a second tap', () => {
    const onSelect = vi.fn();
    const view = render(<NeoTopicChips entries={asks('OAP')} selected="OAP" onSelect={onSelect} />);
    expect(view.getByRole('button', { name: 'OAP 1' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(view.getByRole('button', { name: 'OAP 1' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.click(view.getByRole('button', { name: '全部 1' }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('selects an unselected topic', () => {
    const onSelect = vi.fn();
    const view = render(
      <NeoTopicChips entries={asks('OAP')} selected={null} onSelect={onSelect} />
    );
    fireEvent.click(view.getByRole('button', { name: 'OAP 1' }));
    expect(onSelect).toHaveBeenLastCalledWith('OAP');
  });

  it('shows nothing when no ask has a topic', () => {
    const view = render(<NeoTopicChips entries={asks(null)} selected={null} onSelect={vi.fn()} />);
    expect(view.container.textContent).toBe('');
  });
});
