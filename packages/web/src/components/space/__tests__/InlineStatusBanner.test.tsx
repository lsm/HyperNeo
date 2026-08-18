// @ts-nocheck
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { InlineStatusBanner } from '../InlineStatusBanner';

describe('InlineStatusBanner', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders with tone, icon, label, and meta', () => {
    const { getByTestId } = render(
      <InlineStatusBanner
        tone="amber"
        icon="⏳"
        label="Waiting on something"
        meta="· 3m ago"
        testId="demo-banner"
      />
    );
    const root = getByTestId('demo-banner');
    expect(root.getAttribute('data-tone')).toBe('amber');
    expect(getByTestId('demo-banner-icon').textContent).toBe('⏳');
    expect(getByTestId('demo-banner-label').textContent).toContain('Waiting on something');
    expect(getByTestId('demo-banner-meta').textContent).toContain('3m ago');
  });

  it('renders actions and fires their callbacks', () => {
    const onRetry: Mock = vi.fn();
    const onClose: Mock = vi.fn();
    const { getByTestId } = render(
      <InlineStatusBanner
        tone="blue"
        label="Needs attention"
        actions={[
          { label: 'Retry', onClick: onRetry, testId: 'retry-btn', variant: 'primary' },
          { label: 'Close', onClick: onClose, testId: 'close-btn' },
        ]}
        testId="demo-banner"
      />
    );
    fireEvent.click(getByTestId('retry-btn'));
    fireEvent.click(getByTestId('close-btn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disables action buttons when disabled=true', () => {
    const onClick: Mock = vi.fn();
    const { getByTestId } = render(
      <InlineStatusBanner
        tone="red"
        label="Error"
        actions={[{ label: 'Retry', onClick, testId: 'retry-btn', disabled: true }]}
        testId="err-banner"
      />
    );
    const btn = getByTestId('retry-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies dataAttrs to the root node', () => {
    const { getByTestId } = render(
      <InlineStatusBanner
        tone="green"
        label="ok"
        testId="banner"
        dataAttrs={{ 'data-task-id': 'task-42' }}
      />
    );
    const root = getByTestId('banner');
    expect(root.getAttribute('data-task-id')).toBe('task-42');
  });

  it('does not render icon when icon prop omitted', () => {
    const { queryByTestId } = render(
      <InlineStatusBanner tone="gray" label="no icon" testId="banner" />
    );
    expect(queryByTestId('banner-icon')).toBeNull();
  });

  it('does not render meta when meta prop omitted', () => {
    const { queryByTestId } = render(
      <InlineStatusBanner tone="purple" label="no meta" testId="banner" />
    );
    expect(queryByTestId('banner-meta')).toBeNull();
  });
});
