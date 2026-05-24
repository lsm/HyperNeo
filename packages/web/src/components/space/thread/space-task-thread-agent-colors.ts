const KNOWN_AGENT_COLORS: Record<string, string> = {
  'task agent': '#66A7FF',
  'plan agent': '#AD8BFF',
  'coder agent': '#42C7B5',
  'reviewer agent': '#F2C66D',
  'space agent': '#73C7FF',
  'workflow agent': '#E794FF',
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

export function getAgentColor(label: string): string {
  const normalized = normalizeAgentLabel(label ?? '');
  return KNOWN_AGENT_COLORS[normalized] ?? fallbackColor(normalized || 'agent');
}
