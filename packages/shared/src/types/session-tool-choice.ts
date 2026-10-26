export type SessionToolProfile = 'worker' | 'neo' | 'manual';

export type SessionToolChoiceKey = `skill:${string}` | `mcp:${string}`;

export interface SessionToolChoice {
  selected: boolean;
  aliases?: string[];
}

export interface SessionToolSelection {
  version: 1;
  choices: Partial<Record<SessionToolChoiceKey, SessionToolChoice>>;
}

export interface ResolvedSessionToolChoice {
  key: SessionToolChoiceKey;
  selected: boolean;
  aliases: string[];
  reason:
    | 'selected'
    | 'off'
    | 'missing-definition'
    | 'ambiguous-alias'
    | 'space-required'
    | 'policy-denied';
}

export interface SessionToolApplication {
  application: 'live' | 'next_query' | 'restart_required' | 'unverified';
  reason?: string;
}
