import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { createElement } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Alert,
  AlertActions,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupOverflow,
  AvatarImage,
  AvatarStatus,
  Badge,
  ProgressBar,
  Stepper,
  StepperDescription,
  StepperIcon,
  StepperLabel,
  StepperSeparator,
  StepperStep,
} from '../src/mod.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Alert', () => {
  it('should render with default variant (info)', () => {
    render(<Alert>Alert content</Alert>);
    const alert = screen.getByRole('alert');
    expect(alert).not.toBeNull();
    expect(alert.getAttribute('data-variant')).toBe('info');
  });

  it('should render with success variant', () => {
    render(<Alert variant="success">Success message</Alert>);
    expect(screen.getByRole('alert').getAttribute('data-variant')).toBe('success');
  });

  it('should render with warning variant', () => {
    render(<Alert variant="warning">Warning message</Alert>);
    expect(screen.getByRole('alert').getAttribute('data-variant')).toBe('warning');
  });

  it('should render with error variant', () => {
    render(<Alert variant="error">Error message</Alert>);
    expect(screen.getByRole('alert').getAttribute('data-variant')).toBe('error');
  });

  it('should set role="alert"', () => {
    render(<Alert>Alert</Alert>);
    expect(screen.getByRole('alert')).not.toBeNull();
  });

  it('should not have data-dismissible when dismissible is false', () => {
    render(<Alert dismissible={false}>Alert</Alert>);
    expect(screen.getByRole('alert').getAttribute('data-dismissible')).toBeNull();
  });

  it('should have data-dismissible when dismissible is true', () => {
    render(<Alert dismissible>Alert</Alert>);
    expect(screen.getByRole('alert').getAttribute('data-dismissible')).toBe('');
  });

  it('should render children', () => {
    render(<Alert>Hello World</Alert>);
    expect(screen.getByText('Hello World')).not.toBeNull();
  });

  it('should render as custom element when as prop is provided', () => {
    render(<Alert as="section">Section Alert</Alert>);
    const section = document.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('role')).toBe('alert');
  });
});

describe('AlertTitle', () => {
  it('should render with default tag (h3)', () => {
    render(
      <Alert>
        <AlertTitle>Title</AlertTitle>
      </Alert>
    );
    const title = screen.getByRole('heading');
    expect(title).not.toBeNull();
    expect(title.tagName).toBe('H3');
  });

  it('should render children', () => {
    render(
      <Alert>
        <AlertTitle>Alert Title</AlertTitle>
      </Alert>
    );
    expect(screen.getByText('Alert Title')).not.toBeNull();
  });

  it('should render with custom as prop', () => {
    render(
      <Alert>
        <AlertTitle as="h2">Custom Heading</AlertTitle>
      </Alert>
    );
    const title = screen.getByRole('heading');
    expect(title.tagName).toBe('H2');
  });
});

describe('AlertDescription', () => {
  it('should render with default tag (p)', () => {
    render(
      <Alert>
        <AlertDescription>Description text</AlertDescription>
      </Alert>
    );
    const desc = document.querySelector('p');
    expect(desc).not.toBeNull();
    expect(desc?.textContent).toBe('Description text');
  });

  it('should render children', () => {
    render(
      <Alert>
        <AlertDescription>Description content</AlertDescription>
      </Alert>
    );
    expect(screen.getByText('Description content')).not.toBeNull();
  });
});

describe('AlertActions', () => {
  it('should render with default tag (div)', () => {
    render(
      <Alert>
        <AlertActions>Actions</AlertActions>
      </Alert>
    );
    const actions = document.querySelector('div[data-slot="actions"]');
    expect(actions).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Alert>
        <AlertActions>
          <button>Action 1</button>
          <button>Action 2</button>
        </AlertActions>
      </Alert>
    );
    expect(screen.getByText('Action 1')).not.toBeNull();
    expect(screen.getByText('Action 2')).not.toBeNull();
  });
});

describe('AlertIcon', () => {
  it('should render with default tag (div)', () => {
    render(
      <Alert>
        <AlertIcon />
      </Alert>
    );
    const icon = document.querySelector('div[data-slot="icon"]');
    expect(icon).not.toBeNull();
  });

  it('should render an SVG icon', () => {
    render(
      <Alert>
        <AlertIcon />
      </Alert>
    );
    const svg = document.querySelector('div[data-slot="icon"] svg');
    expect(svg).not.toBeNull();
  });

  it('should render custom icon when provided', () => {
    const customIcon = createElement('span', { 'data-custom-icon': true }, 'Icon');
    render(
      <Alert>
        <AlertIcon icon={customIcon} />
      </Alert>
    );
    const icon = document.querySelector('span[data-custom-icon="true"]');
    expect(icon).not.toBeNull();
  });
});

describe('Badge', () => {
  it('should render a badge by default', () => {
    render(<Badge>Badge</Badge>);
    const badge = document.querySelector('span');
    expect(badge).not.toBeNull();
  });

  it('should render children', () => {
    render(<Badge>Label</Badge>);
    expect(screen.getByText('Label')).not.toBeNull();
  });

  it('should render with subtle variant by default', () => {
    render(<Badge>Subtle</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-variant')).toBe('subtle');
  });

  it('should render with outline variant', () => {
    render(<Badge variant="outline">Outline</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-variant')).toBe('outline');
  });

  it('should render with solid variant', () => {
    render(<Badge variant="solid">Solid</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-variant')).toBe('solid');
  });

  it('should render with gray color by default', () => {
    render(<Badge>Gray</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('gray');
  });

  it('should render with red color', () => {
    render(<Badge color="red">Red</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('red');
  });

  it('should render with yellow color', () => {
    render(<Badge color="yellow">Yellow</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('yellow');
  });

  it('should render with green color', () => {
    render(<Badge color="green">Green</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('green');
  });

  it('should render with blue color', () => {
    render(<Badge color="blue">Blue</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('blue');
  });

  it('should render with indigo color', () => {
    render(<Badge color="indigo">Indigo</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('indigo');
  });

  it('should render with purple color', () => {
    render(<Badge color="purple">Purple</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('purple');
  });

  it('should render with pink color', () => {
    render(<Badge color="pink">Pink</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-color')).toBe('pink');
  });

  it('should render with md size by default', () => {
    render(<Badge>Medium</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-size')).toBe('md');
  });

  it('should render with sm size', () => {
    render(<Badge size="sm">Small</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-size')).toBe('sm');
  });

  it('should render with rounded shape by default', () => {
    render(<Badge>Rounded</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-shape')).toBe('rounded');
  });

  it('should render with pill shape', () => {
    render(<Badge shape="pill">Pill</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-shape')).toBe('pill');
  });

  it('should render with square shape', () => {
    render(<Badge shape="square">Square</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-shape')).toBe('square');
  });

  it('should not have data-dot when dot is false', () => {
    render(<Badge dot={false}>No Dot</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-dot')).toBeNull();
  });

  it('should have data-dot when dot is true', () => {
    render(<Badge dot>With Dot</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-dot')).toBe('');
  });

  it('should render dot SVG element when dot is true', () => {
    render(<Badge dot>Dot</Badge>);
    const dot = document.querySelector('.badge-dot');
    expect(dot).not.toBeNull();
  });

  it('should not have data-removable when removable is false', () => {
    render(<Badge removable={false}>Not Removable</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-removable')).toBeNull();
  });

  it('should have data-removable when removable is true', () => {
    render(<Badge removable>Removable</Badge>);
    expect(document.querySelector('span')?.getAttribute('data-removable')).toBe('');
  });

  it('should render remove button when removable is true', () => {
    render(
      <Badge removable onRemove={() => {}}>
        Remove
      </Badge>
    );
    const removeBtn = document.querySelector('button[aria-label="Remove"]');
    expect(removeBtn).not.toBeNull();
  });

  it('should call onRemove when remove button is clicked', () => {
    const onRemove = vi.fn();
    render(
      <Badge removable onRemove={onRemove}>
        Remove Me
      </Badge>
    );
    const removeBtn = document.querySelector('button[aria-label="Remove"]');
    fireEvent.click(removeBtn!);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('should set data-hover on mouse enter', async () => {
    render(<Badge>Hover</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(badge);
    });
    expect(badge.getAttribute('data-hover')).toBe('');
  });

  it('should remove data-hover on mouse leave', async () => {
    render(<Badge>Hover</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      fireEvent.mouseEnter(badge);
    });
    expect(badge.getAttribute('data-hover')).toBe('');
    await act(async () => {
      fireEvent.mouseLeave(badge);
    });
    expect(badge.getAttribute('data-hover')).toBeNull();
  });

  it('should set data-focus on focus', async () => {
    render(<Badge>Focus</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      badge.focus();
    });
    expect(badge.getAttribute('data-focus')).toBe('');
  });

  it('should remove data-focus on blur', async () => {
    render(<Badge>Focus</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      badge.focus();
    });
    expect(badge.getAttribute('data-focus')).toBe('');
    await act(async () => {
      badge.blur();
    });
    expect(badge.getAttribute('data-focus')).toBeNull();
  });

  it('should set data-active on mouse down', async () => {
    render(<Badge>Active</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(badge);
    });
    expect(badge.getAttribute('data-active')).toBe('');
  });

  it('should remove data-active on mouse up', async () => {
    render(<Badge>Active</Badge>);
    const badge = document.querySelector('span') as HTMLElement;
    await act(async () => {
      fireEvent.mouseDown(badge);
    });
    expect(badge.getAttribute('data-active')).toBe('');
    await act(async () => {
      fireEvent.mouseUp(badge);
    });
    expect(badge.getAttribute('data-active')).toBeNull();
  });

  it('should render as custom element when as prop is provided', () => {
    render(<Badge as="div">Div Badge</Badge>);
    const div = document.querySelector('div[data-variant="subtle"]');
    expect(div).not.toBeNull();
  });
});

describe('ProgressBar', () => {
  it('should render with role="progressbar"', () => {
    render(<ProgressBar value={50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar).not.toBeNull();
  });

  it('should set aria-valuenow with numeric value', () => {
    render(<ProgressBar value={75} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBe('75');
  });

  it('should set aria-valuemin', () => {
    render(<ProgressBar value={50} min={0} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuemin')).toBe('0');
  });

  it('should set aria-valuemax', () => {
    render(<ProgressBar value={50} max={100} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('should set aria-valuetext with percentage', () => {
    render(<ProgressBar value={50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('50%');
  });

  it('should set aria-label when label is provided', () => {
    render(<ProgressBar value={50} label="Upload Progress" />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-label')).toBe('Upload Progress');
  });

  it('should calculate percentage correctly at 0', () => {
    render(<ProgressBar value={0} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-value')).toBe('0');
    expect(progressbar.getAttribute('data-min')).toBe('0');
    expect(progressbar.getAttribute('data-max')).toBe('100');
  });

  it('should calculate percentage correctly at 50', () => {
    render(<ProgressBar value={50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('50%');
  });

  it('should calculate percentage correctly at 100', () => {
    render(<ProgressBar value={100} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('should calculate percentage with custom min and max', () => {
    render(<ProgressBar value={75} min={0} max={200} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('38%');
  });

  it('should clamp percentage to 100 when value exceeds max', () => {
    render(<ProgressBar value={150} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('100%');
  });

  it('should clamp percentage to 0 when value is below min', () => {
    render(<ProgressBar value={-50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBe('0%');
  });

  it('should have data-size sm', () => {
    render(<ProgressBar value={50} size="sm" />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-size')).toBe('sm');
  });

  it('should have data-size md by default', () => {
    render(<ProgressBar value={50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-size')).toBe('md');
  });

  it('should have data-size lg', () => {
    render(<ProgressBar value={50} size="lg" />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-size')).toBe('lg');
  });

  it('should not have data-indeterminate when value is provided', () => {
    render(<ProgressBar value={50} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-indeterminate')).toBeNull();
  });

  it('should have data-indeterminate when value is null', () => {
    render(<ProgressBar value={null as unknown as number} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-indeterminate')).toBe('');
  });

  it('should have data-indeterminate when value is undefined', () => {
    render(<ProgressBar value={undefined as unknown as number} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('data-indeterminate')).toBe('');
  });

  it('should not set aria-valuenow when indeterminate', () => {
    render(<ProgressBar value={undefined as unknown as number} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuenow')).toBeNull();
  });

  it('should not set aria-valuetext when indeterminate', () => {
    render(<ProgressBar value={undefined as unknown as number} />);
    const progressbar = screen.getByRole('progressbar');
    expect(progressbar.getAttribute('aria-valuetext')).toBeNull();
  });

  it('should not render value element when showValue is false', () => {
    render(<ProgressBar value={50} showValue={false} />);
    const valueElement = document.querySelector('[data-progress-value]');
    expect(valueElement).toBeNull();
  });

  it('should render value element when showValue is true', () => {
    render(<ProgressBar value={50} showValue />);
    const valueElement = document.querySelector('[data-progress-value]');
    expect(valueElement).not.toBeNull();
    expect(valueElement?.textContent).toBe('50%');
  });

  it('should render fill element with correct width', () => {
    render(<ProgressBar value={75} />);
    const fill = document.querySelector('[data-progress-fill]') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe('75%');
  });

  it('should render as custom element when as prop is provided', () => {
    render(<ProgressBar value={50} as="section" />);
    const section = document.querySelector('section');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('role')).toBe('progressbar');
  });

  it('should apply color style when color is provided', () => {
    render(<ProgressBar value={50} color="#ff0000" />);
    const fill = document.querySelector('[data-progress-fill]') as HTMLElement;
    expect(fill.style.backgroundColor).toBe('#ff0000');
  });
});

describe('Stepper', () => {
  it('should render with role="list"', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const stepper = document.querySelector('[role="list"]');
    expect(stepper).not.toBeNull();
  });

  it('should have data-orientation horizontal by default', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const stepper = document.querySelector('[data-orientation="horizontal"]');
    expect(stepper).not.toBeNull();
  });

  it('should have data-orientation vertical when specified', () => {
    render(
      <Stepper currentStep={0} orientation="vertical">
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const stepper = document.querySelector('[data-orientation="vertical"]');
    expect(stepper).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    expect(screen.getByText('Step 1')).not.toBeNull();
    expect(screen.getByText('Step 2')).not.toBeNull();
  });
});

describe('StepperStep', () => {
  it('should have role="listitem"', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[role="listitem"]');
    expect(step).not.toBeNull();
  });

  it('should have data-status complete', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[data-status="complete"]');
    expect(step).not.toBeNull();
  });

  it('should have data-status current', () => {
    render(
      <Stepper currentStep={1}>
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[data-status="current"]');
    expect(step).not.toBeNull();
  });

  it('should have data-status upcoming', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="upcoming">Step 2</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[data-status="upcoming"]');
    expect(step).not.toBeNull();
  });

  it('should have aria-current="step" when status is current', () => {
    render(
      <Stepper currentStep={1}>
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[aria-current="step"]');
    expect(step).not.toBeNull();
  });

  it('should not have aria-current when status is complete', () => {
    render(
      <Stepper currentStep={1}>
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[role="listitem"]');
    expect(step?.getAttribute('aria-current')).toBeNull();
  });

  it('should not have aria-current when status is upcoming', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="upcoming">Step 2</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[role="listitem"]');
    expect(step?.getAttribute('aria-current')).toBeNull();
  });

  it('should have data-orientation from context', () => {
    render(
      <Stepper currentStep={0} orientation="vertical">
        <StepperStep status="complete">Step 1</StepperStep>
      </Stepper>
    );
    const step = document.querySelector('[data-orientation="vertical"]');
    expect(step).not.toBeNull();
  });
});

describe('StepperIcon', () => {
  it('should render with data-status complete', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperIcon stepIndex={0} status="complete" />
        </StepperStep>
      </Stepper>
    );
    const icon = document.querySelector('[data-status="complete"]');
    expect(icon).not.toBeNull();
  });

  it('should render with data-status current', () => {
    render(
      <Stepper currentStep={1}>
        <StepperStep status="current">
          <StepperIcon stepIndex={1} status="current" />
        </StepperStep>
      </Stepper>
    );
    const icon = document.querySelector('[data-status="current"]');
    expect(icon).not.toBeNull();
  });

  it('should render with data-status upcoming', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="upcoming">
          <StepperIcon stepIndex={1} status="upcoming" />
        </StepperStep>
      </Stepper>
    );
    const icon = document.querySelector('[data-status="upcoming"]');
    expect(icon).not.toBeNull();
  });

  it('should render checkmark SVG for complete status', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperIcon stepIndex={0} status="complete" />
        </StepperStep>
      </Stepper>
    );
    const svg = document.querySelector('[data-status="complete"] svg');
    expect(svg).not.toBeNull();
  });

  it('should render step number for current status', () => {
    render(
      <Stepper currentStep={1}>
        <StepperStep status="current">
          <StepperIcon stepIndex={1} status="current" />
        </StepperStep>
      </Stepper>
    );
    const number = document.querySelector('[data-status="current"] [data-step-number]');
    expect(number).not.toBeNull();
    expect(number?.textContent).toBe('2');
  });

  it('should render step number for upcoming status', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="upcoming">
          <StepperIcon stepIndex={1} status="upcoming" />
        </StepperStep>
      </Stepper>
    );
    const number = document.querySelector('[data-status="upcoming"] [data-step-number]');
    expect(number).not.toBeNull();
    expect(number?.textContent).toBe('2');
  });

  it('should render custom children when provided', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperIcon stepIndex={0}>Custom Icon</StepperIcon>
        </StepperStep>
      </Stepper>
    );
    expect(screen.getByText('Custom Icon')).not.toBeNull();
  });
});

describe('StepperLabel', () => {
  it('should render with default tag (span)', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperLabel>Label</StepperLabel>
        </StepperStep>
      </Stepper>
    );
    const label = document.querySelector('span');
    expect(label).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperLabel>Step Label</StepperLabel>
        </StepperStep>
      </Stepper>
    );
    expect(screen.getByText('Step Label')).not.toBeNull();
  });
});

describe('StepperDescription', () => {
  it('should render with default tag (span)', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperDescription>Description</StepperDescription>
        </StepperStep>
      </Stepper>
    );
    const desc = document.querySelector('span');
    expect(desc).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">
          <StepperDescription>Step Description</StepperDescription>
        </StepperStep>
      </Stepper>
    );
    expect(screen.getByText('Step Description')).not.toBeNull();
  });
});

describe('StepperSeparator', () => {
  it('should render with data-separator', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
        <StepperSeparator />
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    const separator = document.querySelector('[data-separator="true"]');
    expect(separator).not.toBeNull();
  });

  it('should have data-orientation horizontal', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
        <StepperSeparator />
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    const separator = document.querySelector('[data-orientation="horizontal"]');
    expect(separator).not.toBeNull();
  });

  it('should have data-orientation vertical when orientation is vertical', () => {
    render(
      <Stepper currentStep={0} orientation="vertical">
        <StepperStep status="complete">Step 1</StepperStep>
        <StepperSeparator />
        <StepperStep status="current">Step 2</StepperStep>
      </Stepper>
    );
    const separator = document.querySelector('[data-orientation="vertical"]');
    expect(separator).not.toBeNull();
  });

  it('should render with default tag (div)', () => {
    render(
      <Stepper currentStep={0}>
        <StepperStep status="complete">Step 1</StepperStep>
        <StepperSeparator />
      </Stepper>
    );
    const separator = document.querySelector('div[data-separator="true"]');
    expect(separator).not.toBeNull();
  });
});

describe('Avatar', () => {
  it('should render with default size (md)', () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-size="md"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with default shape (circle)', () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-shape="circle"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with custom size (sm)', () => {
    render(
      <Avatar size="sm">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-size="sm"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with custom size (lg)', () => {
    render(
      <Avatar size="lg">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-size="lg"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with custom size (xl)', () => {
    render(
      <Avatar size="xl">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-size="xl"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with rounded shape', () => {
    render(
      <Avatar shape="rounded">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-shape="rounded"]');
    expect(avatar).not.toBeNull();
  });

  it('should render with status', () => {
    render(
      <Avatar status="online">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('[data-status="online"]');
    expect(avatar).not.toBeNull();
  });

  it('should render as custom element when as prop is provided', () => {
    render(
      <Avatar as="div">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const avatar = document.querySelector('div[data-size="md"]');
    expect(avatar).not.toBeNull();
  });
});

describe('AvatarImage', () => {
  it('should render with data-loaded when src is provided', async () => {
    render(
      <Avatar>
        <AvatarImage src="https://example.com/avatar.jpg" alt="User avatar" />
      </Avatar>
    );
    const img = document.querySelector('img[alt="User avatar"]');
    expect(img).not.toBeNull();
  });

  it('should render with src and alt attributes', () => {
    render(
      <Avatar>
        <AvatarImage src="https://example.com/avatar.jpg" alt="User avatar" />
      </Avatar>
    );
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://example.com/avatar.jpg');
    expect(img?.getAttribute('alt')).toBe('User avatar');
  });

  it('should call onLoad when image loads', () => {
    const onLoad = vi.fn();
    render(
      <Avatar>
        <AvatarImage src="https://example.com/avatar.jpg" alt="User" onLoad={onLoad} />
      </Avatar>
    );
    const img = document.querySelector('img') as HTMLImageElement;
    act(() => {
      fireEvent.load(img);
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('should call onError when image fails to load', () => {
    const onError = vi.fn();
    render(
      <Avatar>
        <AvatarImage src="https://example.com/invalid.jpg" alt="User" onError={onError} />
      </Avatar>
    );
    const img = document.querySelector('img') as HTMLImageElement;
    act(() => {
      fireEvent.error(img);
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe('AvatarFallback', () => {
  it('should render with default tag (span)', () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    const fallback = document.querySelector('span');
    expect(fallback).not.toBeNull();
  });

  it('should render children', () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText('JD')).not.toBeNull();
  });

  it('should render as custom element when as prop is provided', () => {
    render(
      <Avatar>
        <AvatarFallback as="div">JD</AvatarFallback>
      </Avatar>
    );
    const fallback = document.querySelector('div');
    expect(fallback).not.toBeNull();
  });
});

describe('AvatarStatus', () => {
  it('should render with aria-label for status', () => {
    render(
      <Avatar>
        <AvatarStatus status="online" />
      </Avatar>
    );
    const status = document.querySelector('[aria-label="Status: online"]');
    expect(status).not.toBeNull();
  });

  it('should render with default tag (span)', () => {
    render(
      <Avatar>
        <AvatarStatus status="online" />
      </Avatar>
    );
    const status = document.querySelector('span');
    expect(status).not.toBeNull();
  });
});

describe('AvatarGroup', () => {
  it('should render with default tag (div)', () => {
    render(
      <AvatarGroup>
        <Avatar>
          <AvatarFallback>U1</AvatarFallback>
        </Avatar>
      </AvatarGroup>
    );
    const group = document.querySelector('div');
    expect(group).not.toBeNull();
  });

  it('should not have data-overflow when count is within max', () => {
    render(
      <AvatarGroup max={3}>
        <Avatar>
          <AvatarFallback>U1</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U2</AvatarFallback>
        </Avatar>
      </AvatarGroup>
    );
    const group = document.querySelector('div');
    expect(group?.getAttribute('data-overflow')).toBeNull();
  });
});

describe('AvatarGroupOverflow', () => {
  it('should render with default tag (span)', () => {
    render(
      <AvatarGroup max={2}>
        <Avatar>
          <AvatarFallback>U1</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U2</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U3</AvatarFallback>
        </Avatar>
        <AvatarGroupOverflow>+1</AvatarGroupOverflow>
      </AvatarGroup>
    );
    const overflow = document.querySelector('span');
    expect(overflow).not.toBeNull();
  });

  it('should render children', async () => {
    render(
      <AvatarGroup max={2}>
        <Avatar>
          <AvatarFallback>U1</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U2</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U3</AvatarFallback>
        </Avatar>
        <AvatarGroupOverflow>+3</AvatarGroupOverflow>
      </AvatarGroup>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByText('+3')).not.toBeNull();
  });

  it('should have data-count attribute', async () => {
    render(
      <AvatarGroup max={2}>
        <Avatar>
          <AvatarFallback>U1</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U2</AvatarFallback>
        </Avatar>
        <Avatar>
          <AvatarFallback>U3</AvatarFallback>
        </Avatar>
        <AvatarGroupOverflow>+3</AvatarGroupOverflow>
      </AvatarGroup>
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const overflow = document.querySelector('[data-count="3"]');
    expect(overflow).not.toBeNull();
  });
});
