import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendChatContainerMessage } from '../ChatContainer';
import { sessionStore } from '../../lib/session-store';
import { toast } from '../../lib/toast';

vi.mock('../../lib/session-store', () => ({
  sessionStore: {
    clearError: vi.fn(),
  },
}));

vi.mock('../../lib/toast', () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe('sendChatContainerMessage override path', () => {
  const sendMessage = vi.fn();
  const onSendOverride = vi.fn();
  const setLocalError = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessage.mockResolvedValue(true);
    onSendOverride.mockResolvedValue(true);
  });

  it('uses the override and returns its result', async () => {
    onSendOverride.mockResolvedValue(false);

    const result = await sendChatContainerMessage({
      content: 'hello',
      deliveryMode: 'immediate',
      onSendOverride,
      sendMessage,
      setLocalError,
    });

    expect(result).toBe(false);
    expect(onSendOverride).toHaveBeenCalledWith('hello', undefined, 'immediate');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sessionStore.clearError).toHaveBeenCalled();
    expect(setLocalError).toHaveBeenCalledWith(null);
  });

  it('forwards image attachments to the override', async () => {
    const images = [{ data: 'abc', media_type: 'image/png' as const }];
    const result = await sendChatContainerMessage({
      content: 'hello',
      images,
      deliveryMode: 'immediate',
      onSendOverride,
      sendMessage,
      setLocalError,
    });

    expect(result).toBe(true);
    expect(onSendOverride).toHaveBeenCalledWith('hello', images, 'immediate');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('forwards deferred (Queue) delivery to the override instead of rejecting', async () => {
    const result = await sendChatContainerMessage({
      content: 'hello',
      deliveryMode: 'defer',
      onSendOverride,
      sendMessage,
      setLocalError,
    });

    expect(result).toBe(true);
    expect(onSendOverride).toHaveBeenCalledWith('hello', undefined, 'defer');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('surfaces override errors as local errors', async () => {
    onSendOverride.mockRejectedValue(new Error('agent unavailable'));

    const result = await sendChatContainerMessage({
      content: 'hello',
      deliveryMode: 'immediate',
      onSendOverride,
      sendMessage,
      setLocalError,
    });

    expect(result).toBe(false);
    expect(setLocalError).toHaveBeenLastCalledWith('agent unavailable');
  });

  it('falls back to sendMessage when no override is provided', async () => {
    sendMessage.mockResolvedValue(false);

    const result = await sendChatContainerMessage({
      content: 'hello',
      deliveryMode: 'immediate',
      sendMessage,
      setLocalError,
    });

    expect(result).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith('hello', undefined, 'immediate');
  });
});
