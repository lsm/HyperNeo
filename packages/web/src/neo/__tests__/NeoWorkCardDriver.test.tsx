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
      'Idle in oap · Neo is checking'
    );
    expect(neoWorkDriverLabel({ ...driver, adapter: 'copilot-cli', status: 'done' })).toBe(
      'Idle in GitHub Copilot on laptop · Neo is checking'
    );
  });
});

describe('neoWorkDriverLink', () => {
  it('keeps app and in-app links and drops anything else', () => {
    expect(neoWorkDriverLink(driver)).toBe('codex://threads/t1');
    expect(neoWorkDriverLink({ ...driver, link: 'ghapp://sessions/s1' })).toBe(
      'ghapp://sessions/s1'
    );
    expect(neoWorkDriverLink({ ...driver, daemon: null, link: '/space/sp1/task/t1' })).toBe(
      '/space/sp1/task/t1'
    );
    expect(neoWorkDriverLink({ ...driver, link: '/session/s1' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, daemon: null, link: '/\t/evil.com' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, daemon: null, link: '/\n\\evil.com' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, link: 'javascript:alert(1)' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, link: '//evil.com' })).toBeNull();
    expect(neoWorkDriverLink({ ...driver, link: '/\\evil.com' })).toBeNull();
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

  it('tints each summary row by where its work stands', () => {
    const cases: Array<
      [Partial<NeoWork>, (typeof driver)['status'] | 'running' | 'done' | 'stopped' | null, string]
    > = [
      [{}, 'running', 'accent'],
      [{}, 'done', 'accent'],
      [{}, 'stopped', 'warning'],
      [{ status: 'reported' }, null, 'success'],
      [{ status: 'failed' }, null, 'warning'],
      [{ status: 'cancelled' }, null, 'warning'],
    ];
    const tones = cases.map(([patch, status, _tone]) => {
      const { container, unmount } = render(
        <NeoWorkCard
          work={{ ...work, ...patch }}
          driver={status ? { ...driver, status } : undefined}
          busy={false}
          disabled={false}
          onAction={vi.fn()}
          onOpen={vi.fn()}
          presentation="summary"
        />
      );
      const tone = container.querySelector('[data-tone]')?.getAttribute('data-tone');
      unmount();
      return tone;
    });
    expect(tones).toEqual(cases.map(([, , tone]) => tone));
    const { container } = render(
      <NeoWorkCard
        work={{ ...work, sessionId: 's1' }}
        busy={false}
        disabled={false}
        onAction={vi.fn()}
        onOpen={vi.fn()}
        waiting
      />
    );
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
    expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('warning');
  });

  it('labels a reported card by its pull request and keeps it in progress while the PR is open', () => {
    const rows = [
      ['pending', 'OPEN', 'Waiting on CI · #6039', 'accent'],
      ['passing', 'MERGED', 'Merged · #6039', 'success'],
    ] as const;
    for (const [checks, state, label, tone] of rows) {
      const { container, unmount } = render(
        <NeoWorkCard
          work={{ ...work, status: 'reported' }}
          prs={{
            workId: 'w1',
            waiting: checks === 'pending',
            prs: [
              { url: 'https://github.com/lsm/HyperNeo/pull/6039', state, checks, review: 'none' },
            ],
          }}
          busy={false}
          disabled={false}
          onAction={vi.fn()}
        />
      );
      expect(screen.getByText(label)).toBeTruthy();
      expect(container.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe(tone);
      unmount();
    }
  });

  it('marks the Open link with the app it opens', () => {
    const logos = [
      { adapter: 'codex-desktop', link: 'codex://threads/t1' },
      { adapter: 'claude-desktop', link: 'claude://claude.ai/epitaxy/local_a1' },
      { adapter: 'hyperneo', daemon: null, link: '/session/s1' },
    ].map((target) => {
      const { unmount } = render(
        <NeoWorkCard
          work={work}
          driver={{ ...driver, status: 'running', ...target }}
          busy={false}
          disabled={false}
          onAction={vi.fn()}
          onOpen={vi.fn()}
          presentation="summary"
        />
      );
      const link = screen.getByRole('link', { name: 'Open Bigger font' });
      const logo = link.querySelector('[data-app-logo]')?.getAttribute('data-app-logo') ?? null;
      unmount();
      return logo;
    });
    expect(logos).toEqual(['anthropic-codex', 'anthropic', null]);
  });
});
