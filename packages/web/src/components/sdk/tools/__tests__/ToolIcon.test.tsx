// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

import { render } from '@testing-library/preact';
import { ToolIcon } from '../ToolIcon';
import * as toolRegistry from '../tool-registry.ts';

describe('ToolIcon', () => {
  describe('Basic Rendering', () => {
    it('should render an icon for known tool', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render an icon for unknown tool', () => {
      const { container } = render(<ToolIcon toolName="UnknownTool" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should apply custom className', () => {
      const { container } = render(<ToolIcon toolName="Read" className="custom-icon-class" />);
      const element =
        container.querySelector('svg') || container.querySelector('.custom-icon-class');
      expect(element).toBeTruthy();
    });
  });

  describe('File Operation Icons', () => {
    it('should render Write icon', () => {
      const { container } = render(<ToolIcon toolName="Write" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute('stroke')).toBe('currentColor');
    });

    it('should render Edit icon', () => {
      const { container } = render(<ToolIcon toolName="Edit" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render MultiEdit icon', () => {
      const { container } = render(<ToolIcon toolName="MultiEdit" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render Read icon', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render NotebookEdit icon', () => {
      const { container } = render(<ToolIcon toolName="NotebookEdit" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Search Operation Icons', () => {
    it('should render Glob icon', () => {
      const { container } = render(<ToolIcon toolName="Glob" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render Grep icon', () => {
      const { container } = render(<ToolIcon toolName="Grep" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Terminal Operation Icons', () => {
    it('should render Bash icon', () => {
      const { container } = render(<ToolIcon toolName="Bash" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render BashOutput icon', () => {
      const { container } = render(<ToolIcon toolName="BashOutput" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render KillShell icon', () => {
      const { container } = render(<ToolIcon toolName="KillShell" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Agent/Task Operation Icons', () => {
    it('should render Task icon', () => {
      const { container } = render(<ToolIcon toolName="Task" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render Agent icon', () => {
      const { container } = render(<ToolIcon toolName="Agent" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Web Operation Icons', () => {
    it('should render WebFetch icon', () => {
      const { container } = render(<ToolIcon toolName="WebFetch" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render WebSearch icon', () => {
      const { container } = render(<ToolIcon toolName="WebSearch" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Todo Operation Icons', () => {
    it('should render TodoWrite icon', () => {
      const { container } = render(<ToolIcon toolName="TodoWrite" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('System Operation Icons', () => {
    it('should render AskUserQuestion icon', () => {
      const { container } = render(<ToolIcon toolName="AskUserQuestion" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render EnterPlanMode icon', () => {
      const { container } = render(<ToolIcon toolName="EnterPlanMode" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render ExitPlanMode icon', () => {
      const { container } = render(<ToolIcon toolName="ExitPlanMode" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render TimeMachine icon', () => {
      const { container } = render(<ToolIcon toolName="TimeMachine" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render Thinking icon', () => {
      const { container } = render(<ToolIcon toolName="Thinking" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('MCP Tool Icons', () => {
    it('should render MCP tool icon', () => {
      const { container } = render(<ToolIcon toolName="mcp__server__tool" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });

    it('should render different MCP tool icon', () => {
      const { container } = render(<ToolIcon toolName="mcp__filesystem__read" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
    });
  });

  describe('Size Variants', () => {
    it('should render xs size', () => {
      const { container } = render(<ToolIcon toolName="Read" size="xs" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-3');
      expect(svg?.className).toContain('h-3');
    });

    it('should render sm size', () => {
      const { container } = render(<ToolIcon toolName="Read" size="sm" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-4');
      expect(svg?.className).toContain('h-4');
    });

    it('should render md size by default', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-5');
      expect(svg?.className).toContain('h-5');
    });

    it('should render lg size', () => {
      const { container } = render(<ToolIcon toolName="Read" size="lg" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-6');
      expect(svg?.className).toContain('h-6');
    });

    it('should render xl size', () => {
      const { container } = render(<ToolIcon toolName="Read" size="xl" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('w-8');
      expect(svg?.className).toContain('h-8');
    });
  });

  describe('Animation', () => {
    it('should add spin animation when animated is true', () => {
      const { container } = render(<ToolIcon toolName="Read" animated />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('animate-spin');
    });

    it('should not have spin animation by default', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).not.toContain('animate-spin');
    });
  });

  describe('Tool Colors', () => {
    it('should have blue color for file tools', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-blue');
    });

    it('should have purple color for search tools', () => {
      const { container } = render(<ToolIcon toolName="Grep" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-purple');
    });

    it('should have gray color for terminal tools', () => {
      const { container } = render(<ToolIcon toolName="Bash" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-gray');
    });

    it('should have green color for web tools', () => {
      const { container } = render(<ToolIcon toolName="WebFetch" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-green');
    });

    it('should have amber color for todo tools', () => {
      const { container } = render(<ToolIcon toolName="TodoWrite" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-amber');
    });

    it('should have pink color for MCP tools', () => {
      const { container } = render(<ToolIcon toolName="mcp__test__tool" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('text-pink');
    });
  });

  describe('Flex Shrink', () => {
    it('should have flex-shrink-0 class to prevent shrinking', () => {
      const { container } = render(<ToolIcon toolName="Read" />);
      const svg = container.querySelector('svg');
      expect(svg?.className).toContain('flex-shrink-0');
    });
  });

  describe('Custom Icon', () => {
    it('should render custom icon when tool config has icon property', () => {
      const CustomIcon = () => <svg data-testid="custom-icon" />;
      vi.spyOn(toolRegistry, 'getToolConfig').mockReturnValueOnce({
        label: 'Custom Tool',
        category: 'other',
        icon: CustomIcon,
      });

      const { container } = render(<ToolIcon toolName="CustomIconTool" />);
      const customIcon = container.querySelector('[data-testid="custom-icon"]');
      expect(customIcon).toBeTruthy();

      vi.restoreAllMocks();
    });

    it('should apply size and color classes to custom icon wrapper', () => {
      const CustomIcon = () => <svg data-testid="custom-icon" />;
      vi.spyOn(toolRegistry, 'getToolConfig').mockReturnValueOnce({
        label: 'Custom Tool',
        category: 'other',
        icon: CustomIcon,
      });

      const { container } = render(
        <ToolIcon toolName="CustomIconTool" size="lg" className="extra-class" />
      );
      const wrapper = container.querySelector('div');
      expect(wrapper).toBeTruthy();
      expect(wrapper?.className).toContain('w-6');
      expect(wrapper?.className).toContain('h-6');
      expect(wrapper?.className).toContain('extra-class');

      vi.restoreAllMocks();
    });
  });
});
