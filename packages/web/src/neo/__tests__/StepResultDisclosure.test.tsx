import type { ChatMessage } from '@hyperneo/shared';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SDKResultMessage } from '../../components/sdk/SDKResultMessage.tsx';
import { TurnStatusLine } from '../../components/sdk/TurnStatusLine.tsx';
import { locale } from '../../lib/i18n/index.ts';
import { NeoMessage } from '../NeoMessage.tsx';
import { NeoSessionStepsLine, NeoThinkingRow, NeoToolRow } from '../NeoSessionSteps.tsx';

afterEach(() => {
  cleanup();
  locale.value = 'en';
});

const result = {
  type: 'result',
  subtype: 'success',
  total_cost_usd: 0.01,
  duration_ms: 1000,
  duration_api_ms: 900,
  num_turns: 1,
  modelUsage: {},
  result: 'Synthetic result detail',
  usage: { input_tokens: 12, output_tokens: 3 },
} as unknown as Extract<SDKMessage, { type: 'result' }>;

describe('Step and result disclosures', () => {
  it.each(['Short thinking.', 'Long thinking words. '.repeat(40)])(
    'selects thinking without toggling: %s',
    (text) => {
      render(<NeoThinkingRow text={`Thinking preview\n${text}`} />);
      fireEvent.click(screen.getByText('Thinking preview'));
      expect(screen.queryByText(/Short thinking\.|Long thinking words/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /more.*Thinking/ }));
      const body = screen.getByText(/Short thinking\.|Long thinking words/);
      const less = screen.getByRole('button', { name: /less.*Thinking/ });
      expect(body.closest('button')).toBeNull();
      fireEvent.click(body);
      expect(less.getAttribute('aria-expanded')).toBe('true');
      expect(less.style.cssFloat).toBe('right');
      fireEvent.click(less);
      expect(screen.getByText('Thinking preview')).toBeTruthy();
    }
  );

  it('opens tool results only through the explicit trailing control', () => {
    render(
      <NeoToolRow
        name="Read"
        summary="synthetic.txt"
        result="Synthetic tool detail"
        isError={false}
      />
    );
    fireEvent.click(screen.getByText('synthetic.txt'));
    expect(screen.queryByText('Synthetic tool detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Read synthetic.txt/ }));
    const body = screen.getByText('Synthetic tool detail');
    fireEvent.click(body);
    const less = screen.getByRole('button', { name: /less.*Read synthetic.txt/ });
    expect(body.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(less);
    expect(screen.queryByText('Synthetic tool detail')).toBeNull();
  });

  it('keeps unavailable tool results inert', () => {
    render(<NeoToolRow name="Read" summary="pending.txt" result={null} isError={false} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('puts the step-list collapse control after the listed steps', () => {
    render(
      <NeoSessionStepsLine
        steps={{
          id: 'steps',
          running: false,
          start: 0,
          end: 1000,
          items: [
            {
              id: 'step',
              date: 0,
              images: [],
              kind: { type: 'thinking', text: 'Synthetic step detail' },
            },
          ],
        }}
        renderStep={() => <p>Synthetic step detail</p>}
      />
    );
    fireEvent.click(screen.getByText(/Worked/));
    expect(screen.queryByText('Synthetic step detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Show steps/ }));
    const detail = screen.getByText('Synthetic step detail');
    const less = screen.getByRole('button', { name: /less.*Hide steps/ });
    expect(detail.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(detail);
    expect(less.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps work-report title inert and uses a trailing explicit button', async () => {
    render(
      <NeoMessage
        message={{ type: 'assistant' } as ChatMessage}
        text="Synthetic reply"
        work={{ title: 'Synthetic work', report: 'Synthetic report detail' } as NeoWork}
      />
    );
    fireEvent.click(screen.getByText('Read result · Synthetic work'));
    expect(screen.queryByText('Synthetic report detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Read result/ }));
    const report = await screen.findByText('Synthetic report detail');
    fireEvent.click(report);
    const less = screen.getByRole('button', { name: /less.*Read result/ });
    expect(report.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(less);
    expect(screen.queryByText('Synthetic report detail')).toBeNull();
  });

  it('keeps SDK token summary inert and puts collapse after all result details', () => {
    render(<SDKResultMessage message={result} />);
    fireEvent.click(screen.getByText('12→3 tokens'));
    expect(screen.queryByText('Synthetic result detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /more.*Result details/ }));
    const detail = screen.getByText('Synthetic result detail');
    fireEvent.click(detail);
    const less = screen.getByRole('button', { name: /less.*Result details/ });
    expect(detail.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(less);
    expect(screen.queryByText('Synthetic result detail')).toBeNull();
  });

  it('keeps SDK status text inert and gives the explicit control an expanded state', () => {
    const toggle = vi.fn();
    const turn = {
      key: 'turn',
      messages: [],
      toolCount: 1,
      errorCount: 0,
      startedAt: 0,
      durationMs: 1000,
      outcome: 'done' as const,
    };
    const view = render(<TurnStatusLine turn={turn} expanded={false} onToggle={toggle} />);
    fireEvent.click(screen.getByText(/Worked for/));
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /more.*Show steps/ }));
    expect(toggle).toHaveBeenCalledOnce();
    view.rerender(<TurnStatusLine turn={turn} expanded={true} onToggle={toggle} />);
    expect(
      screen.getByRole('button', { name: /less.*Hide steps/ }).getAttribute('aria-expanded')
    ).toBe('true');
  });
});
