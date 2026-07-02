# Tool Components System

A flexible, extensible system for rendering tool execution progress and results in the HyperNeo web UI.

## Overview

The tool components system provides a unified interface for displaying different types of tool executions (file operations, searches, terminal commands, web requests, etc.) with consistent styling, behavior, and customization options.

## Architecture

### Core Components

1. **ToolIcon** - Displays tool-specific icons
2. **ToolSummary** - Shows summary text extracted from tool inputs
3. **ToolProgressCard** - Real-time progress indicator for running tools
4. **ToolResultCard** - Completed tool execution with expandable details
5. **AuthStatusCard** - Authentication status display

### Registry System

The **tool-registry.ts** file maintains configuration for all tool types:

- Display names
- Categories (file, search, terminal, agent, web, todo, mcp, system)
- Summary extractors
- Custom renderers
- Default behaviors

### Utilities

**tool-utils.ts** provides helper functions:

- `getToolSummary()` - Extract summary from tool input
- `getToolColors()` - Get category-based colors
- `formatElapsedTime()` - Format duration display
- `getOutputDisplayText()` - Format output for display

## Usage

### Basic Tool Progress Display

```tsx
import { ToolProgressCard } from './tools';

<ToolProgressCard
	toolName="Read"
	toolInput={{ file_path: '/path/to/file.ts' }}
	elapsedTime={1.5}
	toolUseId="tool_abc123"
	variant="default"
/>;
```

### Tool Result Display

```tsx
import { ToolResultCard } from './tools';

<ToolResultCard
	toolName="Write"
	toolId="tool_xyz789"
	input={{ file_path: '/path/to/file.ts', content: '...' }}
	output={{ success: true }}
	isError={false}
	variant="default"
/>;
```

### Custom Tool Registration

```tsx
import { registerTool } from './tools';

registerTool('MyCustomTool', {
	displayName: 'My Tool',
	category: 'file',
	summaryExtractor: (input) => input.target,
	colors: {
		bg: 'bg-emerald-50',
		text: 'text-emerald-900',
		border: 'border-emerald-200',
		iconColor: 'text-emerald-600',
	},
});
```

## Variants

All card components support multiple display variants:

### `compact`

Minimal single-line display, ideal for mobile:

```tsx
<ToolProgressCard variant="compact" {...props} />
```

### `default`

Standard display with icon, summary, and metadata:

```tsx
<ToolProgressCard variant="default" {...props} />
```

### `detailed`

Full information including tool IDs and extra metadata:

```tsx
<ToolResultCard variant="detailed" {...props} />
```

### `inline`

Inline display for text flow:

```tsx
<ToolProgressCard variant="inline" {...props} />
```

## Category Colors

Tools are automatically colored based on their category:

- **file** - Blue (Read, Write, Edit)
- **search** - Purple (Glob, Grep)
- **terminal** - Gray (Bash)
- **agent** - Indigo (Task, Agent)
- **web** - Green (WebFetch, WebSearch)
- **todo** - Amber (TodoWrite)
- **mcp** - Pink (MCP tools)
- **system** - Cyan (ExitPlanMode, TimeMachine)

## MCP Tool Support

MCP tools (prefixed with `mcp__`) are automatically detected and configured:

```
mcp__chrome-devtools__click
mcp__shadcn__search_items_in_registries
```

The system extracts the server name and tool name for display.

## Custom Renderers

For tools requiring special rendering, register a custom renderer:

```tsx
registerTool('BashOutput', {
	category: 'terminal',
	customRenderer: (props) => (
		<div class="font-mono">
			<TerminalOutput content={props.output} />
		</div>
	),
});
```

## Adding New Tools

### Option 1: Default Configuration

Add to `tool-registry.ts`:

```typescript
MyTool: {
  displayName: 'My Tool',
  category: 'file',
  summaryExtractor: (input) => input.some_field,
  hasLongOutput: true,
  defaultExpanded: false,
}
```

### Option 2: Runtime Registration

```typescript
import { registerTool } from './tools';

registerTool('MyTool', {
	displayName: 'My Tool',
	category: 'web',
	summaryExtractor: (input) => truncate(input.url, 50),
});
```

## Migration from Legacy Code

Old components have been refactored:

### SDKToolProgressMessage

**Before:** Custom implementation with hardcoded icons/summaries
**After:** Uses `ToolProgressCard`

### ToolUseBlock (in SDKAssistantMessage)

**Before:** Inline component with duplicated logic
**After:** Uses `ToolResultCard`

### Auth Status (in SDKMessageRenderer)

**Before:** Inline JSX
**After:** Uses `AuthStatusCard`

Legacy code is marked with `@deprecated` and can be removed after testing.

## Mobile Responsiveness

Use the `compact` variant for mobile displays:

```tsx
const isMobile = window.innerWidth < 768;

<ToolProgressCard variant={isMobile ? 'compact' : 'default'} {...props} />;
```

## Examples

### File Operation Progress

```tsx
<ToolProgressCard
	toolName="Write"
	toolInput={{ file_path: '/src/App.tsx' }}
	elapsedTime={0.8}
	toolUseId="tool_123"
/>
```

### Search Result

```tsx
<ToolResultCard
	toolName="Grep"
	toolId="tool_456"
	input={{ pattern: 'useState', glob: '*.tsx' }}
	output="Found 42 matches in 15 files"
	variant="default"
/>
```

### MCP Tool

```tsx
<ToolProgressCard
	toolName="mcp__chrome-devtools__click"
	toolInput={{ uid: 'button_123' }}
	elapsedTime={0.3}
	toolUseId="tool_789"
/>
```

## API Reference

### ToolProgressCard Props

| Prop              | Type              | Description                     |
| ----------------- | ----------------- | ------------------------------- |
| `toolName`        | `string`          | Name of the tool                |
| `toolInput`       | `any`             | Tool input parameters           |
| `elapsedTime`     | `number`          | Elapsed time in seconds         |
| `toolUseId`       | `string`          | Unique tool execution ID        |
| `parentToolUseId` | `string?`         | Parent tool ID (for sub-agents) |
| `variant`         | `ToolCardVariant` | Display variant                 |
| `className`       | `string?`         | Additional CSS classes          |

### ToolResultCard Props

| Prop              | Type              | Description              |
| ----------------- | ----------------- | ------------------------ |
| `toolName`        | `string`          | Name of the tool         |
| `toolId`          | `string`          | Unique tool execution ID |
| `input`           | `any`             | Tool input parameters    |
| `output`          | `any?`            | Tool output/result       |
| `isError`         | `boolean`         | Whether execution failed |
| `variant`         | `ToolCardVariant` | Display variant          |
| `defaultExpanded` | `boolean?`        | Initial expanded state   |
| `className`       | `string?`         | Additional CSS classes   |

## Benefits

✅ **No code duplication** - Single source of truth for icons, summaries, colors
✅ **Easy to extend** - Add new tools via registry
✅ **Consistent UX** - Uniform styling and behavior
✅ **Mobile-friendly** - Compact variants for small screens
✅ **Type-safe** - Full TypeScript support
✅ **Customizable** - Override colors, icons, renderers
✅ **MCP-ready** - Automatic support for MCP tools

## Future Enhancements

- [ ] Theme customization API
- [ ] Tool execution replay/timeline view
- [ ] Performance metrics visualization
- [ ] Tool output syntax highlighting
- [ ] Custom icon library support
- [ ] Accessibility improvements (ARIA labels, keyboard nav)
- [ ] Animation preferences
- [ ] Export tool results

## Contributing

When adding new tool types:

1. Add configuration to `tool-registry.ts`
2. Add icon SVG to `ToolIcon.tsx` (if not using default)
3. Add summary extractor if tool has special input format
4. Test with all variants (compact, default, detailed, inline)
5. Ensure mobile responsiveness
6. Update this README

## See Also

- [tool-types.ts](./tool-types.ts) - TypeScript type definitions
- [tool-registry.ts](./tool-registry.ts) - Tool configuration registry
- [tool-utils.ts](./tool-utils.ts) - Utility functions
- [index.ts](./index.ts) - Barrel exports
