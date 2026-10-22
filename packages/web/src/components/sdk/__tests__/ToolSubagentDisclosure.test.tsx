import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { ToolResultCard } from '../tools/ToolResultCard.tsx';
import { SubagentBlock } from '../SubagentBlock.tsx';
import { MessageHydrationContext } from '../chat-display-mode.ts';

afterEach(cleanup);

describe('SDK tool and subagent disclosures', () => {
  it('keeps tool titles inert and reads details only through the shared control', async () => {
    const onExpand = vi.fn();
    const view = render(
      <ToolResultCard
        toolName="Read"
        toolId="synthetic-read"
        input={{ file_path: 'synthetic.txt' }}
        output="Synthetic readable result"
        defaultExpanded={false}
        onExpand={onExpand}
      />
    );
    fireEvent.click(view.getByText('Read', { exact: true }));
    expect(onExpand).not.toHaveBeenCalled();
    expect(view.queryByText('Synthetic readable result')).toBeNull();
    const more = view.getByRole('button', { name: 'more — Read synthetic.txt', exact: true });
    expect(more.getAttribute('aria-controls')).toBeNull();
    more.focus();
    fireEvent.click(more);
    expect(onExpand).toHaveBeenCalledTimes(1);
    const output = view.container.querySelector('pre');
    await waitFor(() => expect(output?.textContent).toContain('Synthetic readable result'));
    fireEvent.click(output!);
    const less = view.getByRole('button', { name: 'less — Read synthetic.txt', exact: true });
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(less);
    expect(document.getElementById(less.getAttribute('aria-controls')!)).not.toBeNull();
    fireEvent.click(less);
    expect(view.queryByText('Synthetic readable result')).toBeNull();
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'more — Read synthetic.txt', exact: true })
    );
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('does not offer an inert disclosure for a disabled tool', () => {
    const onExpand = vi.fn();
    const view = render(
      <ToolResultCard
        toolName="Read"
        toolId="synthetic-disabled"
        input={{ file_path: 'synthetic.txt' }}
        disableExpand
        defaultExpanded={false}
        onExpand={onExpand}
      />
    );
    expect(view.queryByRole('button')).toBeNull();
    fireEvent.click(view.getByText('Read', { exact: true }));
    expect(onExpand).not.toHaveBeenCalled();
  });

  it('uses the explicit control for structured patch details', () => {
    const view = render(
      <ToolResultCard
        toolName="Edit"
        toolId="synthetic-edit"
        input={{ file_path: 'synthetic.txt' }}
        variant="detailed"
        defaultExpanded
        output={{
          filePath: 'synthetic.txt',
          oldString: 'old',
          newString: 'new',
          originalFile: 'old',
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] },
          ],
          userModified: false,
          replaceAll: false,
        }}
      />
    );
    const details = view.getByText('Structured patch', { exact: true }).closest('details');
    fireEvent.click(view.getByText('Structured patch', { exact: true }));
    expect(details?.open).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'more — Structured patch', exact: true }));
    expect(details?.open).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'less — Structured patch', exact: true }));
    expect(details?.open).toBe(false);
  });

  it('preserves subagent hydration and nests explicit raw details', async () => {
    const hydrate = vi.fn();
    const nested = {
      type: 'tool_progress',
      uuid: 'synthetic-progress',
      parent_tool_use_id: 'synthetic-agent',
      tool_name: 'Read',
      tool_use_id: 'nested-read',
      elapsed_time_seconds: 1,
    } as unknown as SDKMessage;
    const view = render(
      <MessageHydrationContext.Provider value={hydrate}>
        <SubagentBlock
          input={{
            subagent_type: 'Explore',
            description: 'Synthetic exploration',
            prompt: 'Find synthetic evidence',
          }}
          toolId="synthetic-agent"
          assistantUuid="synthetic-assistant"
          messageUuid="synthetic-result"
          nestedMessages={[nested]}
          output="Synthetic final evidence."
        />
      </MessageHydrationContext.Provider>
    );
    fireEvent.click(view.getByText('Synthetic exploration', { exact: true }));
    expect(hydrate).not.toHaveBeenCalled();
    expect(view.queryByText('Find synthetic evidence')).toBeNull();
    const more = view.getByRole('button', {
      name: 'more — Explore Synthetic exploration',
      exact: true,
    });
    expect(more.getAttribute('aria-controls')).toBeNull();
    more.focus();
    fireEvent.click(more);
    expect(hydrate).toHaveBeenCalledWith([
      'synthetic-assistant',
      'synthetic-result',
      'synthetic-progress',
    ]);
    expect(view.getByText('Find synthetic evidence')).toBeTruthy();
    const less = await view.findByRole('button', {
      name: 'less — Explore Synthetic exploration',
      exact: true,
    });
    expect(document.activeElement).toBe(less);
    expect(document.getElementById(less.getAttribute('aria-controls')!)).not.toBeNull();
    const raw = view.getByText('Unknown message type: tool_progress').closest('details');
    fireEvent.click(view.getByText('Unknown message type: tool_progress'));
    expect(raw?.open).toBe(false);
    fireEvent.click(
      view.getByRole('button', { name: 'more — Unknown message type: tool_progress', exact: true })
    );
    expect(raw?.open).toBe(true);
    fireEvent.click(
      view.getByRole('button', { name: 'less — Unknown message type: tool_progress', exact: true })
    );
    fireEvent.click(less);
    expect(view.queryByText('Find synthetic evidence')).toBeNull();
    expect(hydrate).toHaveBeenCalledTimes(1);
  });
});
