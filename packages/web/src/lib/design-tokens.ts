import { INDICATOR_TONES } from './indicator-tokens';

export const messageSpacing = {
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

  actions: {
    marginTop: 'mt-2',
    gap: 'gap-2',
    padding: 'px-1',
  },
} as const;

export const borderRadius = {
  message: {
    bubble: 'rounded-[20px]',
    tool: 'rounded-lg',
  },
} as const;

export const messageColors = {
  user: {
    background: 'bg-blue-500',
    text: 'text-white',
  },
  assistant: {
    background: 'bg-dark-800',
    text: 'text-white',
  },
} as const;

export const customColors = {
  lemonYellow: {
    light: '#FFF44F',
    dark: '#B8A837',
  },
  canaryYellow: {
    light: '#FFEF00',
    dark: '#B8AA00',
  },
} as const;

export const borderColors = {
  ui: {
    default: 'border-dark-700',
    secondary: 'border-dark-600',
    input: 'border-dark-600',
    emphasis: 'border-dark-800',
    disabled: 'border-dark-700/30',
  },

  tool: {
    file: 'border-blue-200 dark:border-blue-800',
    search: 'border-purple-200 dark:border-purple-800',
    terminal: 'border-gray-200 dark:border-gray-600',
    agent: 'border-indigo-200 dark:border-indigo-800',
    web: 'border-green-200 dark:border-green-800',
    todo: 'border-amber-200 dark:border-amber-800',
    mcp: 'border-pink-200 dark:border-pink-800',
    system: 'border-cyan-200 dark:border-cyan-800',
  },

  semantic: {
    success: 'border-green-200 dark:border-green-800',
    error: 'border-red-200 dark:border-red-800',
    warning: 'border-amber-200 dark:border-amber-800',
    warningYellow: 'border-yellow-200 dark:border-yellow-800',
    info: 'border-blue-200 dark:border-blue-800',
    neutral: 'border-gray-200 dark:border-gray-700',
  },

  interactive: {
    focus: 'focus-within:border-blue-500/50',
    hover: 'hover:border-dark-600',
    active: 'border-blue-500',
  },

  special: {
    toast: {
      success: 'border-green-500/20',
      error: 'border-red-500/20',
      warning: 'border-amber-500/20',
      info: 'border-blue-500/20',
    },
    indicator: {
      purple: 'border-purple-200 dark:border-purple-800',
      indigo: 'border-indigo-200 dark:border-indigo-800',
    },
  },
} as const;

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
    indicator: INDICATOR_TONES,
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
