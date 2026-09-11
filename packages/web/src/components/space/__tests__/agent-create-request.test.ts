import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentCreateRequest,
  decideAgentCreateRequest,
  requestAgentFromTemplate,
  takeAgentCreateRequest,
} from '../agent-create-request';

describe('agent create request', () => {
  beforeEach(() => {
    agentCreateRequest.value = null;
  });

  describe('decideAgentCreateRequest', () => {
    it('takes a request raised for this Space', () => {
      expect(
        decideAgentCreateRequest({ spaceId: 'space-1', templateKey: 'researcher.v1' }, 'space-1')
      ).toEqual({ kind: 'take', templateKey: 'researcher.v1' });
    });

    it('skips when nothing was raised', () => {
      expect(decideAgentCreateRequest(null, 'space-1')).toEqual({
        kind: 'skip',
        reason: 'no-request',
      });
    });

    it('skips a request raised for another Space', () => {
      expect(
        decideAgentCreateRequest({ spaceId: 'space-2', templateKey: 'researcher.v1' }, 'space-1')
      ).toEqual({ kind: 'skip', reason: 'other-space' });
    });
  });

  it('hands the template key to the Space it was raised for', () => {
    requestAgentFromTemplate('space-1', 'researcher.v1');

    expect(takeAgentCreateRequest('space-1')).toBe('researcher.v1');
  });

  it('clears the request once taken so it cannot reopen later', () => {
    requestAgentFromTemplate('space-1', 'researcher.v1');

    takeAgentCreateRequest('space-1');

    expect(agentCreateRequest.value).toBeNull();
    expect(takeAgentCreateRequest('space-1')).toBeNull();
  });

  it('withholds a request raised for another Space', () => {
    requestAgentFromTemplate('space-2', 'researcher.v1');

    expect(takeAgentCreateRequest('space-1')).toBeNull();
  });

  it('leaves another Space request pending rather than consuming it', () => {
    requestAgentFromTemplate('space-2', 'researcher.v1');

    takeAgentCreateRequest('space-1');

    expect(agentCreateRequest.value).toMatchObject({ spaceId: 'space-2' });
  });

  it('returns null when nothing was requested', () => {
    expect(takeAgentCreateRequest('space-1')).toBeNull();
  });
});
