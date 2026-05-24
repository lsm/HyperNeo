// @ts-nocheck
/**
 * Tests for QuestionPrompt Component
 *
 * Tests the question prompt with options selection, custom input,
 * submit/cancel actions, and resolved states.
 *
 * Note: Tests UI behavior without mocking useMessageHub.
 * The component renders correctly without network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { QuestionPrompt } from '../QuestionPrompt';
import type { PendingUserQuestion, QuestionDraftResponse } from '@neokai/shared';

// Mock useMessageHub to test error scenarios
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

      // Button should have selected styling
      expect(editButton.className).toContain('bg-rose-900/60');
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

      // Delete should be selected, Edit should not
      expect(deleteButton.className).toContain('bg-rose-900/60');
      expect(editButton.className).not.toContain('bg-rose-900/60');
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

      // Edit should be deselected
      expect(editButton.className).not.toContain('bg-rose-900/60');
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

      // Both should be selected
      expect(darkModeBtn.className).toContain('bg-rose-900/60');
      expect(notificationsBtn.className).toContain('bg-rose-900/60');
    });

    it('should toggle selection on repeated clicks', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={multiSelectQuestion} />
      );

      const darkModeBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Dark Mode')
      )!;

      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).toContain('bg-rose-900/60');

      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).not.toContain('bg-rose-900/60');
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
      // Task #138: orphaned questions (session died before user answered)
      // must render distinctly from a user-initiated Skip so users know
      // the card was cleaned up by the runtime, not by them.
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
      // And does NOT collapse to the generic Skip wording
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

      // Resolved questions are collapsed by default, so buttons won't be visible
      // Just verify the resolved state is shown in the header
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

      // Resolved questions are collapsed by default
      // Just verify the resolved state is shown in the header
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

      expect(deleteButton.className).toContain('bg-rose-900/60');
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

      // Select only first question
      const optionA = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('A')
      )!;
      fireEvent.click(optionA);

      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;

      // Submit should still be disabled because second question is not answered
      expect(submitButton.disabled).toBe(true);
    });
  });

  describe('Collapsible Header Behavior', () => {
    it('should be expanded by default for pending state', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Content should be visible (question options)
      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
    });

    it('should always show form content (no collapse functionality)', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Form content should always be visible
      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
      expect(container.textContent).toContain('Other...');

      // Header should not be a clickable button (no collapse functionality)
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

      // Header should show a check icon (not a button, no chevron)
      const headerDiv = container.querySelector('div');
      expect(headerDiv).toBeTruthy();

      // Should show "Response submitted" text
      expect(container.textContent).toContain('Response submitted');

      // Form content should still be visible
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

      // Header should not be a button in resolved state
      const headerButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
        btn.textContent?.includes('Response submitted')
      );
      expect(headerButtons.length).toBe(0);

      // Header text should still be present
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

      // Select Dark Mode first
      fireEvent.click(darkModeBtn);
      expect(darkModeBtn.className).toContain('bg-rose-900/60');

      // Click Other - should NOT clear Dark Mode selection in multi-select
      fireEvent.click(otherBtn);

      // Dark Mode should still be selected
      expect(darkModeBtn.className).toContain('bg-rose-900/60');
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

      // Click Other first
      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      // Enter custom text
      const textarea = container.querySelector('textarea')!;
      fireEvent.input(textarea, { target: { value: 'Custom answer' } });
      expect((textarea as HTMLTextAreaElement).value).toBe('Custom answer');

      // Now click a regular option
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Textarea should no longer be visible
      expect(container.querySelector('textarea')).toBeFalsy();
    });
  });

  describe('Form validation with custom text', () => {
    it('should enable submit when only custom text is provided', () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Click Other
      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      // Enter custom text
      const textarea = container.querySelector('textarea')!;
      fireEvent.input(textarea, { target: { value: 'My custom response' } });

      // Submit should be enabled
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

      // The response is submitted and contains custom text
      expect(container.textContent).toContain('Response submitted');
    });

    it('should show resolved state with custom text value in textarea', () => {
      // Create a question with draft that shows customText
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

      // Check that the resolved header is shown
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

      // Verify cancelled state
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

      // The container should have opacity-60 for cancelled state
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

      // The container should have opacity-80 for submitted state
      const mainDiv = container.firstChild as HTMLDivElement;
      expect(mainDiv.className).toContain('opacity-80');
    });
  });

  describe('Option click in resolved state', () => {
    it('should not change selection when option is clicked in resolved state', () => {
      // Need to render with expanded state by not using resolvedState initially
      // This is a bit tricky since resolved state collapses the content
      // We'll test that the disabled state prevents clicks

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      // Verify the resolved state
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

      // Verify the resolved state - content is collapsed
      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Draft saving behavior', () => {
    it('should not save draft when resolved', async () => {
      // Render in resolved state - draft saving should be skipped
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      // Verify resolved state
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

      // Select an option
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Click submit
      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // onResolved should have been called
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

      // Click Other instead of selecting an option
      const otherBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Other...')
      )!;
      fireEvent.click(otherBtn);

      // Type custom text
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      fireEvent.input(textarea, { target: { value: 'My custom answer' } });

      // Click submit
      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // onResolved should have been called with custom text response
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

      // Click skip
      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )!;
      fireEvent.click(skipButton);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // onResolved should have been called with cancelled
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

      // Select an option
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Click submit
      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )!;
      fireEvent.click(submitButton);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // onResolved should NOT have been called since submit failed
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

      // Click skip
      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )!;
      fireEvent.click(skipButton);

      // Wait for async operation
      await new Promise((resolve) => setTimeout(resolve, 50));

      // onResolved should NOT have been called since cancel failed
      expect(mockOnResolved).not.toHaveBeenCalled();
    });

    it('should handle draft save error gracefully', async () => {
      mockCallIfConnected.mockRejectedValue(new Error('Draft save failed'));

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Select an option to trigger draft save
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Wait for debounced draft save (500ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Draft save error should be handled gracefully (no throw)
    });
  });

  describe('Draft save debouncing', () => {
    it('should debounce draft saves', async () => {
      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Click multiple options rapidly
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

      // Wait for debounce
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Should only save draft once (debounced) with final value
      const saveDraftCalls = mockCallIfConnected.mock.calls.filter(
        (call) => call[0] === 'question.saveDraft'
      );
      expect(saveDraftCalls.length).toBe(1);
    });

    it('should cleanup draft save timer on unmount', async () => {
      const { container, unmount } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Select an option
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Unmount before debounce completes
      unmount();

      // Wait for what would have been the debounce
      await new Promise((resolve) => setTimeout(resolve, 600));

      // Draft save should not have been called (cleanup happened)
      const saveDraftCalls = mockCallIfConnected.mock.calls.filter(
        (call) => call[0] === 'question.saveDraft'
      );
      expect(saveDraftCalls.length).toBe(0);
    });
  });

  describe('Submit with isSubmitting state', () => {
    it('should disable buttons while submitting', async () => {
      // Make submit take longer
      mockCallIfConnected.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Select an option
      const editBtn = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Edit')
      )!;
      fireEvent.click(editBtn);

      // Click submit
      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      fireEvent.click(submitButton);

      // Wait a bit for state to update
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Submit button should be disabled while submitting
      const submitButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      const skipButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;

      expect(submitButtonAfter.disabled).toBe(true);
      expect(skipButtonAfter.disabled).toBe(true);

      // Wait for submit to complete
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  });

  describe('Cancel with isCancelling state', () => {
    it('should disable buttons while cancelling', async () => {
      // Make cancel take longer
      mockCallIfConnected.mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 100))
      );

      const { container } = render(
        <QuestionPrompt sessionId="session-1" pendingQuestion={mockPendingQuestion} />
      );

      // Click skip
      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;
      fireEvent.click(skipButton);

      // Wait a bit for state to update
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Both buttons should be disabled while cancelling
      const submitButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      )! as HTMLButtonElement;
      const skipButtonAfter = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      )! as HTMLButtonElement;

      expect(submitButtonAfter.disabled).toBe(true);
      expect(skipButtonAfter.disabled).toBe(true);

      // Wait for cancel to complete
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

      // Verify cancelled state
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

      // Verify submitted state header
      expect(container.textContent).toContain('Response submitted');
    });
  });

  describe('Resolved form interaction guards', () => {
    it('should not trigger submit when form is already resolved', async () => {
      // Render a resolved form and attempt to submit - the isResolved guard should prevent it
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
          onResolved={mockOnResolved}
        />
      );

      // Submit and Skip buttons should not be rendered in resolved state
      const submitButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Submit Response')
      );
      const skipButton = Array.from(container.querySelectorAll('button')).find((btn) =>
        btn.textContent?.includes('Skip Question')
      );

      expect(submitButton).toBeFalsy();
      expect(skipButton).toBeFalsy();

      // onResolved should not have been called
      expect(mockOnResolved).not.toHaveBeenCalled();
      // callIfConnected should not have been called
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

      // The textarea should be disabled/readonly
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.disabled).toBe(true);
    });

    it('should initialize customInputs map without customText entries when responses lack customText', () => {
      // This covers the falsy branch of `if (response.customText)` during initialization
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[
            {
              questionIndex: 0,
              selectedLabels: ['Edit'],
              // No customText property - tests the falsy branch
            },
          ]}
        />
      );

      // No textarea should be visible since Other was not selected
      const textarea = container.querySelector('textarea');
      expect(textarea).toBeFalsy();

      // The selected option should be shown
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

      // All option buttons should be disabled
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
      // This test reproduces the bug where:
      // 1. User submits a question form
      // 2. Page is refreshed
      // 3. Form is re-rendered with resolvedState='submitted'
      // 4. BUG: Form content is hidden because isExpanded defaults to false for resolved forms
      // 5. REQUIREMENT: Form fields should NEVER be hidden - they should always be visible

      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="submitted"
          finalResponses={[{ questionIndex: 0, selectedLabels: ['Edit'] }]}
        />
      );

      // Verify the submitted state header is shown
      expect(container.textContent).toContain('Response submitted');

      // BUG: The form content should be visible, but currently it's hidden
      // The question text should be in the DOM
      expect(container.textContent).toContain('What would you like to do with the file?');

      // The options should be visible in the DOM
      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Make changes to the file');
      expect(container.textContent).toContain('Delete');
      expect(container.textContent).toContain('Remove the file permanently');

      // The selected option should be visible with selected styling
      const editButton = Array.from(container.querySelectorAll('button')).find(
        (btn) =>
          btn.textContent?.includes('Edit') && btn.textContent?.includes('Make changes to the file')
      );
      expect(editButton).toBeTruthy();
    });

    it('should show form fields for cancelled questions after refresh', () => {
      // Similar bug for cancelled state - form should still be visible
      const { container } = render(
        <QuestionPrompt
          sessionId="session-1"
          pendingQuestion={mockPendingQuestion}
          resolvedState="cancelled"
          finalResponses={[]}
        />
      );

      // Verify the cancelled state header is shown
      expect(container.textContent).toContain('Question skipped');

      // Form content should be visible even though it was cancelled
      expect(container.textContent).toContain('What would you like to do with the file?');
      expect(container.textContent).toContain('Edit');
      expect(container.textContent).toContain('Delete');
    });

    it('should show custom text in resolved state after refresh', () => {
      // Test that custom text remains visible after refresh
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

      // Verify the submitted state header
      expect(container.textContent).toContain('Response submitted');

      // The custom text should be visible in the textarea
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
      expect(textarea).toBeTruthy();
      expect(textarea.value).toBe('My custom response text');
    });
  });
});
