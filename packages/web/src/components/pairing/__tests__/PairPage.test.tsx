import { fireEvent, render, waitFor } from '@testing-library/preact';
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
    vi.unstubAllGlobals();
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
    expect(fetchMock).toHaveBeenCalledWith('/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'ABCDE23456', name: 'Work laptop' }),
    });
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

  it('says to tap Allow on a paired device while the code waits for it', async () => {
    const view = openPairPage('#ABCDE23456', answer(403, { error: 'awaiting_approval' }));
    pressPair(view);
    await waitFor(() =>
      view.getByText(
        'This code needs Allow first. Tap Allow on your paired phone, then pair again.'
      )
    );
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
