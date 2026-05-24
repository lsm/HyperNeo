/**
 * Design Tokens
 *
 * Centralized design system tokens for consistent spacing, sizing, and styling
 * across all components.
 */

/**
 * Message Spacing Tokens
 * Defines standardized padding and spacing for message bubbles
 * Based on real iMessage design
 */
export const messageSpacing = {
  /**
   * User message bubble padding
   * Mobile: 12px horizontal, 6px vertical (px-3 py-1.5)
   * Desktop: 14px horizontal, 8px vertical (px-3.5 py-2)
   */
  user: {
    bubble: {
      mobile: 'px-3 py-1.5',
      desktop: 'md:px-3.5 md:py-2',
      combined: 'px-3 py-1.5 md:px-3.5 md:py-2',
    },
    container: {
      mobile: 'py-2',
      desktop: '',
      combined: 'py-2',
    },
  },

  /**
   * Assistant message bubble padding
   * Same as user for consistency
   */
  assistant: {
    bubble: {
      mobile: 'px-3 py-1.5',
      desktop: 'md:px-3.5 md:py-2',
      combined: 'px-3 py-1.5 md:px-3.5 md:py-2',
    },
    container: {
      mobile: 'py-2',
      desktop: '',
      combined: 'py-2',
    },
  },

  /**
   * Actions row spacing (below message bubble)
   * Spacing between message bubble and action buttons
   */
  actions: {
    marginTop: 'mt-2',
    gap: 'gap-2',
    padding: 'px-1',
  },
} as const;

/**
 * Border Radius Tokens
 * iMessage-style corner radius - 20px for that signature Apple look
 */
export const borderRadius = {
  message: {
    bubble: 'rounded-[20px]', // 20px - matches Apple iMessage
    tool: 'rounded-lg', // 8px
  },
} as const;

/**
 * Color Tokens
 * iMessage-style color scheme - exact colors from real iMessage
 */
export const messageColors = {
  /**
   * User message colors (blue bubble like iMessage)
   */
  user: {
    background: 'bg-blue-500',
    text: 'text-white',
  },
  /**
   * Assistant message colors (dark gray bubble)
   * Using exact iMessage color #3b3b3d
   */
  assistant: {
    background: 'bg-dark-800',
    text: 'text-white',
  },
} as const;

/**
 * Custom Color Tokens
 * Additional colors not in Tailwind's default palette
 */
export const customColors = {
  /** Lemon yellow - #FFF44F */
  lemonYellow: {
    light: '#FFF44F',
    dark: '#B8A837', // Darker variant for dark mode
  },
  /** Canary yellow - #FFEF00 */
  canaryYellow: {
    light: '#FFEF00',
    dark: '#B8AA00', // Darker variant for dark mode
  },
} as const;

/**
 * Border Color Tokens
 * Centralized border colors for consistent styling across all components
 */
export const borderColors = {
  /**
   * UI Framework Borders (dark theme primary colors)
   * Used for structural UI elements like containers, inputs, modals, etc.
   */
  ui: {
    /** Primary border color - default for most UI elements (dark-700: #2a2a30) */
    default: 'border-dark-700',
    /** Secondary border color - for subtle divisions (dark-600: #3a3a42) */
    secondary: 'border-dark-600',
    /** Input border - brighter for visibility */
    input: 'border-dark-600',
    /** Darker border for emphasis */
    emphasis: 'border-dark-800',
    /** Disabled/dimmed border for inactive states */
    disabled: 'border-dark-700/30',
  },

  /**
   * Semantic Tool Category Borders
   * Each tool category has a light/dark pair for theme compatibility
   * Format: 'border-{color}-200 dark:border-{color}-800'
   */
  tool: {
    /** File operations (Write, Edit, Read) */
    file: 'border-blue-200 dark:border-blue-800',
    /** Search operations (Glob, Grep) */
    search: 'border-purple-200 dark:border-purple-800',
    /** Terminal operations (Bash, BashOutput) - brighter for visibility */
    terminal: 'border-gray-200 dark:border-gray-600',
    /** Agent/Task operations */
    agent: 'border-indigo-200 dark:border-indigo-800',
    /** Web operations (WebFetch, WebSearch) */
    web: 'border-green-200 dark:border-green-800',
    /** Todo operations */
    todo: 'border-amber-200 dark:border-amber-800',
    /** MCP operations */
    mcp: 'border-pink-200 dark:border-pink-800',
    /** System operations (Thinking, ExitPlanMode, etc.) */
    system: 'border-cyan-200 dark:border-cyan-800',
  },

  /**
   * Semantic State Borders
   * For status-based UI elements (success, error, warning, info)
   */
  semantic: {
    /** Success states (green) */
    success: 'border-green-200 dark:border-green-800',
    /** Error states (red) */
    error: 'border-red-200 dark:border-red-800',
    /** Warning states (amber/yellow) */
    warning: 'border-amber-200 dark:border-amber-800',
    /** Warning states - yellow variant */
    warningYellow: 'border-yellow-200 dark:border-yellow-800',
    /** Info states (blue) */
    info: 'border-blue-200 dark:border-blue-800',
    /** Default/neutral states */
    neutral: 'border-gray-200 dark:border-gray-700',
  },

  /**
   * Interactive State Borders
   * For hover, focus, active states
   */
  interactive: {
    /** Focus state - blue with opacity */
    focus: 'focus-within:border-blue-500/50',
    /** Hover state - lighter border */
    hover: 'hover:border-dark-600',
    /** Active/selected state */
    active: 'border-blue-500',
  },

  /**
   * Special Purpose Borders
   * For specific UI patterns (toasts, banners, highlights)
   */
  special: {
    /** Toast notifications - semi-transparent */
    toast: {
      success: 'border-green-500/20',
      error: 'border-red-500/20',
      warning: 'border-amber-500/20',
      info: 'border-blue-500/20',
    },
    /** Session/message indicators */
    indicator: {
      purple: 'border-purple-200 dark:border-purple-800',
      indigo: 'border-indigo-200 dark:border-indigo-800',
    },
  },
} as const;

/**
 * Unified design token object.
 * Groups all tokens under a single namespace for structured access.
 * All existing named exports remain available for backwards compatibility.
 */
export const tokens = {
  color: {
    accent: 'bg-indigo-500' as const,
    surface: {
      app: 'bg-dark-950' as const,
      panel: 'bg-dark-900' as const,
      card: 'bg-dark-800' as const,
    },
    text: {
      primary: 'text-gray-100' as const,
      secondary: 'text-gray-400' as const,
      muted: 'text-gray-500' as const,
    },
    border: {
      default: borderColors.ui.default,
      subtle: borderColors.ui.secondary,
    },
    status: {
      success: 'text-green-400' as const,
      warning: 'text-amber-400' as const,
      error: 'text-red-400' as const,
      info: 'text-indigo-400' as const,
    },
  },
  spacing: {
    chatMaxWidth: 'max-w-4xl' as const,
  },
  radius: {
    ...borderRadius,
    panel: 'rounded-xl' as const,
  },
  transition: {
    quick: 'transition-all duration-150 ease-out' as const,
    smooth: 'transition-all duration-250 ease-out' as const,
  },
} as const;

export default tokens;
