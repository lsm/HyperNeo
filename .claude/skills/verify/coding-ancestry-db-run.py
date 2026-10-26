import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('runtime', choices=['bun', 'deno'])
parser.add_argument('mode', choices=['before', 'verify'])
parser.add_argument('--executable')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[3]
subprocess.run(['df', '-h', '/System/Volumes/Data'], check=True)
free = shutil.disk_usage('/System/Volumes/Data').free
if free < 25 * 1024**3:
    sys.exit('STOP: under 25 GiB free; notify Neo before another heavy run')
exe = args.executable or shutil.which(args.runtime)
if not exe or not Path(exe).is_file():
    sys.exit('Existing runtime unavailable; no install will be attempted')
base = repo / '.claude/skills/verify/evidence/coding-ancestry-db'
base.mkdir(parents=True, exist_ok=True)
name = f'{args.runtime}-{args.mode}'
saved = base / name
attempt = 1
while saved.exists():
    saved = base / f'{name}-{attempt}'
    attempt += 1
saved.mkdir()
run = Path(tempfile.mkdtemp(prefix='coding-ancestry-proof-', dir='/private/tmp'))
originals = {}
baseline = None
result = None
try:
    for folder in ['home', 'tmp']:
        (run / folder).mkdir()
    if args.mode == 'before':
        baseline = subprocess.check_output(['git', 'rev-parse', 'origin/dev'], cwd=repo, text=True).strip()
        for name in ['ancestry-facts.ts']:
            rel = f'packages/daemon/src/lib/neo/packs/coding/{name}'
            path = repo / rel
            originals[path] = path.read_bytes()
            path.write_bytes(subprocess.check_output(['git', 'show', f'{baseline}:{rel}'], cwd=repo))
    env = {'PATH': os.environ['PATH'], 'HOME': str(run / 'home'),
           'TMPDIR': str(run / 'tmp'), 'NODE_ENV': 'test',
           'HYPERNEO_DATA_DIR': str(run / 'data'), 'LOG_LEVEL': 'error'}
    helper = str(repo / '.claude/skills/verify/coding-ancestry-db.ts')
    if args.runtime == 'bun':
        command = [exe, '--no-install', '--no-env-file', helper, args.mode, str(run)]
        cwd = repo
    else:
        env['DENO_DIR'] = str(Path.home() / 'Library/Caches/deno')
        command = [exe, 'run', '--cached-only', '-A', helper, args.mode, str(run)]
        cwd = repo / 'packages/daemon'
    with (run / 'proof.log').open('w') as output:
        result = subprocess.run(command, cwd=cwd, env=env, stdout=output, stderr=subprocess.STDOUT)
finally:
    for path, content in originals.items():
        path.write_bytes(content)
    if (run / 'evidence').is_dir():
        shutil.copytree(run / 'evidence', saved, dirs_exist_ok=True)
    if (run / 'proof.log').is_file():
        shutil.copy2(run / 'proof.log', saved / 'proof.log')
    (saved / 'run.json').write_text(json.dumps({
        'runtime': args.runtime, 'mode': args.mode,
        'exitCode': result.returncode if result else None,
        'baselineFilesFrom': baseline,
        'head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=repo, text=True).strip(),
        'temporaryDaemonDataRemoved': True,
        'freeGiBBefore': free / 1024**3,
    }, indent=2) + '\n')
    shutil.rmtree(run)
print(json.dumps({'saved': str(saved), 'exitCode': result.returncode if result else None,
                  'temporaryDaemonDataRemoved': not run.exists()}))
if result:
    sys.exit(result.returncode)
sys.exit(1)
