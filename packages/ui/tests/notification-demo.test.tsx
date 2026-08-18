import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NotificationWithAvatar,
  NotificationWithSplitButtons,
  SimpleIconNotification,
  CondensedNotification,
  NotificationWithActionsBelow,
  NotificationWithButtonsBelow,
} from '../demo/sections/NotificationDemo.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('NotificationWithAvatar', () => {
  it('renders the notification content when component mounts', async () => {
    render(<NotificationWithAvatar />);
    await act(async () => {});

    expect(screen.getByText('Emilia Gates')).toBeTruthy();

    expect(screen.getByText('Sure! 8:30pm works great!')).toBeTruthy();
  });

  it('renders avatar image from correct URL', async () => {
    render(<NotificationWithAvatar />);
    await act(async () => {});

    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('images.unsplash.com');
  });

  it('has a Reply button', async () => {
    render(<NotificationWithAvatar />);
    await act(async () => {});

    const replyBtn = screen.getByRole('button', { name: 'Reply' });
    expect(replyBtn).toBeTruthy();
  });

  it('hides notification when Reply button is clicked', async () => {
    render(<NotificationWithAvatar />);
    await act(async () => {});

    expect(screen.getByText('Emilia Gates')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    });

    expect(screen.queryByText('Emilia Gates')).toBeNull();
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<NotificationWithAvatar />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});

describe('NotificationWithSplitButtons', () => {
  it('renders the notification content when component mounts', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    expect(screen.getByText('Receive notifications')).toBeTruthy();

    expect(screen.getByText('Notifications may include alerts, sounds, and badges.')).toBeTruthy();
  });

  it('has a Reply button', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    const replyBtn = screen.getByRole('button', { name: 'Reply' });
    expect(replyBtn).toBeTruthy();
  });

  it('has a "Don\'t allow" button', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    const dismissBtn = screen.getByRole('button', { name: "Don't allow" });
    expect(dismissBtn).toBeTruthy();
  });

  it('hides notification when Reply button is clicked', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    expect(screen.getByText('Receive notifications')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    });

    expect(screen.queryByText('Receive notifications')).toBeNull();
  });

  it('hides notification when "Don\'t allow" button is clicked', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    expect(screen.getByText('Receive notifications')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    });

    expect(screen.queryByText('Receive notifications')).toBeNull();
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});

describe('Notification dismiss behavior', () => {
  it('can re-show avatar notification after dismissing', async () => {
    render(<NotificationWithSplitButtons />);
    await act(async () => {});

    expect(screen.getByText('Receive notifications')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    });

    expect(screen.queryByText('Receive notifications')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show split-button notification' }));
    });

    expect(screen.getByText('Receive notifications')).toBeTruthy();
  });
});

describe('SimpleIconNotification', () => {
  it('renders the notification content when component mounts', async () => {
    render(<SimpleIconNotification />);
    await act(async () => {});

    expect(screen.getByText('Successfully saved!')).toBeTruthy();

    expect(screen.getByText('Anyone with a link can now view this file.')).toBeTruthy();
  });

  it('has a close button', async () => {
    render(<SimpleIconNotification />);
    await act(async () => {});

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn).toBeTruthy();
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<SimpleIconNotification />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});

describe('CondensedNotification', () => {
  it('renders the notification content when component mounts', async () => {
    render(<CondensedNotification />);
    await act(async () => {});

    expect(screen.getByText('Discussion archived')).toBeTruthy();
  });

  it('has an Undo button', async () => {
    render(<CondensedNotification />);
    await act(async () => {});

    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    expect(undoBtn).toBeTruthy();
  });

  it('has a close button', async () => {
    render(<CondensedNotification />);
    await act(async () => {});

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn).toBeTruthy();
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<CondensedNotification />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});

describe('NotificationWithActionsBelow', () => {
  it('renders the notification content when component mounts', async () => {
    render(<NotificationWithActionsBelow />);
    await act(async () => {});

    expect(screen.getByText('Discussion moved')).toBeTruthy();
  });

  it('has Undo and Dismiss action buttons', async () => {
    render(<NotificationWithActionsBelow />);
    await act(async () => {});

    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
    expect(undoBtn).toBeTruthy();
    expect(dismissBtn).toBeTruthy();
  });

  it('has a close button', async () => {
    render(<NotificationWithActionsBelow />);
    await act(async () => {});

    const closeBtn = screen.getByRole('button', { name: 'Close' });
    expect(closeBtn).toBeTruthy();
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<NotificationWithActionsBelow />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});

describe('NotificationWithButtonsBelow', () => {
  it('renders the notification content when component mounts', async () => {
    render(<NotificationWithButtonsBelow />);
    await act(async () => {});

    expect(screen.getByText('Emilia Gates')).toBeTruthy();

    expect(screen.getByText('Sent you an invite to connect.')).toBeTruthy();
  });

  it('has Accept and Decline buttons', async () => {
    render(<NotificationWithButtonsBelow />);
    await act(async () => {});

    const acceptBtn = screen.getByRole('button', { name: 'Accept' });
    const declineBtn = screen.getByRole('button', { name: 'Decline' });
    expect(acceptBtn).toBeTruthy();
    expect(declineBtn).toBeTruthy();
  });

  it('has avatar image', async () => {
    render(<NotificationWithButtonsBelow />);
    await act(async () => {});

    const img = screen.getByRole('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toContain('images.unsplash.com');
  });

  it('has aria-live="assertive" on overlay container', async () => {
    render(<NotificationWithButtonsBelow />);
    await act(async () => {});

    const liveRegion = document.querySelector('[aria-live="assertive"]');
    expect(liveRegion).toBeTruthy();
  });
});
