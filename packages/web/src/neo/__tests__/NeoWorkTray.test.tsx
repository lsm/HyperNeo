import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NeoWorkTray, neoWorkTrayLabel } from '../NeoWorkTray.tsx';

function makeWork(overrides: Partial<NeoWork> = {}): NeoWork {
  return {
    id: 'work-1',
    requestKey: 'request',
    concernId: null,
    originSessionId: 'neo',
    title: 'Draft the agenda',
    instruction: 'Eight people, Sunday. Do not book anything.',
    sessionId: 'worker-one',
    status: 'proposed',
    report: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as NeoWork;
}

afterEach(cleanup);

describe('neoWorkTrayLabel', () => {
  it('summarizes decisions and running work as counts', () => {
    expect(neoWorkTrayLabel([makeWork()])).toBe('1 needs your call');
    expect(neoWorkTrayLabel([makeWork({ status: 'queued' })])).toBe('1 running');
    expect(
      neoWorkTrayLabel([
        makeWork(),
        makeWork({ id: 'work-2', status: 'queued' }),
        makeWork({ id: 'work-3', status: 'queued' }),
      ])
    ).toBe('1 needs your call · 2 running');
  });
});

describe('NeoWorkTray', () => {
  it('renders nothing when there is no current work', () => {
    const { container } = render(
      <NeoWorkTray works={[]} busyId={null} disabled={false} onAction={vi.fn()} />
    );
    expect(container.querySelector('[data-testid="neo-work-tray"]')).toBeNull();
  });

  it('stays collapsed to one summary line until opened', () => {
    render(
      <NeoWorkTray
        works={[makeWork(), makeWork({ id: 'work-2', status: 'queued' })]}
        busyId={null}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    const tray = screen.getByTestId('neo-work-tray');
    expect(tray.querySelector('.neo-work-tray-list')).toBeNull();
    expect(screen.getByRole('button', { name: /1 needs your call · 1 running/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start work' })).toBeNull();
  });

  it('exposes start, stop, and inspect per row once opened', () => {
    const action = vi.fn();
    render(
      <NeoWorkTray
        works={[makeWork(), makeWork({ id: 'work-2', status: 'queued' })]}
        busyId={null}
        disabled={false}
        onAction={action}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /1 needs your call · 1 running/ }));

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(action).toHaveBeenCalledWith('work-1', 'start');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(action).toHaveBeenCalledWith('work-2', 'cancel');
    expect(screen.getAllByRole('link', { name: 'Inspect ↗' })[0].getAttribute('href')).toBe(
      '/session/worker-one'
    );
  });

  it('expands the full card for one row at a time without stacking every card', () => {
    render(
      <NeoWorkTray
        works={[
          makeWork({ title: 'Draft the agenda' }),
          makeWork({ id: 'work-2', title: 'Watch the pipeline', status: 'queued' }),
        ]}
        busyId={null}
        disabled={false}
        onAction={vi.fn()}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /1 needs your call · 1 running/ }));
    expect(screen.queryByText('Start work')).toBeNull();

    fireEvent.click(screen.getByText('Draft the agenda'));
    expect(screen.getByRole('button', { name: 'Start work' })).toBeTruthy();
    expect(screen.getAllByRole('article').length).toBe(1);

    fireEvent.click(screen.getByText('Watch the pipeline'));
    expect(screen.queryByText('Start work')).toBeNull();
  });

  it('disables row actions while busy or disconnected', () => {
    render(<NeoWorkTray works={[makeWork()]} busyId="work-1" disabled onAction={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /1 needs your call/ }));
    expect((screen.getByRole('button', { name: 'Starting…' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });
});
