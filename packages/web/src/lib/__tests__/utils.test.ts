// @ts-nocheck

import { cn, copyToClipboard, formatRelativeTime, formatTokens } from '../utils';

describe('cn', () => {
  it('should merge single class name', () => {
    expect(cn('foo')).toBe('foo');
  });

  it('should merge multiple class names', () => {
    expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz');
  });

  it('should handle conditional classes', () => {
    const showBar = true;
    const showBaz = false;
    expect(cn('foo', showBar && 'bar', showBaz && 'baz')).toBe('foo bar');
  });

  it('should handle arrays of classes', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  it('should handle objects with class conditions', () => {
    expect(cn({ foo: true, bar: false, baz: true })).toBe('foo baz');
  });

  it('should handle mixed inputs', () => {
    expect(cn('base', ['array-class'], { conditional: true })).toBe('base array-class conditional');
  });

  it('should filter out falsy values', () => {
    expect(cn('foo', null, undefined, '', 'bar')).toBe('foo bar');
  });

  it('should handle empty inputs', () => {
    expect(cn()).toBe('');
  });

  it('should handle nested arrays', () => {
    expect(cn(['foo', ['bar', 'baz']])).toBe('foo bar baz');
  });
});

describe('copyToClipboard', () => {
  let originalClipboard: typeof navigator.clipboard;
  let originalDocument: typeof document;
  let warnSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    originalClipboard = navigator.clipboard;
    originalDocument = global.document;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should use Clipboard API when available', async () => {
    const mockWriteText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });

    const result = await copyToClipboard('test text');
    expect(result).toBe(true);
    expect(mockWriteText).toHaveBeenCalledWith('test text');
  });

  it('should return false when Clipboard API fails and fallback fails', async () => {
    const mockWriteText = vi.fn(() => Promise.reject(new Error('Permission denied')));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });

    const mockExecCommand = vi.fn(() => false);
    const mockTextarea = {
      value: '',
      style: {},
      focus: vi.fn(() => {}),
      select: vi.fn(() => {}),
    };
    const mockCreateElement = vi.fn(() => mockTextarea);
    const mockAppendChild = vi.fn(() => {});
    const mockRemoveChild = vi.fn(() => {});

    global.document = {
      ...originalDocument,
      createElement: mockCreateElement,
      body: {
        ...originalDocument.body,
        appendChild: mockAppendChild,
        removeChild: mockRemoveChild,
      },
      execCommand: mockExecCommand,
    } as unknown as Document;

    const result = await copyToClipboard('test text');
    expect(result).toBe(false);
  });

  it('should use fallback execCommand when Clipboard API is not available', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    const mockExecCommand = vi.fn(() => true);
    const mockTextarea = {
      value: '',
      style: {},
      focus: vi.fn(() => {}),
      select: vi.fn(() => {}),
    };
    const mockCreateElement = vi.fn(() => mockTextarea);
    const mockAppendChild = vi.fn(() => {});
    const mockRemoveChild = vi.fn(() => {});

    global.document = {
      ...originalDocument,
      createElement: mockCreateElement,
      body: {
        ...originalDocument.body,
        appendChild: mockAppendChild,
        removeChild: mockRemoveChild,
      },
      execCommand: mockExecCommand,
    } as unknown as Document;

    const result = await copyToClipboard('fallback test');
    expect(result).toBe(true);
    expect(mockExecCommand).toHaveBeenCalledWith('copy');
  });

  it('should set textarea value to the text to copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    let capturedValue = '';
    const mockTextarea = {
      value: '',
      style: {},
      focus: vi.fn(() => {}),
      select: vi.fn(() => {}),
    };
    Object.defineProperty(mockTextarea, 'value', {
      set: (v: string) => {
        capturedValue = v;
      },
      get: () => capturedValue,
    });

    const mockCreateElement = vi.fn(() => mockTextarea);
    const mockAppendChild = vi.fn(() => {});
    const mockRemoveChild = vi.fn(() => {});
    const mockExecCommand = vi.fn(() => true);

    global.document = {
      ...originalDocument,
      createElement: mockCreateElement,
      body: {
        ...originalDocument.body,
        appendChild: mockAppendChild,
        removeChild: mockRemoveChild,
      },
      execCommand: mockExecCommand,
    } as unknown as Document;

    await copyToClipboard('capture this');
    expect(capturedValue).toBe('capture this');
  });

  it('should return false when fallback throws exception', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: undefined,
      configurable: true,
    });

    const mockCreateElement = vi.fn(() => {
      throw new Error('DOM operation failed');
    });

    global.document = {
      ...originalDocument,
      createElement: mockCreateElement,
    } as unknown as Document;

    const result = await copyToClipboard('test');
    expect(result).toBe(false);
  });
});

describe('formatRelativeTime', () => {
  it('should return "Just now" for times less than 60 seconds ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 30 * 1000);
    expect(formatRelativeTime(date)).toBe('Just now');
  });

  it('should return "Just now" for current time', () => {
    expect(formatRelativeTime(new Date())).toBe('Just now');
  });

  it('should return minutes ago for times less than 1 hour ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 5 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('5m ago');
  });

  it('should return hours ago for times less than 24 hours ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('3h ago');
  });

  it('should return "Yesterday" for times 24-48 hours ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('Yesterday');
  });

  it('should return days ago for times 2-7 days ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('3d ago');
  });

  it('should return formatted date for times more than 7 days ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(date);
    expect(result).not.toMatch(/ago$/);
    expect(result).not.toBe('Yesterday');
    expect(result).not.toBe('Just now');
  });

  it('should handle exactly 1 minute ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 60 * 1000);
    expect(formatRelativeTime(date)).toBe('1m ago');
  });

  it('should handle exactly 1 hour ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe('1h ago');
  });

  it('should handle exactly 7 days ago', () => {
    const now = new Date();
    const date = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const result = formatRelativeTime(date);
    expect(result).not.toMatch(/ago$/);
  });
});

describe('formatTokens', () => {
  it('should return plain number for tokens less than 1000', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(1)).toBe('1');
    expect(formatTokens(500)).toBe('500');
    expect(formatTokens(999)).toBe('999');
  });

  it('should return k format for tokens >= 1000', () => {
    expect(formatTokens(1000)).toBe('1.0k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2000)).toBe('2.0k');
  });

  it('should show 1 decimal place precision', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(1250)).toBe('1.3k');
    expect(formatTokens(1240)).toBe('1.2k');
    expect(formatTokens(16500)).toBe('16.5k');
  });

  it('should handle large token counts', () => {
    expect(formatTokens(100000)).toBe('100.0k');
    expect(formatTokens(999999)).toBe('1000.0k');
    expect(formatTokens(1000000)).toBe('1000.0k');
  });

  it('should handle exactly 1000 tokens', () => {
    expect(formatTokens(1000)).toBe('1.0k');
  });
});
