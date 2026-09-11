import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentCreateRequest,
  requestAgentFromTemplate,
  takeAgentCreateRequest,
} from '../agent-create-request';

describe('agent create request', () => {
  beforeEach(() => {
    agentCreateRequest.value = null;
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
