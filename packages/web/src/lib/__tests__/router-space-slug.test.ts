import { beforeEach, describe, test, expect } from 'vitest';
import {
  getSpaceIdFromPath,
  getSpaceSessionIdFromPath,
  getSpaceTaskIdFromPath,
  createSpacePath,
  createSpaceSessionPath,
  createSpaceTaskPath,
  getSpaceAgentDetailFromPath,
  initializeRouter,
} from '../router';
import { currentSpaceAgentHandleSignal } from '../signals';

function setPath(path: string) {
  const url = new URL(path, 'https://hyperneo.test');
  Object.defineProperty(window, 'location', {
    value: { pathname: url.pathname, search: url.search },
    configurable: true,
  });
}

beforeEach(() => {
  currentSpaceAgentHandleSignal.value = null;
  setPath('/');
});

describe('getSpaceIdFromPath — slug support', () => {
  test('matches UUID-based space route', () => {
    expect(getSpaceIdFromPath('/space/04062505-780f-4881-a3be-9cb9062790fb')).toBe(
      '04062505-780f-4881-a3be-9cb9062790fb'
    );
  });

  test('matches slug-based space route', () => {
    expect(getSpaceIdFromPath('/space/hyperneo-dev')).toBe('hyperneo-dev');
  });

  test('matches single word slug', () => {
    expect(getSpaceIdFromPath('/space/myproject')).toBe('myproject');
  });

  test('matches slug with numbers', () => {
    expect(getSpaceIdFromPath('/space/project-42')).toBe('project-42');
  });

  test('does not match invalid paths', () => {
    expect(getSpaceIdFromPath('/space/')).toBeNull();
    expect(getSpaceIdFromPath('/spaces')).toBeNull();
    expect(getSpaceIdFromPath('/')).toBeNull();
  });

  test('does not match slug with uppercase (slugs are lowercase)', () => {
    expect(getSpaceIdFromPath('/space/MyProject')).toBeNull();
  });
});

describe('getSpaceSessionIdFromPath — slug support', () => {
  test('matches slug-based space session route', () => {
    const result = getSpaceSessionIdFromPath(
      '/space/hyperneo-dev/session/04062505-780f-4881-a3be-9cb9062790fb'
    );
    expect(result).toEqual({
      spaceId: 'hyperneo-dev',
      sessionId: '04062505-780f-4881-a3be-9cb9062790fb',
    });
  });

  test('matches UUID-based space session route', () => {
    const result = getSpaceSessionIdFromPath(
      '/space/04062505-780f-4881-a3be-9cb9062790fb/session/14062505-780f-4881-a3be-9cb9062790fb'
    );
    expect(result).toEqual({
      spaceId: '04062505-780f-4881-a3be-9cb9062790fb',
      sessionId: '14062505-780f-4881-a3be-9cb9062790fb',
    });
  });

  test('matches coordinator session ids with colons', () => {
    const result = getSpaceSessionIdFromPath(
      '/space/hyperneo-dev/session/space:chat:b90171e4-1111-2222-3333-444444444444'
    );
    expect(result).toEqual({
      spaceId: 'hyperneo-dev',
      sessionId: 'space:chat:b90171e4-1111-2222-3333-444444444444',
    });
  });
});

describe('getSpaceTaskIdFromPath — slug support', () => {
  test('matches slug-based space task route with UUID task', () => {
    const result = getSpaceTaskIdFromPath(
      '/space/hyperneo-dev/task/04062505-780f-4881-a3be-9cb9062790fb'
    );
    expect(result).toEqual({
      spaceId: 'hyperneo-dev',
      taskId: '04062505-780f-4881-a3be-9cb9062790fb',
    });
  });

  test('matches slug-based space task route with short ID', () => {
    const result = getSpaceTaskIdFromPath('/space/hyperneo-dev/task/t-42');
    expect(result).toEqual({
      spaceId: 'hyperneo-dev',
      taskId: 't-42',
    });
  });
});

describe('createSpacePath — works with slugs', () => {
  test('creates path with slug', () => {
    expect(createSpacePath('hyperneo-dev')).toBe('/space/hyperneo-dev');
  });

  test('creates path with UUID', () => {
    expect(createSpacePath('04062505-780f-4881-a3be-9cb9062790fb')).toBe(
      '/space/04062505-780f-4881-a3be-9cb9062790fb'
    );
  });
});

describe('createSpaceSessionPath — works with slugs', () => {
  test('creates path with slug', () => {
    expect(createSpaceSessionPath('hyperneo-dev', 'sess-123')).toBe(
      '/space/hyperneo-dev/session/sess-123'
    );
  });
});

describe('createSpaceTaskPath — works with slugs', () => {
  test('creates path with slug', () => {
    expect(createSpaceTaskPath('hyperneo-dev', 'task-456')).toBe(
      '/space/hyperneo-dev/task/task-456'
    );
  });
});

describe('getSpaceAgentDetailFromPath — slug and handle support', () => {
  test('matches agent detail route', () => {
    expect(getSpaceAgentDetailFromPath('/space/hyperneo-dev/agent/reviewer')).toEqual({
      spaceId: 'hyperneo-dev',
      handle: 'reviewer',
    });
  });

  test('initializes agent detail handle route state', () => {
    setPath('/space/hyperneo-dev/agent/reviewer');

    initializeRouter();

    expect(currentSpaceAgentHandleSignal.value).toBe('reviewer');
  });
});
