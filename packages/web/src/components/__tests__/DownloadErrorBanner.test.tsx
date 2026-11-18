import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from '../ErrorBanner.tsx';
const retryClaudeDownload = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-helpers.ts', () => ({ retryClaudeDownload }));
const downloadProps = { downloadFailure: true } as unknown as Record<string, never>;

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('ErrorBanner', () => {
  it('retries the download once and shows the returned cause', async () => {
    vi.mocked(retryClaudeDownload).mockResolvedValue({
      accepted: false,
      reason: "Can't download Claude Code: registry unavailable.",
    });
    render(
      <ErrorBanner
        {...downloadProps}
        error="Claude Code is still downloading."
        onDismiss={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryClaudeDownload).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Can't download Claude Code: registry unavailable.")
    ).toBeTruthy();
  });

  it('clears the error after a successful download', async () => {
    const dismiss = vi.fn();
    vi.mocked(retryClaudeDownload).mockResolvedValue({ accepted: true });
    render(<ErrorBanner {...downloadProps} error="Download failed." onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
  });
});
