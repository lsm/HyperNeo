// @ts-nocheck

import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);
let mockDraftContent = '';

const mockSetContent = vi.fn(() => {});
const mockClearDraft = vi.fn(() => {});
const mockHoldDraftAdoption = vi.fn(async (fn: () => Promise<unknown>) => fn());
const mockClearAttachments = vi.fn(() => {});
const mockGetImagesForSend = vi.fn(() => undefined);
const mockRequest = vi.fn(async () => ({ messages: [] }));

let mockReferenceShowAutocomplete = false;
let mockReferenceResults = [];
let mockReferenceSelectedIndex = 0;
const mockReferenceHandleKeyDown = vi.fn(() => false);
const mockReferenceHandleSelect = vi.fn(() => {});
const mockReferenceClose = vi.fn(() => {});

let capturedOnSelect = null;

let mockCommandShowAutocomplete = false;
let mockCommandFilteredCommands = [];
const mockCommandHandleKeyDown = vi.fn(() => false);

vi.mock('../../lib/state.ts', () => ({
  globalSettings: { value: { voice: { enabled: false } } },
  connectionState: { value: 'connected' },
  get isAgentWorking() {
    return {
      get value() {
        return mockAgentWorking.value;
      },
    };
  },
}));

vi.mock('../../hooks', () => ({
  isVoiceRecordingSupported: () => false,
  useVoiceRecorder: () => ({
    isRecording: false,
    durationLimitHit: false,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ audioBase64: '', mimeType: 'audio/wav' })),
    cancel: vi.fn(async () => {}),
  }),
  useInputDraft: () => ({
    content: mockDraftContent,
    setContent: mockSetContent,
    clear: mockClearDraft,
    holdDraftAdoption: mockHoldDraftAdoption,
  }),
  useModelSwitcher: () => ({
    currentModel: 'mock-model',
    currentModelInfo: null,
    availableModels: [],
    switching: false,
    loading: false,
    switchModel: vi.fn(async () => {}),
  }),
  useModal: () => ({
    isOpen: false,
    toggle: vi.fn(() => {}),
    close: vi.fn(() => {}),
  }),
  useCommandAutocomplete: () => ({
    showAutocomplete: mockCommandShowAutocomplete,
    filteredCommands: mockCommandFilteredCommands,
    selectedIndex: 0,
    handleSelect: vi.fn(() => {}),
    close: vi.fn(() => {}),
    handleKeyDown: mockCommandHandleKeyDown,
  }),
  useReferenceAutocomplete: (opts) => {
    capturedOnSelect = opts.onSelect;
    return {
      showAutocomplete: mockReferenceShowAutocomplete,
      results: mockReferenceResults,
      selectedIndex: mockReferenceSelectedIndex,
      searchQuery: '',
      handleSelect: mockReferenceHandleSelect,
      close: mockReferenceClose,
      handleKeyDown: mockReferenceHandleKeyDown,
    };
  },
  extractActiveAtQuery: vi.fn((content) => {
    if (!content.includes('@')) return null;
    for (let i = content.length - 1; i >= 0; i--) {
      if (content[i] === '@') {
        const before = i === 0 ? '' : content[i - 1];
        const isWordStart = i === 0 || /\s/.test(before);
        if (!isWordStart) continue;
        const afterAt = content.slice(i + 1);
        if (/\s/.test(afterAt)) continue;
        return afterAt;
      }
    }
    return null;
  }),
  useFileAttachments: () => ({
    attachments: [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(() => {}),
    handleFileDrop: vi.fn(async () => {}),
    handleRemove: vi.fn(() => {}),
    clear: mockClearAttachments,
    openFilePicker: vi.fn(() => {}),
    getImagesForSend: mockGetImagesForSend,
    handlePaste: vi.fn(() => {}),
  }),
  useInterrupt: () => ({
    interrupting: false,
    handleInterrupt: vi.fn(async () => {}),
  }),
}));

vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHubIfConnected: () => ({ request: mockRequest, onEvent: vi.fn(() => vi.fn()) }),
  },
}));

import MessageInput from '../MessageInput';

describe('MessageInput reference autocomplete', () => {
  beforeEach(() => {
    cleanup();
    mockDraftContent = '';
    mockAgentWorking.value = false;
    mockSetContent.mockClear();
    mockClearDraft.mockClear();
    mockClearAttachments.mockClear();
    mockGetImagesForSend.mockClear();
    mockGetImagesForSend.mockReturnValue(undefined);
    mockRequest.mockClear();
    mockReferenceShowAutocomplete = false;
    mockReferenceResults = [];
    mockReferenceSelectedIndex = 0;
    mockReferenceHandleKeyDown.mockReturnValue(false);
    mockReferenceHandleKeyDown.mockClear();
    mockReferenceHandleSelect.mockClear();
    mockReferenceClose.mockClear();
    mockCommandShowAutocomplete = false;
    mockCommandFilteredCommands = [];
    mockCommandHandleKeyDown.mockReturnValue(false);
    mockCommandHandleKeyDown.mockClear();
    capturedOnSelect = null;
    document.documentElement.classList.remove('keyboard-open');
    document.querySelectorAll('[data-messages-container]').forEach((node) => node.remove());
    document.querySelectorAll('.chat-footer').forEach((node) => node.remove());
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn(() => ({ matches: false })),
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('keyboard-open');
    document.querySelectorAll('[data-messages-container]').forEach((node) => node.remove());
    document.querySelectorAll('.chat-footer').forEach((node) => node.remove());
  });

  function renderInput(onSend = vi.fn(async () => {})) {
    return render(<MessageInput sessionId="test-session" onSend={onSend} />);
  }

  it('renders the same transparent glass input shell used by the threaded composer', () => {
    const { container } = renderInput();
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    const shell = textarea.parentElement as HTMLDivElement;

    expect(shell.className).toContain('bg-transparent');
    expect(shell.className).toContain('backdrop-blur-sm');
    expect(shell.className).toContain('border-line-strong/80');
  });

  describe('keyboard event priority', () => {
    it('reference autocomplete handleKeyDown is called before command autocomplete', () => {
      const { container } = renderInput();
      const textarea = container.querySelector('textarea');

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });

      expect(mockReferenceHandleKeyDown).toHaveBeenCalledOnce();
    });

    it('command autocomplete handleKeyDown is NOT called when reference autocomplete handles the event', () => {
      mockReferenceHandleKeyDown.mockReturnValue(true);

      const { container } = renderInput();
      const textarea = container.querySelector('textarea');

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });

      expect(mockReferenceHandleKeyDown).toHaveBeenCalledOnce();
      expect(mockCommandHandleKeyDown).not.toHaveBeenCalled();
    });

    it('command autocomplete handleKeyDown IS called when reference autocomplete does not handle the event', () => {
      mockReferenceHandleKeyDown.mockReturnValue(false);

      const { container } = renderInput();
      const textarea = container.querySelector('textarea');

      fireEvent.keyDown(textarea, { key: 'ArrowDown' });

      expect(mockReferenceHandleKeyDown).toHaveBeenCalledOnce();
      expect(mockCommandHandleKeyDown).toHaveBeenCalledOnce();
    });

    it('Enter key submits form when neither autocomplete handles it', () => {
      mockReferenceHandleKeyDown.mockReturnValue(false);
      mockCommandHandleKeyDown.mockReturnValue(false);
      mockDraftContent = 'hello world';

      const onSend = vi.fn(async () => {});
      const { container } = render(<MessageInput sessionId="test-session" onSend={onSend} />);
      const textarea = container.querySelector('textarea');

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSend).toHaveBeenCalledOnce();
    });

    it('Enter key does NOT submit when reference autocomplete handles it', () => {
      mockReferenceHandleKeyDown.mockReturnValue(true);
      mockDraftContent = 'hello @task';

      const onSend = vi.fn(async () => {});
      const { container } = render(<MessageInput sessionId="test-session" onSend={onSend} />);
      const textarea = container.querySelector('textarea');

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('reference selection — content replacement', () => {
    it('replaces @query at end of content with @ref{type:id} token', () => {
      mockDraftContent = 'fix @task';
      renderInput();

      expect(capturedOnSelect).not.toBeNull();
      act(() => {
        capturedOnSelect({ type: 'task', id: 't-42', displayText: 'Fix login bug' });
      });

      expect(mockSetContent).toHaveBeenCalledWith('fix @ref{task:t-42} ');
    });

    it('replaces @query when combined with a slash command prefix', () => {
      mockDraftContent = '/agent @task';
      renderInput();

      expect(capturedOnSelect).not.toBeNull();
      act(() => {
        capturedOnSelect({ type: 'task', id: 't-99', displayText: 'Do something' });
      });

      expect(mockSetContent).toHaveBeenCalledWith('/agent @ref{task:t-99} ');
    });

    it('replaces @-only query (just @ with no query text)', () => {
      mockDraftContent = 'hello @';
      renderInput();

      expect(capturedOnSelect).not.toBeNull();
      act(() => {
        capturedOnSelect({ type: 'goal', id: 'g-5', displayText: 'Launch v2' });
      });

      expect(mockSetContent).toHaveBeenCalledWith('hello @ref{goal:g-5} ');
    });

    it('returns early without calling setContent when no active @query in content', () => {
      mockDraftContent = 'no at-sign here';
      renderInput();

      expect(capturedOnSelect).not.toBeNull();
      act(() => {
        capturedOnSelect({ type: 'task', id: 't-1', displayText: 'Something' });
      });

      expect(mockSetContent).not.toHaveBeenCalled();
    });
  });

  describe('menu visibility — no overlap', () => {
    it('suppresses command autocomplete when reference autocomplete is visible', () => {
      mockReferenceShowAutocomplete = true;
      mockCommandShowAutocomplete = true;
      mockCommandFilteredCommands = ['agent', 'compact'];
      mockReferenceResults = [{ type: 'task', id: 't-1', displayText: 'Some task' }];

      const { getByText, queryByText } = renderInput();

      expect(getByText('References')).toBeTruthy();
      expect(queryByText('Slash Commands')).toBeNull();
    });

    it('shows command autocomplete when reference autocomplete is hidden', () => {
      mockReferenceShowAutocomplete = false;
      mockCommandShowAutocomplete = true;
      mockCommandFilteredCommands = ['agent', 'compact'];

      const { getByText } = renderInput();

      expect(getByText('Slash Commands')).toBeTruthy();
    });
  });

  describe('InputTextarea receives reference autocomplete props', () => {
    it('passes showReferenceAutocomplete=false when autocomplete is hidden', () => {
      mockReferenceShowAutocomplete = false;
      mockReferenceResults = [];

      const { container } = renderInput();

      expect(container.textContent).not.toContain('References');
    });

    it('passes showReferenceAutocomplete=true and renders menu when results are present', () => {
      mockReferenceShowAutocomplete = true;
      mockReferenceResults = [
        {
          type: 'task',
          id: 't-42',
          shortId: 't-42',
          displayText: 'Fix the login bug',
          subtitle: 'in progress',
        },
      ];

      const { getByText } = renderInput();

      expect(getByText('References')).toBeTruthy();
      expect(getByText('Fix the login bug')).toBeTruthy();
    });

    it('passes selectedReferenceIndex to the autocomplete menu', () => {
      mockReferenceShowAutocomplete = true;
      mockReferenceSelectedIndex = 1;
      mockReferenceResults = [
        { type: 'task', id: 't-1', displayText: 'First task' },
        { type: 'task', id: 't-2', displayText: 'Second task' },
      ];

      const { container } = renderInput();

      const resultButtons = container.querySelectorAll('button[type="button"]');
      const refButtons = Array.from(resultButtons).filter(
        (b) => b.textContent?.includes('First task') || b.textContent?.includes('Second task')
      );
      expect(refButtons).toHaveLength(2);
      expect(refButtons[1].className).toContain('border-accent');
      expect(refButtons[0].className).not.toContain('border-accent');
    });
  });
});
