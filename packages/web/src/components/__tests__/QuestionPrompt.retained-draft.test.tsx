import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingUserQuestion } from '@hyperneo/shared';
import { QuestionPrompt } from '../QuestionPrompt.tsx';
import { createQuestionFormDraft, type QuestionFormDraft } from '../question-form-draft.ts';
import { connectionState } from '../../lib/state.ts';

const transport = vi.hoisted(() => ({ request: vi.fn(), connected: true }));
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: {
    getHubIfConnected: () => (transport.connected ? { request: transport.request } : null),
  },
}));
const pending: PendingUserQuestion = {
  toolUseId: 'question-A',
  askedAt: 1,
  inputOrigin: { sessionId: 'worker-A', messageId: 'work-A' },
  questions: [
    {
      header: 'Draft',
      question: 'Which fictional draft?',
      multiSelect: false,
      options: [
        { label: 'Draft A', description: 'First plan' },
        { label: 'Draft B', description: 'Second plan' },
      ],
    },
  ],
};
let retained: QuestionFormDraft;
const changed = vi.fn();
const resolved = vi.fn();
function RetainedForm({
  visible = true,
  question = pending,
  sessionId = 'worker-A',
  initial,
}: {
  visible?: boolean;
  question?: PendingUserQuestion;
  sessionId?: string;
  initial?: QuestionFormDraft;
}) {
  const [value, setValue] = useState(
    () => initial ?? createQuestionFormDraft(sessionId, question.toolUseId, question.draftResponses)
  );
  retained = value;
  return visible ? (
    <QuestionPrompt
      sessionId={sessionId}
      pendingQuestion={question}
      onResolved={resolved}
      formDraft={{
        value,
        onChange: (next) => {
          changed(next);
          setValue(next);
        },
      }}
    />
  ) : null;
}
const choose = (label: 'Draft A' | 'Draft B') =>
  fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}`) }));
const other = () => fireEvent.click(screen.getByRole('button', { name: /^Other/ }));
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Submit Response' }));
const text = () => screen.getByRole('textbox') as HTMLTextAreaElement;
beforeEach(() => {
  connectionState.value = 'connected';
  transport.connected = true;
  transport.request.mockReset();
  transport.request.mockResolvedValue({ success: true });
  changed.mockClear();
  resolved.mockClear();
});
afterEach(cleanup);

describe('retained native question form', () => {
  it('retains a selection through unmount before the native draft debounce and submits it once', async () => {
    const view = render(<RetainedForm />);
    const original = retained;
    choose('Draft B');
    expect(retained.selections.get(0)).toEqual(new Set(['Draft B']));
    expect(original.selections.size).toBe(0);
    expect(transport.request).not.toHaveBeenCalled();
    view.rerender(<RetainedForm visible={false} />);
    expect(screen.queryByRole('button', { name: 'Submit Response' })).toBeNull();
    view.rerender(<RetainedForm />);
    submit();
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(transport.request).toHaveBeenCalledExactlyOnceWith(
      'question.respond',
      {
        sessionId: 'worker-A',
        toolUseId: 'question-A',
        responses: [{ questionIndex: 0, selectedLabels: ['Draft B'], customText: undefined }],
      },
      { timeout: 30000 }
    );
  });
  it('retains typed text and an empty opened Other field without prematurely saving or sending', async () => {
    const view = render(<RetainedForm />);
    other();
    view.rerender(<RetainedForm visible={false} />);
    view.rerender(<RetainedForm />);
    expect(text().value).toBe('');
    expect(
      (screen.getByRole('button', { name: 'Submit Response' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.input(text(), { target: { value: 'Use the fictional library room.' } });
    view.rerender(<RetainedForm visible={false} />);
    view.rerender(<RetainedForm />);
    expect(text().value).toBe('Use the fictional library room.');
    expect(transport.request).not.toHaveBeenCalled();
    submit();
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(transport.request).toHaveBeenCalledWith(
      'question.respond',
      {
        sessionId: 'worker-A',
        toolUseId: 'question-A',
        responses: [
          { questionIndex: 0, selectedLabels: [], customText: 'Use the fictional library room.' },
        ],
      },
      { timeout: 30000 }
    );
  });
  it('preserves multi-selections and typed detail without mutating supplied maps or sets', async () => {
    const question = { ...pending, questions: [{ ...pending.questions[0], multiSelect: true }] };
    const initial = createQuestionFormDraft('worker-A', question.toolUseId, [
      { questionIndex: 0, selectedLabels: ['Draft A'], customText: 'First detail' },
    ]);
    const originalLabels = initial.selections.get(0)!;
    const view = render(<RetainedForm question={question} initial={initial} />);
    choose('Draft B');
    fireEvent.input(text(), { target: { value: 'Retained detail' } });
    expect(originalLabels).toEqual(new Set(['Draft A']));
    expect(initial.customInputs.get(0)).toBe('First detail');
    expect(initial.showOther).toEqual(new Set([0]));
    expect(retained).not.toBe(initial);
    view.rerender(<RetainedForm visible={false} question={question} initial={initial} />);
    view.rerender(<RetainedForm question={question} initial={initial} />);
    submit();
    await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
    expect(transport.request).toHaveBeenCalledWith(
      'question.respond',
      {
        sessionId: 'worker-A',
        toolUseId: 'question-A',
        responses: [
          {
            questionIndex: 0,
            selectedLabels: ['Draft A', 'Draft B'],
            customText: 'Retained detail',
          },
        ],
      },
      { timeout: 30000 }
    );
  });
  it('keeps single-choice selection and Other mutually exclusive across retained updates', () => {
    render(<RetainedForm />);
    choose('Draft A');
    other();
    fireEvent.input(text(), { target: { value: 'Different choice' } });
    expect(retained.selections.get(0)?.size).toBe(0);
    choose('Draft B');
    expect(retained.selections.get(0)).toEqual(new Set(['Draft B']));
    expect(retained.showOther.size).toBe(0);
    expect(retained.customInputs.size).toBe(0);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it.each(['session', 'question'] as const)(
    'never borrows a retained draft from another %s identity',
    async (part) => {
      const view = render(<RetainedForm />);
      other();
      fireEvent.input(text(), { target: { value: 'Old answer' } });
      const sessionId = part === 'session' ? 'worker-B' : 'worker-A';
      const question = part === 'question' ? { ...pending, toolUseId: 'question-B' } : pending;
      view.rerender(<RetainedForm sessionId={sessionId} question={question} />);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(
        (screen.getByRole('button', { name: 'Submit Response' }) as HTMLButtonElement).disabled
      ).toBe(true);
      choose('Draft A');
      expect(retained.sessionId).toBe(sessionId);
      expect(retained.toolUseId).toBe(question.toolUseId);
      expect(retained.customInputs.size).toBe(0);
      submit();
      await waitFor(() => expect(resolved).toHaveBeenCalledOnce());
      expect(transport.request).toHaveBeenCalledWith(
        'question.respond',
        {
          sessionId,
          toolUseId: question.toolUseId,
          responses: [{ questionIndex: 0, selectedLabels: ['Draft A'], customText: undefined }],
        },
        { timeout: 30000 }
      );
    }
  );
  it('retains the draft after a disconnected refusal and preserves native cancellation binding', async () => {
    const view = render(<RetainedForm />);
    choose('Draft B');
    connectionState.value = 'disconnected';
    transport.connected = false;
    await act(async () => {
      submit();
    });
    expect(resolved).not.toHaveBeenCalled();
    expect(retained.selections.get(0)).toEqual(new Set(['Draft B']));
    view.rerender(<RetainedForm visible={false} />);
    view.rerender(<RetainedForm />);
    connectionState.value = 'connected';
    transport.connected = true;
    fireEvent.click(screen.getByRole('button', { name: 'Skip Question' }));
    await waitFor(() => expect(resolved).toHaveBeenCalledWith('cancelled', []));
    expect(transport.request).toHaveBeenCalledExactlyOnceWith(
      'question.cancel',
      {
        sessionId: 'worker-A',
        toolUseId: 'question-A',
      },
      { timeout: 30000 }
    );
  });
});
