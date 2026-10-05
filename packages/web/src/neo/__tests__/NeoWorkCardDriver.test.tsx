import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoWorkCard } from '../NeoWorkCard.tsx';
import { neoWorkDriverLabel, neoWorkDriverLink } from '../work-driver.ts';

vi.mock('../../lib/state.ts', () => ({
  connectionState: { value: 'connected', subscribe: () => () => {} },
}));

const work: NeoWork = {
  id: 'w1',
  requestKey: 'w1',
  concernId: null,
  originSessionId: 'root',
  originMessageId: 'ask-1',
  title: 'Bigger font',
  instruction: 'Raise the body font to 16px.',
  targetSessionId: null,
  sessionId: null,
  status: 'queued',
  report: null,
  createdAt: 10,
  updatedAt: 11,
};
const driver = {
  workId: 'w1',
  adapter: 'codex-desktop',
  daemon: 'laptop',
  status: 'needs_you' as const,
  link: 'codex://threads/t1',
};

afterEach(cleanup);

describe('neoWorkDriverLabel', () => {
  it('names the app, the machine and the live state', () => {
    expect(neoWorkDriverLabel(driver)).toBe('Needs you in Codex Desktop on laptop');
    expect(neoWorkDriverLabel({ ...driver, daemon: null, status: 'running' })).toBe(
      'Running in Codex Desktop'
    );
    expect(neoWorkDriverLabel({ ...driver, adapter: 'space', daemon: null, status: null })).toBe(
      'Handed to a Space'
    );
    expect(neoWorkDriverLabel({ ...driver, adapter: 'oap', daemon: null, status: 'done' })).toBe(
      'Finished in oap'
    );
  });
});

describe('neoWorkDriverLink', () => {
  it('keeps app and in-app links and drops anything else', () => {
    expect(neoWorkDriverLink(driver)).toBe('codex://threads/t1');
    expect(neoWorkDriverLink({ ...driver, link: '/space/sp1/task/t1' })).toBe('/space/sp1/task/t1');
    expect(neoWorkDriverLink({ ...driver, link: 'javascript:alert(1)' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, link: null })).toBeNull();
    expect(neoWorkDriverLink(undefined)).toBeNull();
  });
});

describe('NeoWorkCard with drivers work', () => {
  it('shows where the work went and opens it there', () => {
    render(
      <NeoWorkCard
        work={work}
        driver={driver}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
        onOpen={vi.fn()}
      />
    );
    expect(screen.getByText('Needs you in Codex Desktop on laptop')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Bigger font' }).getAttribute('href')).toBe(
      'codex://threads/t1'
    );
  });

  it('keeps the summary row openable through the link', () => {
    render(
      <NeoWorkCard
        work={work}
        driver={{ ...driver, status: 'running' }}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
        onOpen={vi.fn()}
        presentation="summary"
      />
    );
    expect(screen.getByText('Running in Codex Desktop on laptop')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Bigger font' })).toBeTruthy();
  });
});
