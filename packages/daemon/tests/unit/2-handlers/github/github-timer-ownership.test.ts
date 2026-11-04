import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('GitHub public timer ownership guard', () => {
  test('all public timer callbacks await the reader without a retained synchronous escape', () => {
    const result = JSON.parse(
      execFileSync(process.execPath, ['.claude/skills/verify/lane-c-github-timer-ownership.cjs'], {
        cwd: fileURLToPath(new URL('../../../../../../', import.meta.url)),
        encoding: 'utf8',
      })
    );
    expect(result).toMatchObject({
      callbacks: [
        'space.github.watchRepo',
        'space.github.unwatchRepo',
        'space.github.setPollingEnabled',
      ],
      retiredReferences: 0,
    });
  });
});
