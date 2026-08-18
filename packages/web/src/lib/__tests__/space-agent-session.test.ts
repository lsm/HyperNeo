import { describe, it, expect } from 'vitest';
import {
  isCoordinatorSessionId,
  isLongHorizonAgentSessionId,
  parseLongHorizonAgentSessionId,
} from '../space-agent-session';

const SPACE_ID = 'b90171e4-a9c2-4ac2-8de9-143e5c1fea65';

describe('isCoordinatorSessionId', () => {
  it('matches the per-space coordinator id', () => {
    expect(isCoordinatorSessionId(SPACE_ID, `space:chat:${SPACE_ID}`)).toBe(true);
  });

  it('rejects a long-horizon agent id and a foreign coordinator id', () => {
    expect(isCoordinatorSessionId(SPACE_ID, `space:agent:${SPACE_ID}:agent-1`)).toBe(false);
    expect(isCoordinatorSessionId(SPACE_ID, 'space:chat:another-space')).toBe(false);
    expect(isCoordinatorSessionId(SPACE_ID, null)).toBe(false);
  });
});

describe('isLongHorizonAgentSessionId', () => {
  it('recognizes the space:agent: prefix', () => {
    expect(isLongHorizonAgentSessionId(`space:agent:${SPACE_ID}:agent-1`)).toBe(true);
    expect(isLongHorizonAgentSessionId(`space:chat:${SPACE_ID}`)).toBe(false);
    expect(isLongHorizonAgentSessionId(null)).toBe(false);
  });
});

describe('parseLongHorizonAgentSessionId', () => {
  it('decodes spaceId + agentId components', () => {
    const id = `space:agent:${encodeURIComponent(SPACE_ID)}:${encodeURIComponent('coder')}`;
    const parsed = parseLongHorizonAgentSessionId(id);
    expect(parsed).toEqual({ spaceId: SPACE_ID, agentId: 'coder' });
  });

  it('decodes agentIds that contain reserved characters', () => {
    const id = `space:agent:${encodeURIComponent(SPACE_ID)}:${encodeURIComponent('a/b:c d')}`;
    const parsed = parseLongHorizonAgentSessionId(id);
    expect(parsed?.agentId).toBe('a/b:c d');
  });

  it('returns null for a coordinator id, a plain session, or malformed input', () => {
    expect(parseLongHorizonAgentSessionId(`space:chat:${SPACE_ID}`)).toBeNull();
    expect(parseLongHorizonAgentSessionId('01234567-89ab-cdef')).toBeNull();
    expect(parseLongHorizonAgentSessionId('space:agent:only-one')).toBeNull();
    expect(parseLongHorizonAgentSessionId(null)).toBeNull();
  });
});
