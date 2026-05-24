import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CenteredWithSingleAction,
  CenteredWithWideButtons,
  SimpleAlert,
  SimpleWithDismissButton,
  SimpleWithGrayFooter,
  SimpleWithLeftAlignedButtons,
} from '../demo/sections/overlays/ModalDialogsDemo.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CenteredWithSingleAction', () => {
  it('renders the dialog with open button', async () => {
    render(<CenteredWithSingleAction />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog when button is clicked', async () => {
    render(<CenteredWithSingleAction />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Payment successful')).toBeTruthy();
    expect(screen.getByText('Go back to dashboard')).toBeTruthy();
  });

  it('closes dialog when action button is clicked', async () => {
    render(<CenteredWithSingleAction />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Payment successful')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Go back to dashboard' }));
    });

    expect(screen.queryByText('Payment successful')).toBeNull();
  });
});

describe('CenteredWithWideButtons', () => {
  it('renders the dialog with open button', async () => {
    render(<CenteredWithWideButtons />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog with Deactivate and Cancel buttons', async () => {
    render(<CenteredWithWideButtons />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Payment successful')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('SimpleAlert', () => {
  it('renders the dialog with open button', async () => {
    render(<SimpleAlert />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog with Deactivate account message', async () => {
    render(<SimpleAlert />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Deactivate account')).toBeTruthy();
    expect(screen.getByText(/Are you sure you want to deactivate your account\?/)).toBeTruthy();
  });

  it('has Deactivate and Cancel buttons', async () => {
    render(<SimpleAlert />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('SimpleWithDismissButton', () => {
  it('renders the dialog with open button', async () => {
    render(<SimpleWithDismissButton />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog with close button', async () => {
    render(<SimpleWithDismissButton />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Deactivate account')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('closes dialog when close button is clicked', async () => {
    render(<SimpleWithDismissButton />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Deactivate account')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });

    expect(screen.queryByText('Deactivate account')).toBeNull();
  });
});

describe('SimpleWithGrayFooter', () => {
  it('renders the dialog with open button', async () => {
    render(<SimpleWithGrayFooter />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog with Deactivate and Cancel buttons', async () => {
    render(<SimpleWithGrayFooter />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Deactivate account')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});

describe('SimpleWithLeftAlignedButtons', () => {
  it('renders the dialog with open button', async () => {
    render(<SimpleWithLeftAlignedButtons />);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Open dialog' })).toBeTruthy();
  });

  it('opens dialog with left-aligned Deactivate and Cancel buttons', async () => {
    render(<SimpleWithLeftAlignedButtons />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    });

    expect(screen.getByText('Deactivate account')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });
});
