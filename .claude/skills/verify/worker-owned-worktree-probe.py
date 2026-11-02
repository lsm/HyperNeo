import json
import os
import subprocess
import sys
from pathlib import Path

run = Path(sys.argv[1])
tag = sys.argv[2]
config = json.loads((run / 'proof-config.json').read_text())
cwd = Path.cwd().resolve()
assert cwd.is_relative_to(Path(config['workers']).resolve()), cwd
assert cwd != Path(config['source']).resolve()


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


before = git('branch', '--show-current')
assert git('status', '--porcelain') == ''
git('fetch', 'origin')
if tag in ['todo-one', 'todo-two', 'review-warmup']:
    if tag == 'todo-two':
        assert before == 'proof-todo-one', before
    git('switch', '-c', 'proof-' + tag, 'origin/dev')
elif tag == 'review':
    assert before == 'proof-review-warmup', before
    git('fetch', 'origin', '+refs/pull/7/head:refs/remotes/origin/pull/7/head')
    git('checkout', '--detach', config['prHead'])
else:
    raise AssertionError(tag)

head = git('rev-parse', 'HEAD')
expected = config['prHead'] if tag == 'review' else git('rev-parse', 'origin/dev')
assert head == expected, (head, expected)
assert (cwd / '.claude/skills/verify/SKILL.md').is_file()
observed = {
    'tag': tag, 'cwd': str(cwd), 'beforeBranch': before,
    'branch': git('branch', '--show-current'), 'head': head,
    'commonDirectory': git('rev-parse', '--path-format=absolute', '--git-common-dir'),
    'status': git('status', '--porcelain'),
    'verdict': 'PASS at exact head ' + head if tag == 'review' else None,
}
(run / 'evidence' / (tag + '.json')).write_text(json.dumps(observed, indent=2))
print(json.dumps(observed))
