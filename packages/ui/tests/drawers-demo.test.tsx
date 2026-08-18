import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EmptyDrawer,
  EmptyWideDrawer,
  DrawerWithOverlay,
  DrawerWithCloseButtonOutside,
  DrawerWithBrandedHeader,
  DrawerWithStickyFooter,
  CreateProjectFormDrawer,
  WideCreateProjectFormDrawer,
  UserProfileDrawer,
  FileDetailsSlideOver,
  ContactListDrawer,
  FileDetailsDrawer,
} from '../demo/sections/overlays/DrawersDemo.tsx';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('EmptyDrawer', () => {
  it('renders the drawer with open button', async () => {
    render(<EmptyDrawer />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open drawer' })).toBeTruthy();
  });

  it('opens drawer when button is clicked', async () => {
    render(<EmptyDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Panel title')).toBeTruthy();
  });

  it('has a close button inside the drawer', async () => {
    render(<EmptyDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByRole('button', { name: 'Close panel' })).toBeTruthy();
  });
});

describe('DrawerWithOverlay', () => {
  it('renders the drawer with open button', async () => {
    render(<DrawerWithOverlay />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer when button is clicked', async () => {
    render(<DrawerWithOverlay />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Panel title')).toBeTruthy();
  });
});

describe('DrawerWithCloseButtonOutside', () => {
  it('renders the drawer with open button', async () => {
    render(<DrawerWithCloseButtonOutside />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer when button is clicked', async () => {
    render(<DrawerWithCloseButtonOutside />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Panel title')).toBeTruthy();
  });
});

describe('DrawerWithBrandedHeader', () => {
  it('renders the drawer with open button', async () => {
    render(<DrawerWithBrandedHeader />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with branded header', async () => {
    render(<DrawerWithBrandedHeader />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Panel title')).toBeTruthy();
  });
});

describe('DrawerWithStickyFooter', () => {
  it('renders the drawer with open button', async () => {
    render(<DrawerWithStickyFooter />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with Cancel and Save buttons', async () => {
    render(<DrawerWithStickyFooter />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });
});

describe('CreateProjectFormDrawer', () => {
  it('renders the drawer with open button', async () => {
    render(<CreateProjectFormDrawer />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with project form', async () => {
    render(<CreateProjectFormDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('New project')).toBeTruthy();
    expect(screen.getByText('Create')).toBeTruthy();
  });
});

describe('UserProfileDrawer', () => {
  it('renders the drawer with open button', async () => {
    render(<UserProfileDrawer />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with user profile content', async () => {
    render(<UserProfileDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Profile')).toBeTruthy();
    expect(screen.getByText('Ashley Porter')).toBeTruthy();
  });

  it('has a DialogTitle for accessibility', async () => {
    render(<UserProfileDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    const dialogTitle = document.querySelector('[role="dialog"] h2, [role="dialog"] h3');
    expect(dialogTitle).toBeTruthy();
  });
});

describe('FileDetailsSlideOver', () => {
  it('renders the drawer with open button', async () => {
    render(<FileDetailsSlideOver />);
    await act(async () => {});

    expect(screen.getByText('Open wide drawer')).toBeTruthy();
  });

  it('opens drawer with file details', async () => {
    render(<FileDetailsSlideOver />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open wide drawer' }));
    });

    expect(screen.getByText('IMG_4985.HEIC')).toBeTruthy();
  });
});

describe('ContactListDrawer', () => {
  it('renders the drawer with open button', async () => {
    render(<ContactListDrawer />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with contact list', async () => {
    render(<ContactListDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('Team')).toBeTruthy();
  });
});

describe('FileDetailsDrawer', () => {
  it('renders the drawer with open button', async () => {
    render(<FileDetailsDrawer />);
    await act(async () => {});

    expect(screen.getByText('Open drawer')).toBeTruthy();
  });

  it('opens drawer with file details', async () => {
    render(<FileDetailsDrawer />);
    await act(async () => {});

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    });

    expect(screen.getByText('File Details')).toBeTruthy();
    expect(screen.getByText('design-specs.pdf')).toBeTruthy();
  });
});
