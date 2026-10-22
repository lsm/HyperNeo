import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { locale } from '../../lib/i18n/index.ts';
import {
  NeoSessionStepsLine,
  NeoThinkingRow,
  NeoToolRow,
  sessionStepCountsLabel,
} from '../NeoSessionSteps.tsx';
import type { SessionItem, SessionSteps } from '../session-transcript.ts';

afterEach(() => {
  cleanup();
  locale.value = 'en';
});

const toolItem = (id: string, summary: string): SessionItem => ({
  id,
  kind: { type: 'tool', name: 'Bash', summary, result: 'ok', isError: false },
  date: 0,
  images: [],
});
const thinkingItem: SessionItem = {
  id: 'k',
  kind: { type: 'thinking', text: 'First line\nSecond line' },
  date: 0,
  images: [],
};
const steps = (running: boolean): SessionSteps => ({
  id: 'steps-t1',
  items: [toolItem('t1', 'ls'), toolItem('t2', 'git status'), thinkingItem],
  running,
  start: 0,
  end: 134_000,
});

describe('NeoSessionStepsLine', () => {
  it('folds the steps into one line and lists them on tap', () => {
    render(
      <NeoSessionStepsLine steps={steps(false)} renderStep={(item) => <span>{item.id}</span>} />
    );
    const line = screen.getByRole('button', { expanded: false });
    expect(screen.getByText(/Worked 2m 14s/).textContent).toContain(
      'Worked 2m 14s · 2 tool calls · 1 thinking'
    );
    expect(screen.queryByText('t1')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByText('t1')).toBeTruthy();
    expect(screen.getByText('k')).toBeTruthy();
  });

  it('shows the live clock and the current step while running', () => {
    render(
      <NeoSessionStepsLine
        steps={{ ...steps(true), start: Date.now() - 42_000 }}
        renderStep={() => null}
      />
    );
    expect(screen.getByText(/Working/).textContent).toMatch(
      /^Working 0:4\d · 2 tool calls · 1 thinking/
    );
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('reads in Simplified Chinese', () => {
    locale.value = 'zh-Hans';
    expect(sessionStepCountsLabel(steps(false))).toBe('2 次工具调用 · 1 次思考');
    render(<NeoSessionStepsLine steps={steps(false)} renderStep={() => null} />);
    expect(screen.getByText(/做了 2m 14s/)).toBeTruthy();
  });
});

describe('NeoToolRow', () => {
  it('opens to its result, and a call still running cannot open', () => {
    render(<NeoToolRow name="Bash" summary="ls -la" result="file.txt" isError={false} />);
    const row = screen.getByRole('button', { name: 'more — Bash ls -la' });
    expect(screen.queryByText('file.txt')).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText('file.txt')).toBeTruthy();
    cleanup();
    render(<NeoToolRow name="Shot" summary="page" result="" isError={false} />);
    expect(screen.getByText('page')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    render(<NeoToolRow name="Read" summary="a.ts" result={null} isError={false} />);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('NeoThinkingRow', () => {
  it('shows the first line, then the rest on tap', () => {
    render(<NeoThinkingRow text={'First line\nSecond line'} />);
    const row = screen.getByRole('button');
    expect(screen.getByText('First line')).toBeTruthy();
    expect(screen.queryByText(/Second line/)).toBeNull();
    fireEvent.click(row);
    expect(screen.getByText(/Second line/)).toBeTruthy();
  });
});
