// @ts-nocheck

import { renderHook, act, waitFor } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@preact/signals';
import type { RefObject } from 'preact';

vi.mock('../useFileAttachments.ts', () => ({
  useFileAttachments: vi.fn(() => ({
    attachments: [],
    fileInputRef: { current: null },
    handleFileSelect: vi.fn(async () => {}),
    handleFileDrop: vi.fn(async () => {}),
    handleRemove: vi.fn(),
    clear: vi.fn(),
    openFilePicker: vi.fn(),
    getImagesForSend: vi.fn(() => undefined),
    handlePaste: vi.fn(),
  })),
}));

vi.mock('../useAutoScroll.ts', () => ({
  useAutoScroll: vi.fn(() => ({
    showScrollButton: false,
    scrollToBottom: vi.fn(),
    isNearBottom: true,
  })),
}));

import { useChatBase } from '../useChatBase.ts';
import { useFileAttachments } from '../useFileAttachments.ts';
import { useAutoScroll } from '../useAutoScroll.ts';

const mockUseFileAttachments = vi.mocked(useFileAttachments);
const mockUseAutoScroll = vi.mocked(useAutoScroll);

function createDefaultOptions(overrides = {}) {
  return {
    chatId: 'test-chat-id',
    sendMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('useChatBase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();

    mockUseFileAttachments.mockReturnValue({
      attachments: [],
      fileInputRef: { current: null },
      handleFileSelect: vi.fn(async () => {}),
      handleFileDrop: vi.fn(async () => {}),
      handleRemove: vi.fn(),
      clear: vi.fn(),
      openFilePicker: vi.fn(),
      getImagesForSend: vi.fn(() => undefined),
      handlePaste: vi.fn(),
    });

    mockUseAutoScroll.mockReturnValue({
      showScrollButton: false,
      scrollToBottom: vi.fn(),
      isNearBottom: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should initialize with empty input', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.input).toBe('');
    });

    it('should initialize with sending false', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.sending).toBe(false);
    });

    it('should initialize with no error', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.error).toBeNull();
    });

    it('should initialize with canSend true', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.canSend).toBe(true);
    });

    it('should provide all required functions and values', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(typeof result.current.input).toBe('string');
      expect(typeof result.current.setInput).toBe('function');
      expect(typeof result.current.handleInput).toBe('function');

      expect(typeof result.current.sending).toBe('boolean');
      expect(typeof result.current.sendMessage).toBe('function');
      expect(typeof result.current.canSend).toBe('boolean');

      expect(typeof result.current.handleKeyDown).toBe('function');

      expect(Array.isArray(result.current.attachments)).toBe(true);
      expect(result.current.fileInputRef).toBeDefined();
      expect(typeof result.current.handleFileSelect).toBe('function');
      expect(typeof result.current.handleFileDrop).toBe('function');
      expect(typeof result.current.handleRemoveAttachment).toBe('function');
      expect(typeof result.current.openFilePicker).toBe('function');
      expect(typeof result.current.handlePaste).toBe('function');
      expect(typeof result.current.clearAttachments).toBe('function');

      expect(result.current.messagesContainerRef).toBeDefined();
      expect(result.current.messagesEndRef).toBeDefined();
      expect(typeof result.current.showScrollButton).toBe('boolean');
      expect(typeof result.current.scrollToBottom).toBe('function');

      expect(result.current.error).toBeNull();
      expect(typeof result.current.clearError).toBe('function');
    });

    it('should provide refs for auto-scroll', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.messagesContainerRef).toEqual({ current: null });
      expect(result.current.messagesEndRef).toEqual({ current: null });
    });
  });

  describe('input state management', () => {
    it('should update input via setInput', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Hello world');
      });

      expect(result.current.input).toBe('Hello world');
    });

    it('should update input via handleInput event', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      const mockEvent = {
        target: { value: 'Typed text' },
      } as unknown as Event;

      act(() => {
        result.current.handleInput(mockEvent);
      });

      expect(result.current.input).toBe('Typed text');
    });

    it('should clear error when input changes', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.sendMessage();
      });

      expect(result.current.error).toBe('Message cannot be empty');

      const mockEvent = {
        target: { value: 'New text' },
      } as unknown as Event;

      act(() => {
        result.current.handleInput(mockEvent);
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('sendMessage validation', () => {
    it('should show error when sending empty message', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.error).toBe('Message cannot be empty');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should show error when sending whitespace-only message', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('   \n\t  ');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.error).toBe('Message cannot be empty');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should show error when message exceeds maxChars', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage, maxChars: 10 });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('This is a very long message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.error).toBe('Message exceeds 10 character limit');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should call onValidationError callback instead of setting error when provided', async () => {
      const sendMessage = vi.fn(async () => {});
      const onValidationError = vi.fn();
      const options = createDefaultOptions({ sendMessage, onValidationError });
      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(onValidationError).toHaveBeenCalledWith('Message cannot be empty');
      expect(result.current.error).toBeNull();
    });

    it('should allow sending when only attachments exist (no text)', async () => {
      const sendMessage = vi.fn(async () => {});

      mockUseFileAttachments.mockReturnValue({
        attachments: [{ data: 'base64', media_type: 'image/png', name: 'test.png', size: 100 }],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => [{ data: 'base64', media_type: 'image/png' }]),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(sendMessage).toHaveBeenCalled();
      expect(result.current.error).toBeNull();
    });
  });

  describe('sendMessage success', () => {
    it('should call sendMessage with trimmed content', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('  Hello world  ');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(sendMessage).toHaveBeenCalledWith('Hello world', undefined);
    });

    it('should set sending to true during send', async () => {
      let resolveSend: () => void;
      const sendMessage = vi.fn(() => new Promise<void>((resolve) => (resolveSend = resolve)));
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      let sendPromise: Promise<void>;
      act(() => {
        sendPromise = result.current.sendMessage();
      });

      expect(result.current.sending).toBe(true);
      expect(result.current.canSend).toBe(false);

      resolveSend!();
      await act(async () => {
        await sendPromise;
      });

      expect(result.current.sending).toBe(false);
      expect(result.current.canSend).toBe(true);
    });

    it('should reset input after successful send', async () => {
      const sendMessage = vi.fn(async () => {});
      const mockClear = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: mockClear,
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.input).toBe('');
      expect(mockClear).toHaveBeenCalled();
    });

    it('should call scrollToBottom after successful send', async () => {
      const sendMessage = vi.fn(async () => {});
      const mockScrollToBottom = vi.fn();

      mockUseAutoScroll.mockReturnValue({
        showScrollButton: false,
        scrollToBottom: mockScrollToBottom,
        isNearBottom: true,
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockScrollToBottom).toHaveBeenCalled();
    });
  });

  describe('sendMessage error handling', () => {
    it('should set error when sendMessage throws', async () => {
      const sendMessage = vi.fn(async () => {
        throw new Error('Network error');
      });
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.error).toBe('Network error');
    });

    it('should handle non-Error throws', async () => {
      const sendMessage = vi.fn(async () => {
        throw 'Something went wrong';
      });
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.error).toBe('Failed to send message');
    });

    it('should not reset input when send fails', async () => {
      const sendMessage = vi.fn(async () => {
        throw new Error('Send failed');
      });
      const mockClear = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: mockClear,
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.input).toBe('Test message');
      expect(mockClear).not.toHaveBeenCalled();
    });

    it('should reset sending state even on error', async () => {
      const sendMessage = vi.fn(async () => {
        throw new Error('Send failed');
      });
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(result.current.sending).toBe(false);
      expect(result.current.canSend).toBe(true);
    });
  });

  describe('error management', () => {
    it('should clear error via clearError', () => {
      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.sendMessage();
      });

      expect(result.current.error).toBe('Message cannot be empty');

      act(() => {
        result.current.clearError();
      });

      expect(result.current.error).toBeNull();
    });
  });

  describe('keyboard handling', () => {
    it('should send message on Enter key in textarea', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      const mockEvent = {
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: { tagName: 'TEXTAREA' },
      } as unknown as KeyboardEvent;

      await act(async () => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(mockEvent.preventDefault).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith('Test message', undefined);
    });

    it('should not send on Shift+Enter', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      const mockEvent = {
        key: 'Enter',
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: { tagName: 'TEXTAREA' },
      } as unknown as KeyboardEvent;

      await act(async () => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should not send on Ctrl+Enter', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      const mockEvent = {
        key: 'Enter',
        shiftKey: false,
        ctrlKey: true,
        metaKey: false,
        preventDefault: vi.fn(),
        target: { tagName: 'TEXTAREA' },
      } as unknown as KeyboardEvent;

      await act(async () => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should not send on Meta+Enter (Cmd+Enter)', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      const mockEvent = {
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: true,
        preventDefault: vi.fn(),
        target: { tagName: 'TEXTAREA' },
      } as unknown as KeyboardEvent;

      await act(async () => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should not send on Enter in input element (only textarea)', async () => {
      const sendMessage = vi.fn(async () => {});
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      const mockEvent = {
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: { tagName: 'INPUT' },
      } as unknown as KeyboardEvent;

      await act(async () => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(mockEvent.preventDefault).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('should not send when already sending', async () => {
      let resolveSend: () => void;
      const sendMessage = vi.fn(() => new Promise<void>((resolve) => (resolveSend = resolve)));
      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Test message');
      });

      let firstSendPromise: Promise<void>;
      act(() => {
        firstSendPromise = result.current.sendMessage();
      });

      expect(result.current.sending).toBe(true);

      const mockEvent = {
        key: 'Enter',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        target: { tagName: 'TEXTAREA' },
      } as unknown as KeyboardEvent;

      act(() => {
        result.current.handleKeyDown(mockEvent);
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);

      resolveSend!();
      await act(async () => {
        await firstSendPromise;
      });
    });
  });

  describe('file attachments integration', () => {
    it('should expose file attachments from useFileAttachments', () => {
      const mockAttachments = [
        { data: 'base64', media_type: 'image/png', name: 'test.png', size: 100 },
      ];

      mockUseFileAttachments.mockReturnValue({
        attachments: mockAttachments,
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => [{ data: 'base64', media_type: 'image/png' }]),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.attachments).toEqual(mockAttachments);
    });

    it('should call handleFileSelect', async () => {
      const mockHandleFileSelect = vi.fn(async () => {});

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: mockHandleFileSelect,
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      const mockEvent = {} as Event;

      await act(async () => {
        await result.current.handleFileSelect(mockEvent);
      });

      expect(mockHandleFileSelect).toHaveBeenCalledWith(mockEvent);
    });

    it('should call handleFileDrop with adapted files', () => {
      const mockHandleFileDrop = vi.fn(async () => {});

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: mockHandleFileDrop,
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      const files = [new File(['test'], 'test.png', { type: 'image/png' })];

      act(() => {
        result.current.handleFileDrop(files);
      });

      expect(mockHandleFileDrop).toHaveBeenCalled();
    });

    it('should call handleRemoveAttachment', () => {
      const mockHandleRemove = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: mockHandleRemove,
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.handleRemoveAttachment(0);
      });

      expect(mockHandleRemove).toHaveBeenCalledWith(0);
    });

    it('should call openFilePicker', () => {
      const mockOpenFilePicker = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: mockOpenFilePicker,
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.openFilePicker();
      });

      expect(mockOpenFilePicker).toHaveBeenCalled();
    });

    it('should call handlePaste', async () => {
      const mockHandlePaste = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: mockHandlePaste,
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      const mockEvent = {} as ClipboardEvent;

      await act(async () => {
        await result.current.handlePaste(mockEvent);
      });

      expect(mockHandlePaste).toHaveBeenCalledWith(mockEvent);
    });

    it('should call clearAttachments', () => {
      const mockClear = vi.fn();

      mockUseFileAttachments.mockReturnValue({
        attachments: [],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: mockClear,
        openFilePicker: vi.fn(),
        getImagesForSend: vi.fn(() => undefined),
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.clearAttachments();
      });

      expect(mockClear).toHaveBeenCalled();
    });

    it('should include images from attachments in sendMessage', async () => {
      const sendMessage = vi.fn(async () => {});
      const mockGetImagesForSend = vi.fn(() => [
        { data: 'base64imagedata', media_type: 'image/png' },
      ]);

      mockUseFileAttachments.mockReturnValue({
        attachments: [
          { data: 'base64imagedata', media_type: 'image/png', name: 'test.png', size: 100 },
        ],
        fileInputRef: { current: null },
        handleFileSelect: vi.fn(async () => {}),
        handleFileDrop: vi.fn(async () => {}),
        handleRemove: vi.fn(),
        clear: vi.fn(),
        openFilePicker: vi.fn(),
        getImagesForSend: mockGetImagesForSend,
        handlePaste: vi.fn(),
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Check this image');
      });

      await act(async () => {
        await result.current.sendMessage();
      });

      expect(mockGetImagesForSend).toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledWith('Check this image', [
        { data: 'base64imagedata', media_type: 'image/png' },
      ]);
    });
  });

  describe('auto-scroll integration', () => {
    it('should expose showScrollButton from useAutoScroll', () => {
      mockUseAutoScroll.mockReturnValue({
        showScrollButton: true,
        scrollToBottom: vi.fn(),
        isNearBottom: false,
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.showScrollButton).toBe(true);
    });

    it('should expose scrollToBottom from useAutoScroll', () => {
      const mockScrollToBottom = vi.fn();

      mockUseAutoScroll.mockReturnValue({
        showScrollButton: false,
        scrollToBottom: mockScrollToBottom,
        isNearBottom: true,
      });

      const options = createDefaultOptions();
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.scrollToBottom(true);
      });

      expect(mockScrollToBottom).toHaveBeenCalledWith(true);
    });

    it('should pass messages signal to useAutoScroll for message count', () => {
      const messages = signal([{ id: '1', role: 'user', content: 'Hello' }]);

      const options = createDefaultOptions({ messages });
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: 1,
        })
      );
    });

    it('should pass 0 message count when messages signal not provided', () => {
      const options = createDefaultOptions();
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: 0,
        })
      );
    });

    it('should pass autoScrollEnabled option to useAutoScroll', () => {
      const options = createDefaultOptions({ autoScrollEnabled: false });
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
        })
      );
    });

    it('should pass nearBottomThreshold option to useAutoScroll', () => {
      const options = createDefaultOptions({ nearBottomThreshold: 100 });
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          nearBottomThreshold: 100,
        })
      );
    });

    it('should use default autoScrollEnabled of true', () => {
      const options = createDefaultOptions();
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: true,
        })
      );
    });

    it('should use default nearBottomThreshold of 200', () => {
      const options = createDefaultOptions();
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          nearBottomThreshold: 200,
        })
      );
    });
  });

  describe('draft persistence', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should load draft on mount when persistDraft is enabled', async () => {
      const loadDraft = vi.fn(async () => 'Saved draft content');
      const saveDraft = vi.fn(async () => {});

      const options = createDefaultOptions({
        persistDraft: true,
        loadDraft,
        saveDraft,
      });

      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(loadDraft).toHaveBeenCalled();
      expect(result.current.input).toBe('Saved draft content');
    });

    it('should not load draft when persistDraft is false', async () => {
      const loadDraft = vi.fn(async () => 'Saved draft content');

      const options = createDefaultOptions({
        persistDraft: false,
        loadDraft,
      });

      renderHook(() => useChatBase(options));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(loadDraft).not.toHaveBeenCalled();
    });

    it('should not load draft when loadDraft is not provided', async () => {
      const options = createDefaultOptions({
        persistDraft: true,
      });

      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(result.current.input).toBe('');
    });

    it('should handle loadDraft returning undefined', async () => {
      const loadDraft = vi.fn(async () => undefined);

      const options = createDefaultOptions({
        persistDraft: true,
        loadDraft,
      });

      const { result } = renderHook(() => useChatBase(options));

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(loadDraft).toHaveBeenCalled();
      expect(result.current.input).toBe('');
    });

    it('should save draft when input changes (debounced)', async () => {
      const saveDraft = vi.fn(async () => {});

      const options = createDefaultOptions({
        persistDraft: true,
        saveDraft,
      });

      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('New input');
      });

      expect(saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(saveDraft).toHaveBeenCalledWith('New input');
    });

    it('should debounce draft saves', async () => {
      const saveDraft = vi.fn(async () => {});

      const options = createDefaultOptions({
        persistDraft: true,
        saveDraft,
      });

      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('A');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      act(() => {
        result.current.setInput('AB');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      act(() => {
        result.current.setInput('ABC');
      });

      expect(saveDraft).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(saveDraft).toHaveBeenCalledTimes(1);
      expect(saveDraft).toHaveBeenCalledWith('ABC');
    });

    it('should not save draft when persistDraft is false', async () => {
      const saveDraft = vi.fn(async () => {});

      const options = createDefaultOptions({
        persistDraft: false,
        saveDraft,
      });

      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('New input');
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(saveDraft).not.toHaveBeenCalled();
    });

    it('should clear draft save timeout on unmount', async () => {
      const saveDraft = vi.fn(async () => {});

      const options = createDefaultOptions({
        persistDraft: true,
        saveDraft,
      });

      const { result, unmount } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('New input');
      });

      unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(saveDraft).not.toHaveBeenCalled();
    });

    it('should reload draft when chatId changes', async () => {
      const loadDraft = vi.fn(async () => 'Draft for new chat');

      const options = createDefaultOptions({
        persistDraft: true,
        loadDraft,
      });

      const { rerender } = renderHook(({ chatId }) => useChatBase({ ...options, chatId }), {
        initialProps: { chatId: 'chat-1' },
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(loadDraft).toHaveBeenCalledTimes(1);

      loadDraft.mockClear();

      rerender({ chatId: 'chat-2' });

      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(loadDraft).toHaveBeenCalledTimes(1);
    });
  });

  describe('function stability', () => {
    it('should return stable function references', () => {
      const options = createDefaultOptions();
      const { result, rerender } = renderHook(() => useChatBase(options));

      const firstHandleInput = result.current.handleInput;
      const firstSendMessage = result.current.sendMessage;
      const firstHandleKeyDown = result.current.handleKeyDown;
      const firstClearError = result.current.clearError;

      rerender();

      expect(result.current.handleInput).toBe(firstHandleInput);
      expect(result.current.sendMessage).toBe(firstSendMessage);
      expect(result.current.handleKeyDown).toBe(firstHandleKeyDown);
      expect(result.current.clearError).toBe(firstClearError);
    });
  });

  describe('edge cases', () => {
    it('should handle rapid consecutive sends gracefully', async () => {
      const sendMessage = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      const options = createDefaultOptions({ sendMessage });
      const { result } = renderHook(() => useChatBase(options));

      act(() => {
        result.current.setInput('Message 1');
      });

      let sendPromise: Promise<void>;
      act(() => {
        sendPromise = result.current.sendMessage();
      });

      act(() => {
        result.current.setInput('Message 2');
      });

      act(() => {
        result.current.handleKeyDown({
          key: 'Enter',
          shiftKey: false,
          ctrlKey: false,
          metaKey: false,
          preventDefault: vi.fn(),
          target: { tagName: 'TEXTAREA' },
        } as unknown as KeyboardEvent);
      });

      await act(async () => {
        await sendPromise;
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith('Message 1', undefined);
    });

    it('should handle messages signal being undefined', () => {
      const options = createDefaultOptions({ messages: undefined });
      const { result } = renderHook(() => useChatBase(options));

      expect(result.current.canSend).toBe(true);
    });

    it('should handle messages signal with empty array', () => {
      const messages = signal([]);

      const options = createDefaultOptions({ messages });
      renderHook(() => useChatBase(options));

      expect(mockUseAutoScroll).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: 0,
        })
      );
    });

    it('should work with custom message type', () => {
      interface CustomMessage {
        id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        timestamp: number;
      }

      const messages = signal<CustomMessage[]>([
        { id: '1', role: 'user', content: 'Hello', timestamp: Date.now() },
      ]);

      const options = createDefaultOptions({ messages });
      const { result } = renderHook(() => useChatBase<CustomMessage>(options));

      expect(result.current.canSend).toBe(true);
    });
  });
});
