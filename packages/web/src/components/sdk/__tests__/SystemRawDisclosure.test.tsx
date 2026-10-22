import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { SDKSystemMessage } from '../SDKSystemMessage.tsx';
import { SDKMessageRenderer } from '../SDKMessageRenderer.tsx';
import { ChatDisplayModeContext } from '../chat-display-mode.ts';

afterEach(cleanup);

const system = (subtype: string, fields: Record<string, unknown>) =>
  ({
    type: 'system',
    subtype,
    uuid: crypto.randomUUID(),
    session_id: 'synthetic',
    ...fields,
  }) as Extract<SDKMessage, { type: 'system' }>;
const cases = [
  {
    title: 'Memory recalled',
    label: 'Memory recalled',
    message: system('memory_recall', {
      memories: [{ scope: 'project', path: 'synthetic-memory.md' }],
    }),
  },
  {
    title: 'synthetic-hook',
    label: 'synthetic-hook',
    message: system('hook_response', {
      hook_name: 'synthetic-hook',
      hook_event: 'PreToolUse',
      stdout: 'Synthetic hook summary\nSynthetic full detail',
      stderr: 'Synthetic diagnostic',
      exit_code: 1,
    }),
  },
  {
    title: 'Compact',
    label: 'Compact',
    message: system('compact_boundary', {
      compact_metadata: { trigger: 'manual', pre_tokens: 150000 },
    }),
  },
];

describe('SDK system and raw disclosures', () => {
  it.each(cases)(
    'keeps $title selectable and opens only through its explicit control',
    ({ title, label, message }) => {
      const view = render(<SDKSystemMessage message={message} />);
      fireEvent.click(view.getByText(title, { exact: true }));
      const more = view.getByRole('button', { name: `more — ${label}`, exact: true });
      expect(more.getAttribute('aria-expanded')).toBe('false');
      more.focus();
      fireEvent.click(more);
      const less = view.getByRole('button', { name: `less — ${label}`, exact: true });
      expect(less.getAttribute('aria-expanded')).toBe('true');
      expect(document.activeElement).toBe(less);
      const panel = document.getElementById(less.getAttribute('aria-controls')!);
      expect(panel).not.toBeNull();
      fireEvent.click(panel!);
      expect(less.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(less);
      expect(document.activeElement).toBe(
        view.getByRole('button', { name: `more — ${label}`, exact: true })
      );
    }
  );

  it('keeps unknown-message JSON behind the same explicit control', () => {
    const message = {
      type: 'synthetic_unknown',
      uuid: 'synthetic-raw',
      session_id: 'synthetic',
      payload: 'Synthetic raw evidence',
    } as unknown as SDKMessage;
    const view = render(<SDKMessageRenderer message={message} />);
    const details = view.getByText('Show raw data').closest('details');
    fireEvent.click(view.getByText('Show raw data'));
    expect(details?.open).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'more — Show raw data', exact: true }));
    expect(details?.open).toBe(true);
    fireEvent.click(view.container.querySelector('pre')!);
    expect(details?.open).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'less — Show raw data', exact: true }));
    expect(details?.open).toBe(false);
  });

  it('preserves minimal-mode activity filtering', () => {
    const view = render(
      <ChatDisplayModeContext.Provider value="minimal">
        <SDKMessageRenderer message={cases[1].message} />
      </ChatDisplayModeContext.Provider>
    );
    expect(view.container.textContent).toBe('');
  });
});
