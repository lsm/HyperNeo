import type { SessionGoal } from '@hyperneo/shared/types/session-goal';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoalJournal } from '../../components/SessionGoalJournal.tsx';
import { locale } from '../../lib/i18n/index.ts';
import { NeoGoals } from '../NeoGoals.tsx';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
const goal: SessionGoal = {
  id: 'synthetic-goal',
  ownerSessionId: 'root',
  title: 'Synthetic goal',
  description: 'Synthetic definition',
  status: 'active',
  type: 'one_shot',
  priority: 'normal',
  metrics: {},
  doneTest: 'Synthetic done test',
  summary: '',
  worksNote: 'Synthetic worked',
  progress: 0,
  nextSteps: [],
  mandateRef: null,
  mandateRev: null,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  revision: 1,
};
let paused: boolean;
beforeEach(() => {
  locale.value = 'en';
  paused = false;
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'goal.session.list') return { accepted: true, goals: [goal] };
    if (name === 'goal.session.get') return { accepted: true, goal };
    if (name === 'goal.journal.list')
      return {
        accepted: true,
        entries: [
          {
            id: 'entry',
            goalId: goal.id,
            createdAt: 1,
            done: 'Synthetic journal action',
            effect: 'Synthetic effect',
            worked: 'Synthetic worked',
            failed: 'Synthetic failed approach',
            evidence: [
              {
                kind: 'pr',
                ref: 'https://github.com/example/synthetic/pull/1',
                note: 'Synthetic evidence',
              },
            ],
          },
        ],
      };
    if (name === 'schedule.session.pause' || name === 'schedule.session.resume') {
      paused = name.endsWith('pause');
      return { ok: true };
    }
    if (name === 'schedule.session.list')
      return {
        ok: true,
        schedules: [
          {
            id: 'schedule',
            target: input.target,
            sourceKind: 'goal',
            sourceId: goal.id,
            sourceLabel: goal.title,
            cadence: { kind: 'every', everyMs: 3600000 },
            status: paused ? 'paused' : 'active',
            nudgeEvery: 4,
            dueCount: 0,
            nextRunAt: null,
            lastRunAt: null,
            lastOutcome: null,
          },
        ],
      };
    throw new Error(`Unexpected operation ${name}`);
  });
});
afterEach(cleanup);

const definitionReads = () =>
  request.mock.calls.filter(([, data]) => data.name === 'goal.session.get');

describe('Neo goal explicit disclosures', () => {
  it('leaves goal titles/status inert and opens scoped details only with more', async () => {
    render(<NeoGoals sessionId="root" />);
    await screen.findByText('Synthetic effect');
    fireEvent.click(screen.getByText('Synthetic goal'));
    fireEvent.click(screen.getByText('Synthetic effect'));
    expect(definitionReads()).toHaveLength(0);
    const control = screen.getByRole('button', { name: 'more — Synthetic goal' });
    fireEvent.click(control);
    const definition = await screen.findByText('Synthetic definition');
    const less = screen.getByRole('button', { name: 'less — Synthetic goal' });
    fireEvent.click(definition);
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(
      definition.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    fireEvent.click(less);
    expect(screen.queryByText('Synthetic definition')).toBeNull();
    expect(screen.getByRole('button', { name: 'more — Synthetic goal' })).toBe(control);
  });

  it('leaves journal effects inert and keeps evidence links behind an explicit control', async () => {
    const { container } = render(<GoalJournal ownerSessionId="root" goalId={goal.id} explicit />);
    const effect = await screen.findByText('Synthetic effect');
    const entry = container.querySelector<HTMLDetailsElement>('[data-journal-entry]')!;
    fireEvent.click(effect);
    expect(entry.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'more — Synthetic effect' }));
    const evidence = within(entry).getByRole('link', { name: 'Synthetic evidence' });
    expect(evidence.getAttribute('href')).toBe('https://github.com/example/synthetic/pull/1');
    const less = screen.getByRole('button', { name: 'less — Synthetic effect' });
    expect(evidence.compareDocumentPosition(less) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByText('Synthetic journal action'));
    expect(entry.open).toBe(true);
    fireEvent.click(less);
    expect(entry.open).toBe(false);
  });
});
