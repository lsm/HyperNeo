import { execFileSync } from 'node:child_process';

export async function pairPage(page, port, run) {
  const code = execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'device.pair.create', JSON.stringify({ kind: 'human', name: 'Synthetic journey browser' })], {
    encoding: 'utf8',
    env: { ...process.env, VERIFY_PORT: String(port), HYPERNEO_DATA_DIR: `${run}/data` },
  }).match(/"code":\s*"([^"]+)"/)?.[1];
  if (!code) throw new Error('no pairing code');
  await page.goto(`http://127.0.0.1:${port}/pair#${code}`);
  await page.getByRole('button', { name: 'Pair this browser' }).click();
  await page.getByText('This browser is paired.').waitFor({ timeout: 10000 });
}
