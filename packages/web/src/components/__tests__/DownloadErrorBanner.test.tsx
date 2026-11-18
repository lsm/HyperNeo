import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBanner } from '../ErrorBanner.tsx';
import { locale } from '../../lib/i18n/index.ts';
const retryClaudeDownload = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api-helpers.ts', () => ({ retryClaudeDownload }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  locale.value = 'en';
});

describe('ErrorBanner', () => {
  it('retries the download once and shows the returned cause', async () => {
    vi.mocked(retryClaudeDownload).mockResolvedValue({
      accepted: false,
      reason: "Can't download Claude Code: registry unavailable.",
    });
    render(
      <ErrorBanner downloadFailure error="Claude Code is still downloading." onDismiss={vi.fn()} />
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
    render(<ErrorBanner downloadFailure error="Download failed." onDismiss={dismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledTimes(1));
  });
  it('localizes the registry cause and retry action', () => {
    locale.value = 'zh-Hans';
    render(
      <ErrorBanner
        downloadFailure
        error="Can't download Claude Code: npm could not download the package (exit 7); check your npm registry and login"
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('无法下载 Claude Code：请检查 npm 软件源和登录信息。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it.each(['registry.npmjs.org', 'mirror.example'])(
    'localizes an unreachable registry and keeps its host: %s',
    (host) => {
      locale.value = 'zh-Hans';
      render(
        <ErrorBanner
          downloadFailure
          error={`Can't download Claude Code: Cannot reach npm registry at ${host}.`}
          onDismiss={vi.fn()}
        />
      );
      expect(screen.getByText(`无法下载 Claude Code：无法连接 npm 软件源 ${host}。`)).toBeTruthy();
    }
  );

  it('localizes a registry web page response', () => {
    locale.value = 'zh-Hans';
    render(
      <ErrorBanner
        downloadFailure
        error="Can't download Claude Code: registry returned a web page, not package metadata (blocked by the network?)"
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('无法下载 Claude Code：npm 软件源没有返回软件包信息。')).toBeTruthy();
  });

  it('does not start another download while retry is pending', async () => {
    vi.mocked(retryClaudeDownload).mockReturnValue(new Promise(() => {}));
    render(<ErrorBanner downloadFailure error="Download failed." onDismiss={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(retryClaudeDownload).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Retrying…' }).hasAttribute('disabled')).toBe(true);
  });
});
