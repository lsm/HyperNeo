import { spawnProcess } from '../../runtime-spawn/index.ts';

export async function homeGitEnvironment(
  cwd: string,
  inherited: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const env = Object.fromEntries(
    Object.entries(inherited).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const child = spawnProcess(
    [
      'git',
      'config',
      '--null',
      '--name-only',
      '--get-regexp',
      '^filter\\..*\\.(clean|smudge|process|required)$',
    ],
    { cwd, env, stdout: 'pipe', stderr: 'pipe' }
  );
  const [keys, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && code !== 1) throw new Error(`home Git filter configuration: ${error.trim()}`);
  const filters = [...new Set(keys.split('\0').filter(Boolean))];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  return {
    ...env,
    GIT_CONFIG_COUNT: String(count + filters.length),
    ...Object.fromEntries(
      filters.flatMap((key, index) => [
        [`GIT_CONFIG_KEY_${count + index}`, key],
        [`GIT_CONFIG_VALUE_${count + index}`, key.endsWith('.required') ? 'false' : ''],
      ])
    ),
  };
}
