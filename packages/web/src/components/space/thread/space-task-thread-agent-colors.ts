import { resolvedTheme } from '../../../lib/theme';

const KNOWN_AGENT_COLORS: Record<string, string> = {
  'task agent': '#66A7FF',
  'plan agent': '#AD8BFF',
  'coder agent': '#42C7B5',
  'reviewer agent': '#F2C66D',
  'space agent': '#73C7FF',
  'workflow agent': '#E794FF',
};

const KNOWN_AGENT_TEXT_COLORS: Record<string, string> = {
  'task agent': '#1d4ed8',
  'plan agent': '#7c3aed',
  'coder agent': '#0f766e',
  'reviewer agent': '#b45309',
  'space agent': '#0369a1',
  'workflow agent': '#c026d3',
};

function normalizeAgentLabel(label: string): string {
  return label.trim().toLowerCase();
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function fallbackColor(label: string): string {
  const hue = hashString(label) % 360;
  return `hsl(${hue} 70% 62%)`;
}

function fallbackTextColor(label: string): string {
  const hue = hashString(label) % 360;
  return `hsl(${hue} 55% 38%)`;
}

export function getAgentColor(label: string): string {
  const normalized = normalizeAgentLabel(label ?? '');
  return KNOWN_AGENT_COLORS[normalized] ?? fallbackColor(normalized || 'agent');
}

export function getAgentTextColor(label: string): string {
  const normalized = normalizeAgentLabel(label ?? '');
  const light = resolvedTheme.value === 'light';
  const palette = light ? KNOWN_AGENT_TEXT_COLORS : KNOWN_AGENT_COLORS;
  const fallback = light ? fallbackTextColor : fallbackColor;
  return palette[normalized] ?? fallback(normalized || 'agent');
}
