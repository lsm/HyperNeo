import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { afterEach } from 'vitest';
import { QueuePreviewTray, type QueuePreviewMessage } from '../QueuePreviewTray.tsx';

function makeMessages(count: number, prefix: string): QueuePreviewMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    dbId: `db-${prefix}-${i}`,
    uuid: `uuid-${prefix}-${i}`,
    timestamp: i,
    status: 'deferred' as const,
    text: `${prefix} message ${i}`,
  }));
}

describe('QueuePreviewTray — inline cap + full-queue modal', () => {
  afterEach(cleanup);

  it('renders all messages when a group has three or fewer (no more button)', () => {
    const { container } = render(
      <QueuePreviewTray currentTurnMessages={[]} nextTurnMessages={makeMessages(3, 'next')} />
    );
    const rows = container.querySelectorAll('[data-testid="queued-next-turn-bubble"] > div');
    expect(rows.length).toBe(3);
    expect(container.querySelector('[data-testid="queued-show-all"]')).toBeNull();
  });

  it('caps the inline preview at three and shows a +N more button', () => {
    const { container } = render(
      <QueuePreviewTray currentTurnMessages={[]} nextTurnMessages={makeMessages(20, 'next')} />
    );
    const rows = container.querySelectorAll('[data-testid="queued-next-turn-bubble"] > div');
    expect(rows.length).toBe(3);
    const more = container.querySelector('[data-testid="queued-show-all"]');
    expect(more?.textContent).toContain('+17 more');
  });

  it('opens the full list in a modal with per-message actions preserved', () => {
    const onRemove = vi.fn();
    const messages = makeMessages(5, 'next');
    const { container } = render(
      <QueuePreviewTray
        currentTurnMessages={[]}
        nextTurnMessages={messages}
        onRemoveMessage={onRemove}
      />
    );
    fireEvent.click(container.querySelector('[data-testid="queued-show-all"]')!);

    const modalList = document.body.querySelector('[data-testid="queued-modal-list"]');
    expect(modalList).toBeTruthy();
    expect(modalList?.querySelectorAll('div.flex.min-h-8').length).toBe(5);
    const removeButtons = modalList?.querySelectorAll('[data-testid="remove-queued-message"]');
    expect(removeButtons?.length).toBe(5);
    fireEvent.click(removeButtons![4]);
    expect(onRemove).toHaveBeenCalledWith(messages[4]);
    expect(container.querySelector('[data-testid="queued-modal-page-label"]')).toBeNull();
  });

  it('paginates the modal list at ten items per page', () => {
    const messages = makeMessages(25, 'next');
    const { container } = render(
      <QueuePreviewTray currentTurnMessages={[]} nextTurnMessages={messages} />
    );
    fireEvent.click(container.querySelector('[data-testid="queued-show-all"]')!);

    const modalList = document.body.querySelector('[data-testid="queued-modal-list"]')!;
    expect(modalList.querySelectorAll('div.flex.min-h-8').length).toBe(10);
    expect(
      document.body.querySelector('[data-testid="queued-modal-page-label"]')?.textContent
    ).toBe('Page 1 of 3');

    const next = document.body.querySelector('[data-testid="queued-modal-next-page"]')!;
    const prev = document.body.querySelector('[data-testid="queued-modal-prev-page"]')!;
    expect(prev.hasAttribute('disabled')).toBe(true);

    fireEvent.click(next);
    expect(
      document.body.querySelector('[data-testid="queued-modal-page-label"]')?.textContent
    ).toBe('Page 2 of 3');
    expect(
      document.body
        .querySelector('[data-testid="queued-modal-list"]')
        ?.querySelectorAll('div.flex.min-h-8').length
    ).toBe(10);

    fireEvent.click(document.body.querySelector('[data-testid="queued-modal-next-page"]')!);
    expect(
      document.body.querySelector('[data-testid="queued-modal-page-label"]')?.textContent
    ).toBe('Page 3 of 3');
    expect(
      document.body
        .querySelector('[data-testid="queued-modal-list"]')
        ?.querySelectorAll('div.flex.min-h-8').length
    ).toBe(5);
    expect(
      document.body
        .querySelector('[data-testid="queued-modal-next-page"]')!
        .hasAttribute('disabled')
    ).toBe(true);
  });

  it('paginates the Steer group independently of Next', () => {
    const { container } = render(
      <QueuePreviewTray
        currentTurnMessages={makeMessages(12, 'steer')}
        nextTurnMessages={makeMessages(4, 'next')}
      />
    );
    expect(container.querySelectorAll('[data-testid="queued-show-all"]').length).toBe(2);
    fireEvent.click(container.querySelectorAll('[data-testid="queued-show-all"]')[0]);
    expect(
      document.body.querySelector('[data-testid="queued-modal-page-label"]')?.textContent
    ).toBe('Page 1 of 2');
  });
});

describe('QueuePreviewTray — review round 2 fixes', () => {
  afterEach(cleanup);

  it('does not reopen the modal when its queue refills after emptying', () => {
    const { container, rerender } = render(
      <QueuePreviewTray currentTurnMessages={[]} nextTurnMessages={makeMessages(5, 'next')} />
    );
    fireEvent.click(container.querySelector('[data-testid="queued-show-all"]')!);
    expect(document.body.querySelector('[data-testid="queued-modal-list"]')).toBeTruthy();

    rerender(
      <QueuePreviewTray currentTurnMessages={makeMessages(2, 'steer')} nextTurnMessages={[]} />
    );
    rerender(
      <QueuePreviewTray
        currentTurnMessages={makeMessages(2, 'steer')}
        nextTurnMessages={makeMessages(1, 'next')}
      />
    );
    expect(document.body.querySelector('[data-testid="queued-modal-list"]')).toBeNull();
  });

  it('flags not-loaded messages when the server total exceeds the loaded list', () => {
    const { container } = render(
      <QueuePreviewTray
        currentTurnMessages={[]}
        nextTurnMessages={makeMessages(5, 'next')}
        nextTurnTotal={1200}
      />
    );
    fireEvent.click(container.querySelector('[data-testid="queued-show-all"]')!);
    expect(
      document.body.querySelector('[data-testid="queued-modal-unloaded-note"]')?.textContent
    ).toContain('1195 more not loaded');
    expect(document.body.querySelector('[data-testid="queued-modal-page-label"]')).toBeNull();
  });
});
