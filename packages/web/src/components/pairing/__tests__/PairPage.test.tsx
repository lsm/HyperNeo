import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PairPage } from '../PairPage.tsx';

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

function openPairPage(hash: string, fetchMock: ReturnType<typeof vi.fn>) {
  history.replaceState(null, '', '/pair');
  location.hash = hash;
  vi.stubGlobal('fetch', fetchMock);
  return render(<PairPage />);
}

const pressPair = (view: ReturnType<typeof render>) =>
  fireEvent.click(view.getByRole('button', { name: 'Pair this browser' }));

describe('PairPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fills the code from the link, pairs this browser, and drops the code from the address', async () => {
    const fetchMock = answer(200, { deviceId: 'device-1', kind: 'human' });
    const view = openPairPage('#ABCDE23456', fetchMock);
    const rewrite = vi.spyOn(history, 'replaceState');
    expect((view.getByLabelText('Pairing code') as HTMLInputElement).value).toBe('ABCDE23456');
    fireEvent.input(view.getByLabelText('Name for this browser'), {
      target: { value: 'Work laptop' },
    });
    pressPair(view);
    await waitFor(() => view.getByText('This browser is paired.'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/pair',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'ABCDE23456', name: 'Work laptop' }),
      })
    );
    expect(rewrite).toHaveBeenCalledWith(null, '', location.pathname);
    expect(view.getByRole('link', { name: 'Open HyperNeo' }).getAttribute('href')).toBe('/');
  });

  it('takes a new code from a later link in the same tab, and shows a mangled one as typed', async () => {
    const view = openPairPage('#%GG', answer(200, {}));
    const code = () => (view.getByLabelText('Pairing code') as HTMLInputElement).value;
    expect(code()).toBe('%GG');
    location.hash = '#NEWCODE234';
    dispatchEvent(new HashChangeEvent('hashchange'));
    await waitFor(() => expect(code()).toBe('NEWCODE234'));
  });

  it('pairs after Allow elsewhere without another click or re-entering the code', async () => {
    let approved = false;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(approved ? {} : { error: 'awaiting_approval' }), {
          status: approved ? 200 : 403,
        })
    );
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByText(
      'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.'
    );
    approved = true;
    await waitFor(() => view.getByText('This browser is paired.'), { timeout: 5000 });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(view.queryByRole('button', { name: 'Allow' })).toBeNull();
  });

  it('cancels the wait without redeeming after a later approval', async () => {
    const fetchMock = answer(403, { error: 'awaiting_approval' });
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByText(
      'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.'
    );
    fireEvent.click(view.getByRole('button', { name: 'Stop waiting' }));
    const calls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(view.getByRole('button', { name: 'Pair this browser' })).toHaveProperty(
      'disabled',
      false
    );
  });

  it('pauses pending redemption offline and resumes with the same code', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    let approved = false;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(approved ? {} : { error: 'awaiting_approval' }), {
          status: approved ? 200 : 403,
        })
    );
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByRole('button', { name: 'Stop waiting' });
    online.mockReturnValue(false);
    const calls = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    approved = true;
    online.mockReturnValue(true);
    await waitFor(() => view.getByText('This browser is paired.'), { timeout: 5000 });
  });

  it('does not redeem while hidden and resumes in the foreground', async () => {
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const fetchMock = answer(200, {});
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByText('Pairing paused. Return to this page with a connection to continue.');
    expect(fetchMock).not.toHaveBeenCalled();
    visible.mockReturnValue('visible');
    await waitFor(() => view.getByText('This browser is paired.'), { timeout: 5000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops pending redemption when the page leaves', async () => {
    const fetchMock = answer(403, { error: 'awaiting_approval' });
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByText(
      'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.'
    );
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('explains a wrong code and a lockout', async () => {
    const wrong = openPairPage('#ZZZZZZZZZZ', answer(401, { error: 'invalid_code' }));
    pressPair(wrong);
    await waitFor(() =>
      wrong.getByText('That code is wrong or expired. Make a new one with hyperneo pair.')
    );
    wrong.unmount();
    const locked = openPairPage(
      '#ZZZZZZZZZZ',
      answer(429, { error: 'locked', retryAfterMs: 120_000 })
    );
    pressPair(locked);
    await waitFor(() => locked.getByText('Too many tries. Pairing reopens in 2 minutes.'));
  });
});
