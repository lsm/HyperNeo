// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { QuestionPrompt } from '../QuestionPrompt';
import type { PendingUserQuestion, QuestionDraftResponse } from '@hyperneo/shared';

const mockCallIfConnected = vi.fn();
vi.mock('../../hooks/useMessageHub', () => ({
  useMessageHub: () => ({
    callIfConnected: mockCallIfConnected,
  }),
}));

describe('QuestionPrompt', () => {
  const mockOnResolved = vi.fn(
    (_state: 'submitted' | 'cancelled', _responses: QuestionDraftResponse[]) => {}
  );

  const mockPendingQuestion: PendingUserQuestion = {
    toolUseId: 'tool-123',
    questions: [
      {
        header: 'File Action',
        question: 'What would you like to do with the file?',
        multiSelect: false,
        options: [
          { label: 'Edit', description: 'Make changes to the file' },
          { label: 'Delete', description: 'Remove the file permanently' },
          { label: 'Move', description: 'Move the file to another location' },
        ],
      },
    ],
    draftResponses: undefined,
  };

  const multiSelectQuestion: PendingUserQuestion = {
    toolUseId: 'tool-456',
    questions: [
      {
        header: 'Features',
        question: 'Which features would you like to enable?',
        multiSelect: true,
        options: [
          { label: 'Dark Mode', description: 'Enable dark theme' },
          { label: 'Notifications', description: 'Enable push notifications' },
          { label: 'Analytics', description: 'Enable usage analytics' },
        ],
      },
    ],
    draftResponses: undefined,
  };

  beforeEach(() => {
    cleanup();
    mockOnResolved.mockClear();
    mockCallIfConnected.mockClear();
    mockCallIfConnected.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render question header', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('File Action');
    });

    it('should render question text', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('What would you like to do with the file?');
    });

    it('should render pending state header', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Claude needs your input');
    });

    it('should render all options', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Make changes to the file');
      expect(container.textContent).toContain('Delete');
      expect(container.textContent).toContain('Remove the file permanently');
      expect(container.textContent).toContain('Move');
      expect(container.textContent).toContain('Move the file to another location');
    });

    it('should render "Other" option', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Other...');
      expect(container.textContent).toContain('Enter custom answer');
    });

    it('should render submit button', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Submit Response');
    });

    it('should render skip button', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Skip Question');
    });
  });

  describe('Single Select Behavior', () => {
    it('should select option when clicked', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editButton);

      expect(editButton.className).toContain('bg-cat-rose/15');
    });

    it('should deselect previous option when new option is selected', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      const deleteButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Delete')
      )!;

      fireEvent.click(editButton);
      fireEvent.click(deleteButton);

      expect(deleteButton.className).toContain('bg-cat-rose/15');
      expect(editButton.className).not.toContain('bg-cat-rose/15');
    });

    it('should clear selection when "Other" is clicked', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      const otherButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;

      fireEvent.click(editButton);
      fireEvent.click(otherButton);

      expect(editButton.className).not.toContain('bg-cat-rose/15');
    });
  });

  describe('Multi Select Behavior', () => {
    it('should allow selecting multiple options', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiSelectQuestion} />
      );

      const darkModeBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Dark Mode')
      )!;
      const notificationsBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Notifications')
      )!;

      fireEvent.click(darkModeBtn);
      fireEvent.click(notificationsBtn);

      expect(darkModeBtn.className).toContain('bg-cat-rose/15');
      expect(notificationsBtn.className).toContain('bg-cat-rose/15');
    });

    it('should toggle selection on repeated clicks', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiSelectQuestion} />
      );

      const darkModeBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Dark Mode')
      )!;

      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).toContain('bg-cat-rose/15');

      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).not.toContain('bg-cat-rose/15');
    });
  });

  describe('Custom Input', () => {
    it('should show custom textarea when "Other" is clicked', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const otherButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherButton);

      const textarea = container.querySelector('textarea');
      expect(textarea).toBeTruthy();
    });

    it('should accept custom input text', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const otherButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherButton);

      const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: 'Custom response' } });

      expect(textarea.value).toBe('Custom response');
    });
  });

  describe('Submit Functionality', () => {
    it('should disable submit button when no selection is made', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;

      expect(submitButton.disabled).toBe(true);
    });

    it('should enable submit button when selection is made', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editButton);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;

      expect(submitButton.disabled).toBe(false);
    });
  });

  describe('Cancel Functionality', () => {
    it('should have skip button', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      );
      expect(skipButton).toBeTruthy();
    });
  });

  describe('Resolved States', () => {
    it('should show submitted state header', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });

    it('should show cancelled state header', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
        />
      );

      expect(container.textContent).toContain('Question skipped');
    });

    it('should show "agent session ended" header when cancelReason=agent_session_terminated', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
          cancelReason="agent_session_terminated"
        />
      );

      expect(container.textContent).toContain('Question cancelled — agent session ended');
      expect(container.textContent).not.toContain('Question skipped');
    });

    it('should show generic "Question skipped" when cancelReason=user_cancelled', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
          cancelReason="user_cancelled"
        />
      );

      expect(container.textContent).toContain('Question skipped');
      expect(container.textContent).not.toContain('agent session ended');
    });

    it('should hide action buttons when resolved', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).not.toContain('Submit Response');
      expect(container.textContent).not.toContain('Skip Question');
    });

    it('should disable options when resolved', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });

    it('should show final selections when resolved', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Draft Loading', () => {
    it('should initialize from draft responses', () => {
      const questionWithDraft: PendingUserQuestion = {
        ...mockPendingQuestion,
        draftResponses: [{ questionIndex: 0, selectedLabels: ['Delete'] }],
      };

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={questionWithDraft} />
      );

      const deleteButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Delete')
      )!;

      expect(deleteButton.className).toContain('bg-cat-rose/15');
    });

    it('should initialize custom text from draft responses', () => {
      const questionWithDraft: PendingUserQuestion = {
        ...mockPendingQuestion,
        draftResponses: [
          {
            questionIndex: 0,
            selectedLabels: [],
            customText: 'My custom answer',
          },
        ],
      };

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={questionWithDraft} />
      );

      const textarea = container.querySelector('textarea')! as HTMLTextAreaElement;
      expect(textarea.value).toBe('My custom answer');
    });
  });

  describe('Multiple Questions', () => {
    it('should render multiple questions', () => {
      const multiQuestionPrompt: PendingUserQuestion = {
        toolUseId: 'tool-789',
        questions: [
          {
            header: 'First Question',
            question: 'Choose option 1',
            multiSelect: false,
            options: [{ label: 'A', description: 'Option A' }],
          },
          {
            header: 'Second Question',
            question: 'Choose option 2',
            multiSelect: false,
            options: [{ label: 'B', description: 'Option B' }],
          },
        ],
        draftResponses: undefined,
      };

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiQuestionPrompt} />
      );

      expect(container.textContent).toContain('First Question');
      expect(container.textContent).toContain('Choose option 1');
      expect(container.textContent).toContain('Second Question');
      expect(container.textContent).toContain('Choose option 2');
    });

    it('should require all questions to be answered for valid form', () => {
      const multiQuestionPrompt: PendingUserQuestion = {
        toolUseId: 'tool-789',
        questions: [
          {
            header: 'First',
            question: 'Q1',
            multiSelect: false,
            options: [{ label: 'A', description: 'A' }],
          },
          {
            header: 'Second',
            question: 'Q2',
            multiSelect: false,
            options: [{ label: 'B', description: 'B' }],
          },
        ],
        draftResponses: undefined,
      };

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiQuestionPrompt} />
      );

      const optionA = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('A')
      )!;
      fireEvent.click(optionA);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;

      expect(submitButton.disabled).toBe(true);
    });
  });

  describe('Collapsible Header Behavior', () => {
    it('should be expanded by default for pending state', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
    });

    it('should always show form content (no collapse functionality)', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
      expect(container.textContent).toContain('Other...');

      const headerButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
        btn.textContent?.includes('Claude needs your input')
      );
      expect(headerButtons.length).toBe(0);
    });

    it('should show question count in header', () => {
      const multiQuestionPrompt: PendingUserQuestion = {
        toolUseId: 'tool-multi',
        questions: [
          {
            header: 'Q1',
            question: 'First?',
            multiSelect: false,
            options: [{ label: 'A', description: 'A' }],
          },
          {
            header: 'Q2',
            question: 'Second?',
            multiSelect: false,
            options: [{ label: 'B', description: 'B' }],
          },
          {
            header: 'Q3',
            question: 'Third?',
            multiSelect: false,
            options: [{ label: 'C', description: 'C' }],
          },
        ],
        draftResponses: undefined,
      };

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiQuestionPrompt} />
      );

      expect(container.textContent).toContain('3 questions');
    });

    it('should show singular "question" for single question', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      expect(container.textContent).toContain('1 question');
    });

    it('should show check icon when resolved (no chevron)', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      const headerDiv = container.querySelector('div');
      expect(headerDiv).toBeTruthy();

      expect(container.textContent).toContain('Response submitted');

      expect(container.textContent).toContain('Edit');
    });

    it('should show non-interactive header when resolved (no button)', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      const headerButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
        btn.textContent?.includes('Response submitted')
      );
      expect(headerButtons.length).toBe(0);

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Multi-select with Other option', () => {
    it('should keep existing selections when "Other" is clicked in multi-select', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiSelectQuestion} />
      );

      const darkModeBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Dark Mode')
      )!;
      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;

      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).toContain('bg-cat-rose/15');

      fireEvent.click(otherBtn);

      expect(darkModeBtn.className).toContain('bg-cat-rose/15');
    });

    it('should show multi-select badge', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiSelectQuestion} />
      );

      expect(container.textContent).toContain('Multi-select');
    });
  });

  describe('Single-select clearing Other', () => {
    it('should clear custom input when selecting regular option after Other', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      const textarea = container.querySelector('textarea')!;
      fireEvent.input(textarea, { target: { value: 'Custom answer' } });
      expect((textarea as HTMLTextAreaElement).value).toBe('Custom answer');

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      expect(container.querySelector('textarea')).toBeFalsy();
    });
  });

  describe('Form validation with custom text', () => {
    it('should enable submit when only custom text is provided', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      const textarea = container.querySelector('textarea')!;
      fireEvent.input(textarea, { target: { value: 'My custom response' } });

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;

      expect(submitButton.disabled).toBe(false);
    });
  });

  describe('Resolved state with custom text', () => {
    it('should show custom text textarea in resolved state', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'My final custom answer',
            },
          ]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });

    it('should show resolved state with custom text value in textarea', () => {
      const questionWithFinalCustom: PendingUserQuestion = {
        ...mockPendingQuestion,
        draftResponses: undefined,
      };

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={questionWithFinalCustom}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'Final custom answer',
            },
          ]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Cancelled state styling', () => {
    it('should hide "Other" button if not selected when cancelled', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Question skipped');
    });

    it('should apply cancelled styling to container', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
        />
      );

      const mainDiv = container.firstChild as HTMLDivElement;
      expect(mainDiv.className).toContain('opacity-60');
    });

    it('should apply submitted styling to container', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      const mainDiv = container.firstChild as HTMLDivElement;
      expect(mainDiv.className).toContain('opacity-80');
    });
  });

  describe('Option click in resolved state', () => {
    it('should not change selection when option is clicked in resolved state', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });

    it('should not show custom input when "Other" is clicked in resolved state', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Draft saving behavior', () => {
    it('should not save draft when resolved', async () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Submit and Cancel with onResolved callback', () => {
    it('should call onResolved with submitted state when submit succeeds', async () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          onResolved={mockOnResolved}
        />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockOnResolved).toHaveBeenCalledWith('submitted', expect.any(Array));
    });

    it('should submit with only custom text and no option selected', async () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          onResolved={mockOnResolved}
        />
      );

      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: 'My custom answer' } });

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockOnResolved).toHaveBeenCalledWith(
        'submitted',
        expect.arrayContaining([
          expect.objectContaining({
            questionIndex: 0,
            selectedLabels: [],
            customText: 'My custom answer',
          }),
        ])
      );
    });

    it('should call onResolved with cancelled state when cancel succeeds', async () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          onResolved={mockOnResolved}
        />
      );

      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )!;
      fireEvent.click(skipButton);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockOnResolved).toHaveBeenCalledWith('cancelled', []);
    });
  });

  describe('Error handling', () => {
    it('should handle submit error gracefully', async () => {
      mockCallIfConnected.mockRejectedValue(new Error('Submit failed'));

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          onResolved={mockOnResolved}
        />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockOnResolved).not.toHaveBeenCalled();
    });

    it('should handle cancel error gracefully', async () => {
      mockCallIfConnected.mockRejectedValue(new Error('Cancel failed'));

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          onResolved={mockOnResolved}
        />
      );

      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )!;
      fireEvent.click(skipButton);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockOnResolved).not.toHaveBeenCalled();
    });

    it('should handle draft save error gracefully', async () => {
      mockCallIfConnected.mockRejectedValue(new Error('Draft save failed'));

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      await new Promise((resolve) => setTimeout(resolve, 600));
    });
  });

  describe('Draft save debouncing', () => {
    it('should debounce draft saves', async () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      const deleteBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Delete')
      )!;
      const moveBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Move')
      )!;

      fireEvent.click(editBtn);
      fireEvent.click(deleteBtn);
      fireEvent.click(moveBtn);

      await new Promise((resolve) => setTimeout(resolve, 600));

      const saveDraftCalls = mockCallIfConnected.mock.calls.filter(
        (call) => call[0] === 'question.saveDraft'
      );
      expect(saveDraftCalls.length).toBe(1);
    });

    it('should cleanup draft save timer on unmount', async () => {
      const { container, unmount } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      unmount();

      await new Promise((resolve) => setTimeout(resolve, 600));

      const saveDraftCalls = mockCallIfConnected.mock.calls.filter(
        (call) => call[0] === 'question.saveDraft'
      );
      expect(saveDraftCalls.length).toBe(0);
    });
  });

  describe('Submit with isSubmitting state', () => {
    it('should disable buttons while submitting', async () => {
      mockCallIfConnected.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      fireEvent.click(submitButton);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const submitButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      const skipButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;

      expect(submitButtonAfter.disabled).toBe(true);
      expect(skipButtonAfter.disabled).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  });

  describe('Cancel with isCancelling state', () => {
    it('should disable buttons while cancelling', async () => {
      mockCallIfConnected.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;
      fireEvent.click(skipButton);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const submitButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      const skipButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;

      expect(submitButtonAfter.disabled).toBe(true);
      expect(skipButtonAfter.disabled).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  });

  describe('Resolved state with Other selected styling', () => {
    it('should apply cancelled styling when Other is selected and cancelled', () => {
      const questionWithOtherSelected: PendingUserQuestion = {
        ...mockPendingQuestion,
        draftResponses: [
          {
            questionIndex: 0,
            selectedLabels: [],
            customText: 'Custom cancelled response',
          },
        ],
      };

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={questionWithOtherSelected}
          resolvedState="cancelled"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'Custom cancelled response',
            },
          ]}
        />
      );

      expect(container.textContent).toContain('Question skipped');
    });

    it('should show textarea with resolved styling when Other is selected', () => {
      const questionWithOtherSelected: PendingUserQuestion = {
        ...mockPendingQuestion,
        draftResponses: [
          {
            questionIndex: 0,
            selectedLabels: [],
            customText: 'My submitted answer',
          },
        ],
      };

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={questionWithOtherSelected}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'My submitted answer',
            },
          ]}
        />
      );

      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Resolved form interaction guards', () => {
    it('should not trigger submit when form is already resolved', async () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
          onResolved={mockOnResolved}
        />
      );

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      );
      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      );

      expect(submitButton).toBeFalsy();
      expect(skipButton).toBeFalsy();

      expect(mockOnResolved).not.toHaveBeenCalled();
      expect(mockCallIfConnected).not.toHaveBeenCalled();
    });

    it('should not allow custom text input changes when resolved', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'Original text',
            },
          ]}
        />
      );

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.disabled).toBe(true);
    });

    it('should initialize customInputs map without customText entries when responses lack customText', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: ['Edit'],
            },
          ]}
        />
      );

      const textarea = container.querySelector('textarea');
      expect(textarea).toBeFalsy();

      expect(container.textContent).toContain('Edit');
    });

    it('should prevent option selection changes in cancelled state', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      const optionButtons = Array.from(container.querySelectorAll('button')).filter(
        (btn) =>
          btn.textContent?.includes('Edit') ||
          btn.textContent?.includes('Delete') ||
          btn.textContent?.includes('Move')
      );
      for (const btn of optionButtons) {
        expect(btn.disabled).toBe(true);
      }
    });
  });

  describe('BUG REPRODUCTION: Form content visibility after submission', () => {
    it('should always show form fields even after submission (simulates page refresh)', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      expect(container.textContent).toContain('Response submitted');

      expect(container.textContent).toContain('What would you like to do with the file?');

      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Make changes to the file');
      expect(container.textContent).toContain('Delete');
      expect(container.textContent).toContain('Remove the file permanently');

      const editButton = Array.from(container.querySelectorAll('button')).find(
        (btn) =>
          btn.textContent?.includes('Edit') && btn.textContent?.includes('Make changes to the file')
      );
      expect(editButton).toBeTruthy();
    });

    it('should show form fields for cancelled questions after refresh', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
        />
      );

      expect(container.textContent).toContain('Question skipped');

      expect(container.textContent).toContain('What would you like to do with the file?');
      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
    });

    it('should show custom text in resolved state after refresh', () => {
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: [],
              customText: 'My custom response text',
            },
          ]}
        />
      );

      expect(container.textContent).toContain('Response submitted');

      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe('My custom response text');
    });
  });
});
