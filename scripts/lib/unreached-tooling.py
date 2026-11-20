"""Print the changed tooling files (scripts/, .claude/) that no test leg reaches.

The CI path filter reads a PR's changed paths (NUL-separated) on stdin. A
tooling file is reached when a tracked file under packages/ or the CI workflow
names it by path, or when a reached file names or imports it. Changed files
outside the tooling roots are never printed. Run from the repository root.
"""

import os
import re
import subprocess
import sys

ROOTS = ("scripts/", ".claude/")
NAMED = re.compile(r"(?<![A-Za-z0-9_~])(?:scripts|\.claude)/[A-Za-z0-9_./-]+")
RELATIVE = re.compile(r"""(?:from|import|require\(|source|\.)\s*\(?\s*['"](\.{1,2}/[A-Za-z0-9_./-]+)['"]""")


def tracked(*paths):
    out = subprocess.run(["git", "ls-files", "-z", "--", *paths], check=True, capture_output=True).stdout
    return [p for p in out.decode().split("\0") if p]


def read(path):
    try:
        with open(path, encoding="utf-8", errors="ignore") as handle:
            return handle.read()
    except OSError:
        return ""


def resolve(path, existing):
    path = os.path.normpath(path.rstrip("."))
    for candidate in (path, path + ".ts", path + ".sh", path + "/index.ts"):
        if candidate in existing:
            return candidate
    return None


def reached():
    existing = set(tracked(*ROOTS))
    queue = tracked("packages", ".github/workflows/main.yml")
    seen = set()
    while queue:
        current = queue.pop()
        text = read(current)
        refs = NAMED.findall(text)
        if current.startswith(ROOTS):
            refs += [os.path.join(os.path.dirname(current), ref) for ref in RELATIVE.findall(text)]
        for ref in refs:
            target = resolve(ref, existing)
            if target and target not in seen:
                seen.add(target)
                queue.append(target)
    return seen


def main():
    changed = [p for p in sys.stdin.buffer.read().decode().split("\0") if p.startswith(ROOTS)]
    if not changed:
        return
    used = reached()
    for path in changed:
        if path not in used:
            print(path)


main()
