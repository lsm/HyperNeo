import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const scriptPath = join(import.meta.dir, 'check-test-quality.ts');

function runAudit(cwd: string) {
  return spawnSync('bun', [scriptPath], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

function writeTestFile(cwd: string, relPath: string, contents: string) {
  const fullPath = join(cwd, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

describe('check-test-quality', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('passes on a clean test file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/daemon/tests/unit/my-module.test.ts',
      `import { describe, it, expect } from 'bun:test';
import { myFunction } from '../src/my-module';

describe('myFunction', () => {
  it('should work', () => {
    expect(myFunction()).toBe(42);
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('Test-quality audit passed.');
  });

  it('flags dead mock assertions when test title references mocked component', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/web/src/components/MyComponent.test.tsx',
      `import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { MyComponent } from './MyComponent';

vi.mock('./MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

describe('MyComponent', () => {
  it('should render markdown via MarkdownRenderer', () => {
    const { container } = render(<MyComponent content="# Hello" />);
    expect(container.textContent).toContain('Hello');
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('dead');
    expect(result.stderr).toContain('MarkdownRenderer');
  });

  it('does not flag dead mock when test queries the mock output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/web/src/components/MyComponent.test.tsx',
      `import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { MyComponent } from './MyComponent';

vi.mock('./MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

describe('MyComponent', () => {
  it('should render markdown via MarkdownRenderer', () => {
    const { container } = render(<MyComponent content="# Hello" />);
    const md = container.querySelector('[data-testid="md"]');
    expect(md).toBeTruthy();
    expect(md?.textContent).toContain('Hello');
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(0);
  });

  it('flags describe-scope mismatches in daemon .test.ts files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/daemon/tests/unit/my-module.test.ts',
      `import { describe, it, expect } from 'bun:test';
import { functionA, functionB } from '../src/my-module';

describe('functionA', () => {
  it('should do something', () => {
    expect(functionB()).toBe(42);
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("describe('functionA')");
    expect(result.stderr).toContain('functionB');
  });

  it('skips describe-scope check for .test.tsx files', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/web/src/components/MyComponent.test.tsx',
      `import { describe, it, expect } from 'vitest';
import { functionA, functionB } from './my-module';

describe('functionA', () => {
  it('should do something', () => {
    expect(functionB()).toBe(42);
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(0);
  });

  it('skips describe-scope check for hook tests using renderHook', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'test-quality-'));
    dirs.push(cwd);

    writeTestFile(
      cwd,
      'packages/web/src/hooks/useMyHook.test.ts',
      `import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/preact';
import { useMyHook } from './useMyHook';

describe('open', () => {
  it('should open', () => {
    const { result } = renderHook(() => useMyHook());
    expect(result.current.isOpen).toBe(false);
  });
});
`
    );

    const result = runAudit(cwd);
    expect(result.status).toBe(0);
  });
});
