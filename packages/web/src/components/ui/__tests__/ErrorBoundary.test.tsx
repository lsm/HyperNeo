import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/preact';
import { h } from 'preact';
import { ErrorBoundary } from '../ErrorBoundary';

function ThrowOnRender({ error }: { error: Error }): never {
  throw error;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">Hello</div>
      </ErrorBoundary>
    );

    expect(screen.getByTestId('child').textContent).toBe('Hello');
  });

  it('renders default fallback UI when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowOnRender error={new Error('test error')} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Failed to load component')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();

    spy.mockRestore();
  });

  it('renders custom fallback when provided', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom Error</div>}>
        <ThrowOnRender error={new Error('test error')} />
      </ErrorBoundary>
    );

    expect(screen.getByTestId('custom-fallback').textContent).toBe('Custom Error');

    spy.mockRestore();
  });

  it('calls onError callback when an error is caught', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();

    render(
      <ErrorBoundary onError={onError}>
        <ThrowOnRender error={new Error('test error')} />
      </ErrorBoundary>
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe('test error');

    spy.mockRestore();
  });

  it('resets error state when Retry button is clicked', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowOnRender error={new Error('test error')} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Failed to load component')).toBeTruthy();

    fireEvent.click(screen.getByText('Retry'));

    expect(screen.getByText('Failed to load component')).toBeTruthy();

    spy.mockRestore();
  });
});
