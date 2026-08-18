import type { Session } from '@hyperneo/shared';

const USER_SESSION_TYPES = new Set<string | undefined>(['worker', undefined]);

export function isUserSession(session: Session): boolean {
  return (
    USER_SESSION_TYPES.has(session.type) && !session.context?.roomId && !session.context?.spaceId
  );
}

export function getModelLabel(modelId: string | null | undefined): string {
  if (!modelId) return '';
  const lower = modelId.toLowerCase();

  if (lower.startsWith('claude-')) {
    const rest = modelId.slice('claude-'.length);
    const withoutDate = rest.replace(/-\d{8}$/, '');
    const parts = withoutDate.split('-');
    if (parts.length >= 2) {
      const family = parts[0]!;
      const number = parts[1]!;
      return `${family.charAt(0).toUpperCase() + family.slice(1)} ${number}`;
    }
    return rest.charAt(0).toUpperCase() + rest.slice(1);
  }

  if (lower.startsWith('glm-')) {
    const rest = modelId.slice('glm-'.length);
    const parts = rest.split('-');
    if (parts.length >= 2) {
      const family = parts[0]!;
      const suffix = parts.slice(1).join(' ');
      return `GLM ${family.charAt(0).toUpperCase() + family.slice(1)}${suffix ? ' ' + suffix : ''}`;
    }
    return `GLM ${rest.charAt(0).toUpperCase() + rest.slice(1)}`;
  }

  if (lower.startsWith('kimi-')) {
    if (lower === 'kimi-k3') return 'Kimi K3';
    if (lower === 'kimi-k2.7-code') return 'Kimi K2.7 Code';
    if (lower === 'kimi-k2.7-code-highspeed') return 'Kimi K2.7 Code Highspeed';
    const rest = modelId.slice('kimi-'.length).replace(/-/g, ' ');
    return `Kimi ${rest}`;
  }

  if (lower.startsWith('moonshot-')) {
    const rest = modelId.slice('moonshot-'.length).replace(/-/g, ' ');
    return `Moonshot ${rest}`;
  }

  return modelId.replace(/-/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
