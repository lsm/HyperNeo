// @ts-nocheck
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { TodoViewer } from '../TodoViewer';

describe('TodoViewer', () => {
  const sampleTodos = [
    {
      content: 'Task 1',
      status: 'completed' as const,
      activeForm: 'Completing Task 1',
    },
    {
      content: 'Task 2',
      status: 'in_progress' as const,
      activeForm: 'Working on Task 2',
    },
    {
      content: 'Task 3',
      status: 'pending' as const,
      activeForm: 'Task 3 pending',
    },
  ];

  describe('Basic Rendering', () => {
    it('should render all todos', () => {
      const { container } = render(<TodoViewer todos={sampleTodos} />);
      expect(container.textContent).toContain('Task 1');
      expect(container.textContent).toContain('Task 2');
      expect(container.textContent).toContain('Task 3');
    });

    it('should render header with Task List title', () => {
      const { container } = render(<TodoViewer todos={sampleTodos} />);
      const header = container.querySelector('.font-semibold');
      expect(header?.textContent).toContain('Task List');
    });

    it('should show completion ratio in header', () => {
      const { container } = render(<TodoViewer todos={sampleTodos} />);
      expect(container.textContent).toContain('1/3');
    });

    it('should apply custom className', () => {
      const { container } = render(
        <TodoViewer todos={sampleTodos} className="custom-todo-class" />
      );
      const wrapper = container.querySelector('.custom-todo-class');
      expect(wrapper).toBeTruthy();
    });
  });

  describe('Status Badges', () => {
    it('should show Done badge for completed todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Done task', status: 'completed', activeForm: '' }]} />
      );
      const badge = container.querySelector('.bg-green-100');
      expect(badge?.textContent).toContain('Done');
    });

    it('should show In Progress badge for in_progress todos', () => {
      const { container } = render(
        <TodoViewer
          todos={[
            {
              content: 'Working task',
              status: 'in_progress',
              activeForm: 'Working',
            },
          ]}
        />
      );
      const badge = container.querySelector('.bg-blue-100');
      expect(badge?.textContent).toContain('In Progress');
    });

    it('should show Pending badge for pending todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Waiting task', status: 'pending', activeForm: '' }]} />
      );
      expect(container.textContent).toContain('Pending');
    });
  });

  describe('Status Icons', () => {
    it('should show checkmark icon for completed todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Done', status: 'completed', activeForm: '' }]} />
      );
      const greenIcon = container.querySelector('.text-green-600');
      expect(greenIcon).toBeTruthy();
    });

    it('should show spinner icon for in_progress todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Working', status: 'in_progress', activeForm: '' }]} />
      );
      const blueSpinner = container.querySelector('.text-blue-600');
      expect(blueSpinner).toBeTruthy();
      expect(blueSpinner?.className).toContain('animate-spin');
    });

    it('should show clock icon for pending todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Waiting', status: 'pending', activeForm: '' }]} />
      );
      const grayIcon = container.querySelector('.text-gray-400');
      expect(grayIcon).toBeTruthy();
    });
  });

  describe('Active Form Display', () => {
    it('should show activeForm text for in_progress todos', () => {
      const { container } = render(
        <TodoViewer
          todos={[
            {
              content: 'Main task',
              status: 'in_progress',
              activeForm: 'Currently running',
            },
          ]}
        />
      );
      const italicText = container.querySelector('.italic');
      expect(italicText?.textContent).toContain('Currently running');
    });

    it('should not show activeForm for completed todos', () => {
      const { container } = render(
        <TodoViewer
          todos={[
            {
              content: 'Done task',
              status: 'completed',
              activeForm: 'This should not show',
            },
          ]}
        />
      );
      expect(container.textContent).not.toContain('This should not show');
    });

    it('should not show activeForm for pending todos', () => {
      const { container } = render(
        <TodoViewer
          todos={[
            {
              content: 'Pending task',
              status: 'pending',
              activeForm: 'This should not show',
            },
          ]}
        />
      );
      expect(container.textContent).not.toContain('This should not show');
    });
  });

  describe('Visual Styling', () => {
    it('should apply strikethrough to completed todo content', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Done', status: 'completed', activeForm: '' }]} />
      );
      const strikethrough = container.querySelector('.line-through');
      expect(strikethrough).toBeTruthy();
    });

    it('should have green background for completed todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Done', status: 'completed', activeForm: '' }]} />
      );
      const greenBg = container.querySelector('.bg-green-50\\/50');
      expect(greenBg).toBeTruthy();
    });

    it('should have blue background for in_progress todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Working', status: 'in_progress', activeForm: '' }]} />
      );
      const blueBg = container.querySelector('.bg-blue-50\\/50');
      expect(blueBg).toBeTruthy();
    });

    it('should have white background for pending todos', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Pending', status: 'pending', activeForm: '' }]} />
      );
      const whiteBg = container.querySelector('.bg-white');
      expect(whiteBg).toBeTruthy();
    });
  });

  describe('Footer Statistics', () => {
    it('should show completed count in footer', () => {
      const todos = [
        { content: '1', status: 'completed' as const, activeForm: '' },
        { content: '2', status: 'completed' as const, activeForm: '' },
        { content: '3', status: 'pending' as const, activeForm: '' },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('2 completed');
    });

    it('should show in progress count in footer', () => {
      const todos = [
        { content: '1', status: 'in_progress' as const, activeForm: '' },
        { content: '2', status: 'in_progress' as const, activeForm: '' },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('2 in progress');
    });

    it('should show pending count in footer', () => {
      const todos = [
        { content: '1', status: 'pending' as const, activeForm: '' },
        { content: '2', status: 'pending' as const, activeForm: '' },
        { content: '3', status: 'pending' as const, activeForm: '' },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).toContain('3 pending');
    });

    it('should not show zero count categories in footer', () => {
      const todos = [{ content: '1', status: 'pending' as const, activeForm: '' }];
      const { container } = render(<TodoViewer todos={todos} />);
      const footer = container.querySelector('.border-t');
      expect(footer?.textContent).not.toContain('completed');
      expect(footer?.textContent).not.toContain('in progress');
      expect(footer?.textContent).toContain('pending');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty todos array', () => {
      const { container } = render(<TodoViewer todos={[]} />);
      expect(container.textContent).toContain('Task List');
      expect(container.textContent).toContain('0/0');
    });

    it('should handle all completed todos', () => {
      const todos = [
        { content: '1', status: 'completed' as const, activeForm: '' },
        { content: '2', status: 'completed' as const, activeForm: '' },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      expect(container.textContent).toContain('2/2');
    });

    it('should handle all pending todos', () => {
      const todos = [
        { content: '1', status: 'pending' as const, activeForm: '' },
        { content: '2', status: 'pending' as const, activeForm: '' },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      expect(container.textContent).toContain('0/2');
    });

    it('should handle single todo', () => {
      const todos = [
        {
          content: 'Only task',
          status: 'in_progress' as const,
          activeForm: '',
        },
      ];
      const { container } = render(<TodoViewer todos={todos} />);
      expect(container.textContent).toContain('Only task');
      expect(container.textContent).toContain('0/1');
    });

    it('should handle long todo content', () => {
      const longContent = 'A'.repeat(200);
      const todos = [{ content: longContent, status: 'pending' as const, activeForm: '' }];
      const { container } = render(<TodoViewer todos={todos} />);
      expect(container.textContent).toContain(longContent);
    });
  });

  describe('Status Color Indicators in Footer', () => {
    it('should show green dot for completed count', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Done', status: 'completed', activeForm: '' }]} />
      );
      const footer = container.querySelector('.border-t');
      const greenDot = footer?.querySelector('.bg-green-600');
      expect(greenDot).toBeTruthy();
    });

    it('should show blue dot for in progress count', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Working', status: 'in_progress', activeForm: '' }]} />
      );
      const footer = container.querySelector('.border-t');
      const blueDot = footer?.querySelector('.bg-blue-600');
      expect(blueDot).toBeTruthy();
    });

    it('should show gray dot for pending count', () => {
      const { container } = render(
        <TodoViewer todos={[{ content: 'Waiting', status: 'pending', activeForm: '' }]} />
      );
      const footer = container.querySelector('.border-t');
      const grayDot = footer?.querySelector('.bg-gray-400');
      expect(grayDot).toBeTruthy();
    });
  });
});
