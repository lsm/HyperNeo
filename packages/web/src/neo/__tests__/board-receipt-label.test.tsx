import { cleanup, render, screen, within } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { neoBoardReceiptLabel } from '../board-receipt-label.ts';
import { NeoConcernBoardView } from '../NeoConcernBoard.tsx';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';

vi.mock('../../lib/state.ts', () => ({ connectionState: { value: 'connected' } }));
vi.mock('../../lib/connection-manager.ts', () => ({ connectionManager: {} }));
afterEach(cleanup);

const question =
  'Internal review prompt\n' +
  JSON.stringify({ workId: 'work-A', report: 'Worker claim only. <script>never run</script>' });
const snapshot: NeoSnapshot = {
  ok: true,
  sessionId: 'root',
  concerns: [
    {
      id: 'research',
      title: 'Research',
      summary: '',
      context: '',
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  work: [
    {
      id: 'work-A',
      requestKey: 'A',
      concernId: 'research',
      originSessionId: 'root',
      originMessageId: 'ask-A',
      title: 'Review the draft',
      instruction: 'Bounded instruction',
      sessionId: 'existing-manager',
      status: 'reported',
      report: 'Worker claim only.',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  consultations: [
    {
      id: 'neo-work:work-A:review',
      requestKey: 'neo-work:work-A:review',
      concernId: 'research',
      originSessionId: 'root',
      originMessageId: null,
      sessionId: 'holder',
      question,
      status: 'reported',
      answer: 'Needs your decision.',
      createdAt: 2,
    },
  ],
};
const board = () => projectNeoConcernBoard(snapshot, 'research', null)!;

describe('neoBoardReceiptLabel', () => {
  it('uses actual work titles and exact recorded review relationships without parsing reports', () => {
    const receipts = board().receipts;
    const review = receipts.find((item) => item.kind === 'consultation')!;
    const work = receipts.find((item) => item.kind === 'work')!;
    const before = structuredClone(receipts);
    expect(neoBoardReceiptLabel(work, receipts)).toBe('Review the draft');
    expect(neoBoardReceiptLabel(review, receipts)).toBe('Context review · Review the draft');
    expect(
      neoBoardReceiptLabel({ ...review, question: 'Invent another work item' }, receipts)
    ).toBe('Context review · Review the draft');
    expect(receipts).toEqual(before);
  });

  it.each([{ id: 'ordinary-check' }, { requestKey: 'different-check' }, { concernId: 'family' }])(
    'does not infer a work relationship from prompt text or partial identity: %j',
    (patch) => {
      const receipts = board().receipts;
      const review = receipts.find((item) => item.kind === 'consultation')!;
      expect(neoBoardReceiptLabel({ ...review, ...patch }, receipts)).toBe('Context check');
    }
  );

  it('missing work does not fabricate a review or completion claim', () => {
    const review = board().receipts.find((item) => item.kind === 'consultation')!;
    expect(neoBoardReceiptLabel(review, [review])).toBe('Context check');
    expect(neoBoardReceiptLabel(review, [review])).not.toContain('complete');
  });
});

describe('Recorded handoff disclosure', () => {
  it('keeps internal prompts out of the headline and preserves their exact text behind details', () => {
    render(<NeoConcernBoardView board={board()} requestScoped />);
    const list = screen.getByRole('list', { name: 'Recorded handoffs' });
    const label = within(list).getByText('Context review · Review the draft');
    expect(label.textContent).not.toContain('work-A');
    expect(label.textContent).not.toContain('Internal review prompt');
    const item = label.closest('li')!;
    const details = item.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Request details');
    expect(details.querySelector('p')!.textContent).toBe(question);
    expect(within(details).getByText('Needs your decision.')).toBeTruthy();
    expect(details.textContent).toContain('Receipt: neo-work:work-A:review');
    expect(details.textContent).toContain('Input: root / not recorded');
    expect(item.querySelector('script')).toBeNull();
    expect(screen.getAllByText('Response ready')).toHaveLength(2);
    expect(screen.queryByText('Completed')).toBeNull();
  });

  it('ordinary context checks use a short title but still expose the original question', () => {
    const source: NeoSnapshot = {
      ...snapshot,
      work: [],
      consultations: [
        {
          ...snapshot.consultations![0],
          id: 'normal',
          requestKey: 'normal',
          question: 'What is next? '.repeat(500),
          status: 'pending',
          answer: null,
        },
      ],
    };
    const observed = projectNeoConcernBoard(source, 'research', null)!;
    render(<NeoConcernBoardView board={observed} />);
    const label = screen.getByText('Context check');
    const details = label.closest('li')!.querySelector('details')!;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain(source.consultations![0].question);
    expect(screen.getByText('Checking context')).toBeTruthy();
    expect(source.consultations![0].question.length).toBeGreaterThan(4000);
  });
});
