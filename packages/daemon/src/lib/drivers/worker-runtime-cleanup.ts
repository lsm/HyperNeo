import { realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const SCRIPT = `
gone() { [ ! -e "$1" ] && [ ! -L "$1" ]; }
repair() {
  [ ! -L "$1" ] || return 0
  [ -d "$1" ] || return 0
  if [ "$2" = darwin ]; then
    /usr/bin/chflags -h nouchg,nouappnd "$1" || gone "$1" || return 1
  fi
  /bin/chmod 700 "$1" || gone "$1" || return 1
  for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    repair "$child" "$2" || return 1
  done
}
repair "$1" "$2" || exit 1
if [ "$2" = darwin ]; then
  /usr/bin/chflags -RP nouchg,nouappnd "$1" || :
fi
for child in "$1"/* "$1"/.[!.]* "$1"/..?*; do
  /bin/rm -rf -- "$child" || exit 1
done
`;

export async function workerRuntimeCleanupCommand(runtime: string) {
  const target = join(await realpath(dirname(runtime)), basename(runtime));
  const shell = ['/bin/sh', '-c', SCRIPT, 'worker-runtime-cleanup', target, process.platform];
  if (process.platform === 'darwin')
    return [
      '/usr/bin/sandbox-exec',
      '-p',
      `(version 1)(deny default)(allow file-read* process* sysctl-read)(allow file-write* (subpath ${JSON.stringify(target)}))`,
      ...shell,
    ];
  if (process.platform !== 'linux') throw new Error('Worker cleanup sandbox is unavailable.');
  return [
    '/usr/bin/bwrap',
    '--die-with-parent',
    '--ro-bind',
    '/',
    '/',
    '--bind',
    target,
    target,
    '--',
    ...shell,
  ];
}
