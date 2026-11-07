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
    sessionStorage.clear();
    vi.useRealTimers();
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
      })
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      code: 'ABCDE23456',
      name: 'Work laptop',
      requestId: expect.any(String),
    });
    expect(sent.requestId.length).toBeGreaterThanOrEqual(16);
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

  it('pairs on plain HTTP, where crypto.randomUUID is missing', async () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const fetchMock = answer(200, { deviceId: 'device-1', kind: 'human' });
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await waitFor(() => view.getByText('This browser is paired.'));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).requestId.length).toBeGreaterThanOrEqual(16);
  });

  it('a reload while waiting asks again as the same requester, so the code stays valid', async () => {
    const fetchMock = answer(403, { error: 'awaiting_approval' });
    const waiting =
      'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.';
    pressPair(openPairPage('#ABCDE23456', fetchMock));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    cleanup();
    const again = openPairPage('#abcde-23456', fetchMock);
    pressPair(again);
    await again.findByText(waiting);
    const ids = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).requestId
    );
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
  });

  it('says the code was used from another window when another tab took it', async () => {
    const view = openPairPage('#ABCDE23456', answer(409, { error: 'code_used_elsewhere' }));
    pressPair(view);
    await view.findByText(
      'This code was used from another window. Make a new one with hyperneo pair.'
    );
  });

  it('tells the waiting tab its code was used from another window', async () => {
    let voided = false;
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            voided ? { error: 'code_used_elsewhere' } : { error: 'awaiting_approval' }
          ),
          { status: voided ? 409 : 403 }
        )
    );
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await view.findByText(
      'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.'
    );
    voided = true;
    await waitFor(
      () =>
        view.getByText(
          'This code was used from another window. Make a new one with hyperneo pair.'
        ),
      { timeout: 5000 }
    );
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
    const ids = fetchMock.mock.calls.map(
      (call) => JSON.parse((call as unknown as [string, RequestInit])[1].body as string).requestId
    );
    expect(new Set(ids).size).toBe(1);
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

  it('stops a hung request at the wait deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(view.getByText(/Pairing timed out/)).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('explains recovery if cancellation races a redeemed code', async () => {
    let redeemed = false;
    const fetchMock = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          redeemed = true;
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    const view = openPairPage('#ABCDE23456', fetchMock);
    pressPair(view);
    expect(redeemed).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Stop waiting' }));
    expect(
      view.getByText(/check Devices on a paired device before making a new code/)
    ).toBeTruthy();
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
